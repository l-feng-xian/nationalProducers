/**
 * 地表混合场：把**离散**的地表覆盖模糊成一张**平滑**的 512² 场纹理。
 *
 * ## 为什么要它
 * 双网格逐格遮罩的柔化上限是**一格 = 56px**。参考图里草地→林地、陆地→湿地
 * 那种过渡是**横跨十几格**的有机斑块，逐格遮罩根本做不出来 —— 这就是
 * 「转折边缘过于生硬」的根因。
 *
 * 解法：自然面不走逐格遮罩，改走**世界空间软混合**。挂载时把
 * 「这格是不是林地/湿地」的 0/1 覆盖用**环面模糊**摊成 0..1 的平滑场，
 * 着色器按世界坐标采样这张场、用 `smoothstep` 在草地/林地/湿地贴图之间过渡。
 * 过渡宽度 = 模糊半径，天然跨多格；边界形状由底层的连续噪声场决定，天然有机。
 *
 * ## ⚠️ 模糊必须是环面的
 * 世界是 512×512 环面，x=511 的邻居是 x=0。模糊窗口在边缘必须回绕，
 * 否则接缝两侧的场值对不上，玩家绕一圈回到原点时会看到一条过渡断带。
 * 纹理本身也必须 `RepeatWrapping`。
 *
 * ## 通道布局（RGBA8）
 *   R = 林地度（ForestFloor 覆盖，模糊）
 *   G = 湿地度（Marsh 覆盖，模糊）
 *   B = 到岸的有符号距离，0.5 为水线，正侧是水，范围 ±SHORE_RANGE 格；不参与模糊
 *   A = 人造面度（Dirt/Cobble/Tilled 覆盖，模糊）—— 给草地做「贴着路的接触阴影」，
 *       让土路/城镇/耕地与草的过渡从硬边变成参考图那种柔和压深
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { WORLD_SIZE } from '../core/constants'
import { Surface, type WorldGrid } from '../generation/grid'
import { SHORE_RANGE, shoreDistance } from './shoreDistance'
import { buildContourPixels } from './contourField'
import { DIR8 } from '../core/torus'

/** 模糊半径（格）。~4 格半径 × 2 遍 ≈ 高斯 sigma 4，过渡宽约 8–10 格 */
const BLUR_RADIUS = 4
const BLUR_PASSES = 2

export interface GroundField {
  texture: THREE.DataTexture
  contours: THREE.DataTexture
  flow: THREE.DataTexture
  dispose(): void
}

export function buildGroundField(grid: WorldGrid): GroundField {
  const W = WORLD_SIZE
  const H = WORLD_SIZE
  const N = W * H

  // ── 离散覆盖 0/1 ──
  const forest = new Float32Array(N)
  const marsh = new Float32Array(N)
  const water = shoreDistance(grid.surface)
  const artificial = new Float32Array(N)
  const s = grid.surface
  for (let i = 0; i < N; i++) {
    const su = s[i]!
    if (su === Surface.ForestFloor) forest[i] = 1
    else if (su === Surface.Marsh) marsh[i] = 1
    if (su === Surface.Dirt || su === Surface.Cobble || su === Surface.Tilled) artificial[i] = 1
  }

  const tmp = new Float32Array(N)
  // 人造面用更小的模糊半径：接触阴影只该在路边一两格，不能糊出一大片
  for (const [ch, radius] of [
    [forest, BLUR_RADIUS],
    [marsh, BLUR_RADIUS],
    [artificial, 2],
  ] as const) {
    for (let p = 0; p < BLUR_PASSES; p++) {
      blurH(ch, tmp, W, H, radius)
      blurV(tmp, ch, W, H, radius)
    }
  }

  // ── 打进 RGBA8 ──
  const rgba = new Uint8Array(N * 4)
  for (let i = 0; i < N; i++) {
    rgba[i * 4] = clamp8(forest[i]! * 255)
    rgba[i * 4 + 1] = clamp8(marsh[i]! * 255)
    // B encodes signed shore distance; do not blur it with the biome weights.
    // Even a one-tile stream retains a water interior and an accurate shoreline.
    rgba[i * 4 + 2] = clamp8((0.5 + water[i]! / (2 * SHORE_RANGE)) * 255)
    rgba[i * 4 + 3] = clamp8(artificial[i]! * 255)
  }

  const tex = new THREE.DataTexture(rgba, W, H, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  // 这是**数据**不是颜色，不能走 sRGB 转换，否则场值被伽马曲线拉歪
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true

  const contour = buildContourPixels(grid)
  const contours = new THREE.DataTexture(contour.data, contour.size, contour.size, THREE.RGBAFormat)
  contours.wrapS = contours.wrapT = THREE.RepeatWrapping
  contours.magFilter = contours.minFilter = THREE.LinearFilter
  contours.generateMipmaps = false
  contours.colorSpace = THREE.NoColorSpace
  contours.needsUpdate = true
  const flowPixels = new Uint8Array(N * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      let dx = 0,
        dy = 0,
        weight = 0
      for (let oy = -2; oy <= 2; oy++)
        for (let ox = -2; ox <= 2; ox++) {
          const ni = ((y + oy + H) % H) * W + ((x + ox + W) % W)
          const direction = grid.flow?.[ni] ?? -1
          const vector = direction >= 0 ? DIR8[direction] : undefined
          if (!vector) continue
          const k = 1 / (1 + ox * ox + oy * oy)
          dx += vector[0] * k
          dy += vector[1] * k
          weight += k
        }
      const len = Math.hypot(dx, dy)
      const i = (y * W + x) * 4
      flowPixels[i] = clamp8((len > 0.01 ? dx / len : 0.12) * 127 + 128)
      flowPixels[i + 1] = clamp8((len > 0.01 ? dy / len : 0.99) * 127 + 128)
      flowPixels[i + 2] = weight > 0 ? 255 : 0
      flowPixels[i + 3] = 255
    }
  const flow = new THREE.DataTexture(flowPixels, W, H, THREE.RGBAFormat)
  flow.wrapS = flow.wrapT = THREE.RepeatWrapping
  flow.magFilter = flow.minFilter = THREE.LinearFilter
  flow.colorSpace = THREE.NoColorSpace
  flow.needsUpdate = true
  return {
    texture: tex,
    contours,
    flow,
    dispose: () => {
      tex.dispose()
      contours.dispose()
      flow.dispose()
    },
  }
}

/** 水平环面盒模糊。src → dst */
function blurH(src: Float32Array, dst: Float32Array, W: number, H: number, r: number): void {
  const norm = 1 / (2 * r + 1)
  for (let y = 0; y < H; y++) {
    const row = y * W
    for (let x = 0; x < W; x++) {
      let sum = 0
      for (let k = -r; k <= r; k++) {
        let xx = x + k
        if (xx < 0) xx += W
        else if (xx >= W) xx -= W
        sum += src[row + xx]!
      }
      dst[row + x] = sum * norm
    }
  }
}

/** 垂直环面盒模糊。src → dst */
function blurV(src: Float32Array, dst: Float32Array, W: number, H: number, r: number): void {
  const norm = 1 / (2 * r + 1)
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let sum = 0
      for (let k = -r; k <= r; k++) {
        let yy = y + k
        if (yy < 0) yy += H
        else if (yy >= H) yy -= H
        sum += src[yy * W + x]!
      }
      dst[y * W + x] = sum * norm
    }
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}
