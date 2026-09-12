/**
 * 环面（torus）噪声 —— 「球型无缝」的实现。
 *
 * ## 为什么是环面而不是球
 * 正方格铺不满球面（球面无法用规则四方格无畸变地铺满，必然有极点奇异）。
 * 而玩家的实际需求是「朝任意方向一直走都能绕回原点、且看不出接缝」——
 * 这正是**环面拓扑**：平面的左右边相接、上下边相接。显示上仍是平面，
 * 走动上却是闭合的，四个方向各绕一圈。
 *
 * ## 接缝怎么消掉
 * 关键不在贴图，而在**噪声本身必须在两个方向都是周期的**。
 * 做法是把平面坐标映射到 4D 空间里一个环面的表面，再采 4D simplex 噪声：
 *
 *   u = x / W,  v = y / H
 *   P = (cos2πu·r1, sin2πu·r1, cos2πv·r2, sin2πv·r2)
 *
 * `u=0` 与 `u=1` 映射到**同一个 4D 点**，所以 `sample(0,y)` 与 `sample(W,y)`
 * 在数学上就是同一个值，不需要任何边界缝合、羽化或镜像。
 *
 * 实测残差 ~1e-15（双精度 ulp 级，`cos(0)` 与 `cos(2π)` 并非 bit-identical），
 * 而生态阈值的间距在 0.03 量级 —— 差了十几个数量级，不可能翻转任何一格。
 * ⚠️ 但**偏移多圈**（如 x+3W）会因为三角函数的大幅角约减掉精度，实测约 2.6e-5。
 * 所以所有对外查询都必须先 `wrapX/wrapY` 回绕成 [0,W) 的整数再取样 ——
 * world.ts 就是这么做的，于是这条精度损失在实际路径上根本不会发生。
 *
 * 纯 service：不 import vue/pinia。
 */

import { createNoise4D } from 'simplex-noise'
import { seededRandom } from '@/services/hash'

/** 生态分类。数值即图块 id，渲染端按它查图集 */
export const BIOME = {
  water: 0,
  shallow: 1,
  sand: 2,
  grass: 3,
} as const

export type Biome = (typeof BIOME)[keyof typeof BIOME]

/** 能不能走上去。水不能，其余都能 */
export function isWalkable(b: Biome): boolean {
  return b !== BIOME.water
}

export interface WorldParams {
  /** 世界宽高，单位是格。必须是整数 */
  width: number
  height: number
  seed: number
  /**
   * 环面的两个半径。比值决定「同一圈里能塞下多少特征」——
   * 半径越大，绕一圈经过的噪声越多，地貌越碎。
   */
  r1?: number
  r2?: number
  /** 海平面。height 噪声低于它就是水 */
  seaLevel?: number
}

const DEFAULTS = {
  r1: 1.6,
  r2: 1.6,
  seaLevel: -0.08,
}

/** 分形叠加的层数与衰减。三层足够出「大陆 + 海湾 + 碎岛」的层次，再多只是白烧 CPU */
const OCTAVES = 3
const LACUNARITY = 2
const GAIN = 0.5

// ── 立体方块地形的量化参数 ──
/** 一级台阶的世界高度（格）。参考图里悬崖的「一格」就是这个厚度 */
export const BLOCK_H = 0.3
/** 高度噪声每升多少幅度抬一级台阶。0.09 × 上限 ~0.8 ≈ 最多 9 级梯田 */
const LEVEL_STEP = 0.09
/** 台阶等级上限。fBm 归一化后动态范围有限，封顶防止极个别尖塔 */
const MAX_LEVEL = 9
/** 深水海床的顶面高度。隔着半透明水面看到的就是它 */
export const WATER_BED_Y = -0.72
/** 浅滩海床：比水面略低，角色走上去是「蹚水」的效果 */
export const SHALLOW_BED_Y = -0.26
/** 水面高度。贴在沙滩顶（y=0）稍下方 */
export const WATER_SURFACE_Y = -0.08

