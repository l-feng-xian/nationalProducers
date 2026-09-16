/**
 * 每帧共享的 TSL uniform。
 *
 * ## ⚠️ 为什么这些必须**一起**创建、一起传递
 * 曾经踩过的坑：地面材质接了 dayTint、水面材质忘了接，于是入夜后
 * 「地暗下去了，湖还惨白发亮」。
 *
 * 更隐蔽的是 noiseOrigin：补了的层和没补的层在同一帧里对不上，
 * 过接缝时会看到水面和云影**各自闪一下**，比整体都不补还刺眼。
 *
 * 所以这里导出的是**一整组**，各材质工厂只接受这一个对象 —— 想分开都分不开。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { uniform } from 'three/tsl'

/**
 * ⚠️ 类型由实现反推（`ReturnType`），不手写 `uniform<T>` 泛型。
 *
 * `@types/three@0.185.4` 里 `uniform` 的泛型参数约束是 `keyof UniformValue`
 * （即 'color' | 'float' | … 这样的**字符串字面量**），写 `uniform<THREE.Color>`
 * 通不过约束。而实装的 three 0.186 运行时完全支持直接传值。
 *
 * 与其为了过类型去 `as any`，不如让 TS 自己从实现里推 —— 类型和运行时都诚实，
 * 将来 @types 补齐了也不用改。
 */
export function createFrameUniforms() {
  return {
    /**
     * 昼夜整体染色。
     *
     * ⚠️ TSL 的 `colorNode` 会**完全绕开** `material.color` —— 只要材质设了
     * colorNode，改 material.color 一点效果都没有。所以昼夜必须靠这个 uniform
     * 显式乘进每个材质的颜色链路。
     */
    dayTint: uniform(new THREE.Color(1, 1, 1)),
    /** 阳光强度 0..1。云影与贴地投影按它淡出 */
    sunAmount: uniform(1),
    /**
     * 噪声原点补偿。
     *
     * 玩家从 x=511.99 走到 x=0.004 时，逻辑上只挪了 0.014 格，
     * **整幅画面的渲染世界坐标却同时减了 512**。几何上逐像素相同，
     * 但按渲染坐标取样的噪声（水波、风摆、云影）会在这一帧全部重掷 ——
     * 表现为「过接缝时水面和云影闪一下」，而那恰好是绕行一周必经的子午线。
     *
     * ⚠️ 只加在**噪声参数**上，绝不加进顶点位置：加进去就毁掉了
     * 「渲染坐标永远 ≤ ±768」这个精度前提。
     */
    noiseOrigin: uniform(new THREE.Vector2(0, 0)),
    /** 风的时间轴。与 clock 解耦，暂停时可以冻结 */
    windTime: uniform(0),
    /** 季节染色 */
    seasonTint: uniform(new THREE.Color(1, 1, 1)),
  }
}

export type FrameUniforms = ReturnType<typeof createFrameUniforms>

/**
 * 跨接缝时更新 noiseOrigin。
 *
 * @param rawDx 未回绕的位移（可能是 ±512 那种瞬移）
 * @param wrappedDx 回绕后的真实位移
 */
export function absorbSeamJump(
  u: FrameUniforms,
  rawDx: number,
  rawDy: number,
  wrappedDx: number,
  wrappedDy: number,
): void {
  u.noiseOrigin.value.x += wrappedDx - rawDx
  u.noiseOrigin.value.y += wrappedDy - rawDy
}
