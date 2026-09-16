/**
 * 环面（torus）噪声 —— 「无缝绕回原点」的实现。
 *
 * ## 原理
 * 把平面坐标映射到 4D 空间里一个环面的表面，再采 4D simplex 噪声：
 *
 *   u = 2π·x/W,  v = 2π·y/H
 *   P = (cos u·r1, sin u·r1, cos v·r2, sin v·r2)
 *
 * `u=0` 与 `u=2π` 映射到**同一个 4D 点**，所以 `sample(0,y)` 与 `sample(W,y)`
 * 在数学上就是同一个值 —— 不需要任何边界缝合、羽化或镜像。
 *
 * ## ⚠️ 倍频必须整体缩放环面半径，不能缩放 u/v
 *
 *   ✗ 错：noise(cos(u·f)·r1, sin(u·f)·r1, …)     ← 缩放角度
 *   ✓ 对：noise(cos(u)·r1·f, sin(u)·r1·f, …)     ← 缩放半径
 *
 * **这个错误是潜伏的**，实测数据（见 scripts/verify-noise.ts）：
 *
 *   | lacunarity | 缩放 u/v 的接缝残差 |
 *   |------------|--------------------|
 *   | 2（整数）   | 1.1e-15  ← 看不出问题 |
 *   | 3（整数）   | 1.9e-15  ← 看不出问题 |
 *   | **1.87**   | **2.3e-1** ← 接缝撕开 |
 *   | **2.13**   | **4.2e-1** ← 接缝撕开 |
 *
 * 原因：整数倍频下 `u·f` 在接缝处仍是 2π 的整数倍，恰好映射回同一点。
 * 所以用 lacunarity=2 写错了也看不出来 —— 直到有人为了打散网格感把它调成
 * 1.87（fBm 里很常见的做法），接缝当场撕开半个世界，而改动看起来毫不相干。
 *
 * 缩放半径则对**任意** lacunarity 都成立：绕一圈经过的弧长变长（= 更高频），
 * 但「u=0 与 u=2π 是同一点」这件事不依赖 f 是不是整数。
 *
 * ## 精度：实测值
 * - `radiusScale ≈ 1`、3 倍频：接缝残差 **1.9e-15**（双精度 ulp 级，
 *   因为 `sin(2π) = -2.4e-16` 而非 0）
 * - `radiusScale ≤ 0.3`：**4e-6**。X 方向仍是 1.7e-16，但 Y 方向会放大 ——
 *   小半径下整个世界挤进 4D 噪声的一个单元附近，踩到了 simplex 的单元排序翻转。
 *   原始 noise4D 本身无放大（输入差 9.8e-17 → 输出差 4.9e-17），是 fBm 尺度下的现象。
 * - 8 倍频（`r1·f` 达 200+）：**2.4e-8**，大坐标下三角函数精度下降。
 *
 * 这些都远低于生态阈值 0.03 的间距（最差 4e-6 也低 4 个数量级），翻不了任何一格。
 * 所以验证脚本的容差定在 **1e-4**：它要抓的是「接缝撕开」（0.2 量级）这种真实破坏，
 * 而不是追 ulp。
 *
 * ⚠️ **偏移多圈**（如 x+40W）会因三角函数大幅角约减掉精度（实测 1.9e-13）。
 * 所以所有对外查询都必须先回绕成 [0,W) —— fields.ts 的每个方法第一行都在做这件事。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { createNoise4D, type NoiseFunction4D } from 'simplex-noise'
import { WORLD_SIZE } from '../core/constants'

const TAU = Math.PI * 2

export interface FbmOptions {
  /** 倍频数。1 = 单层噪声 */
  octaves?: number
  /**
   * 环面半径的整体缩放。**决定特征尺度**：
   * 越大，绕一圈经过的噪声越多，地貌越碎。
   */
  radiusScale?: number
  /** 每倍频的频率倍数 */
  lacunarity?: number
  /** 每倍频的振幅衰减 */
  gain?: number
}

/** 环面的两个基准半径。比值影响东西/南北方向的特征各向异性 */
export const R1 = 1.6
export const R2 = 1.6

export type Field2D = (x: number, y: number) => number

/**
 * 造一个环面周期的 fBm 采样器。返回值大致在 [-1, 1]。
 *
 * @param noise  4D simplex 噪声实例（每个场一个独立种子）
 */
export function createTorusFbm(noise: NoiseFunction4D, opts: FbmOptions = {}): Field2D {
  const { octaves = 3, radiusScale = 1, lacunarity = 2, gain = 0.5 } = opts
  const r1 = R1 * radiusScale
  const r2 = R2 * radiusScale

  return (x: number, y: number): number => {
    // ⚠️ u/v 恒为 2π·x/W —— 永远不乘 freq。见文件头。
    const u = (x / WORLD_SIZE) * TAU
    const v = (y / WORLD_SIZE) * TAU
    const cu = Math.cos(u)
    const su = Math.sin(u)
    const cv = Math.cos(v)
    const sv = Math.sin(v)

    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      // 频率完全由「半径 × freq」承载
      sum += amp * noise(cu * r1 * freq, su * r1 * freq, cv * r2 * freq, sv * r2 * freq)
      norm += amp
      amp *= gain
      freq *= lacunarity
    }
    return norm > 0 ? sum / norm : 0
  }
}

/** 造一个独立种子的 4D 噪声实例 */
export function makeNoise4D(rand: () => number): NoiseFunction4D {
  return createNoise4D(rand)
}