export interface WorldSampler {
  readonly width: number
  readonly height: number
  /** 高度场，约 -1..1。> seaLevel 为陆地 */
  height01(x: number, y: number): number
  /** 湿度场，约 -1..1。决定陆地上是沙还是草 */
  moisture(x: number, y: number): number
  /**
   * 聚落场，约 -1..1。低频（环面半径缩到 0.28），出「文明大区 / 蛮荒大区」：
   * 村庄只会在聚落场高的大区里出现，于是世界天然分成有村镇的腹地与大片荒野。
   */
  district(x: number, y: number): number
  /**
   * 地表台阶等级（整数）：陆地 0..MAX_LEVEL，浅滩 -2、深水 -3。
   * 数值翻成世界高度是渲染层的事（见 world.heightAt）。
   */
  levelAt(x: number, y: number): number
  biomeAt(x: number, y: number): Biome
  /** 把任意整数格坐标回绕进 [0,width) × [0,height) */
  wrapX(x: number): number
  wrapY(y: number): number
}

/**
 * 建一个世界取样器。
 *
 * 两个噪声场用**不同的种子偏移**，否则高度与湿度完全相关，
 * 沙地只会出现在固定海拔上，看着像等高线而不是生态。
 */
export function createSampler(p: WorldParams): WorldSampler {
  const width = Math.max(1, Math.floor(p.width))
  const height = Math.max(1, Math.floor(p.height))
  const r1 = p.r1 ?? DEFAULTS.r1
  const r2 = p.r2 ?? DEFAULTS.r2
  const seaLevel = p.seaLevel ?? DEFAULTS.seaLevel

  const noiseH = createNoise4D(seededRandom(p.seed))
  // ^ 与 v 两个场必须用不同种子，见上面的说明
  const noiseM = createNoise4D(seededRandom(p.seed ^ 0x9e3779b9))
  // 聚落场：又一个独立种子。它只出「文明 / 蛮荒」的大区划分，别与湿度相关，
  // 否则村庄永远长在森林里（或永远长在沙漠边）
  const noiseD = createNoise4D(seededRandom(p.seed ^ 0x51ab3f1))

  const TAU = Math.PI * 2

  /**
   * 分形布朗运动，采样点落在 4D 环面上。
   *
   * ⚠️ 每一倍频都必须**整体缩放环面半径**，而不是缩放 u/v。
   * 缩放 u/v 会让高倍频的周期不再是 1，接缝立刻回来 —— 这是这套做法里
   * 最容易写错、而且只在世界边界处才看得出来的一点。
   *
   * `radiusScale` 整体缩放基础环面半径：<1 即降低频率（更大的地貌区块）。
   */
  const fbm = (
    noise: ReturnType<typeof createNoise4D>,
    x: number,
    y: number,
    radiusScale = 1,
    octaves = OCTAVES,
  ): number => {
    const u = (x / width) * TAU
    const v = (y / height) * TAU
    const cu = Math.cos(u)
    const su = Math.sin(u)
    const cv = Math.cos(v)
    const sv = Math.sin(v)
    const r1s = r1 * radiusScale
    const r2s = r2 * radiusScale

    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(cu * r1s * freq, su * r1s * freq, cv * r2s * freq, sv * r2s * freq)
      norm += amp
      amp *= GAIN
      freq *= LACUNARITY
    }
    return norm > 0 ? sum / norm : 0
  }

  const wrapX = (x: number): number => ((x % width) + width) % width
  const wrapY = (y: number): number => ((y % height) + height) % height

  const height01 = (x: number, y: number): number => fbm(noiseH, x, y)
  const moisture = (x: number, y: number): number => fbm(noiseM, x, y)
  const district = (x: number, y: number): number => fbm(noiseD, x, y, 0.28, 2)

  const biomeAt = (x: number, y: number): Biome => {
    const h = height01(x, y)
    if (h < seaLevel - 0.06) return BIOME.water
    // 浅滩：紧贴海平面的一条带，是水陆之间的过渡，可以蹚水走过去
    if (h < seaLevel + 0.03) return BIOME.shallow
    // 离岸不远且干燥 → 沙；其余是草
    const m = moisture(x, y)
    if (h < seaLevel + 0.14 && m < 0.12) return BIOME.sand
    return m < -0.42 ? BIOME.sand : BIOME.grass
  }

  /** 高度 → 台阶等级。浅滩 / 深水用负数标记，海床高度是常量而不是台阶 */
  const levelAt = (x: number, y: number): number => {
    const h = height01(x, y)
    if (h < seaLevel - 0.06) return -3
    if (h < seaLevel + 0.03) return -2
    return Math.min(MAX_LEVEL, Math.floor((h - seaLevel) / LEVEL_STEP))
  }

  return { width, height, height01, moisture, district, levelAt, biomeAt, wrapX, wrapY }
}
