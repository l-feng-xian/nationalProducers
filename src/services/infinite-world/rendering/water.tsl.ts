/**
 * 水面材质：程序化 TSL，不用贴图。
 *
 * 双网格给出水体的**形状**（遮罩 alpha，organic 套，边缘羽化成岸线），
 * 颜色和动效全在着色器里算：
 *   - **流动**：两层异速、异向的世界空间噪声，`windTime` 驱动
 *   - **深浅**：按 `groundField.b`（模糊水域度）在深/浅水色之间 mix
 *   - **岸线泡沫**：近岸带（b 较低处）叠动态碎泡沫
 *   - **日照微光**：噪声高点的柔和高光，强度随 `sunAmount`，入夜自动消失
 *
 * ## ⚠️ 沿用的三条硬约束
 *   - 噪声坐标用 `iOffset`（未镜像世界坐标）+ `noiseOrigin`（过缝补偿），
 *     绝不用 `positionWorld`；`noiseOrigin` 只进噪声，不进顶点
 *   - 颜色链乘 `dayTint`，否则入夜水面不变暗
 *   - `windTime` 与时钟解耦，暂停时冻结（见 frame.tsl）
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import {
  add,
  float,
  max,
  mix,
  mul,
  mx_noise_float,
  positionGeometry,
  pow,
  smoothstep,
  sub,
  texture,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { WORLD_SIZE } from '../core/constants'
import { LAYER_STEP, attr, cloudShadow, maskUvNode, type ShaderNode } from './ground.tsl'
import type { FrameUniforms } from './frame.tsl'

/** 深/浅水与泡沫色（**线性**，已由 sRGB 调色板转换） */
const SHALLOW = srgbLin([0.5, 0.66, 0.66])
const DEEP = srgbLin([0.32, 0.5, 0.56])
const FOAM = srgbLin([0.86, 0.92, 0.9])

export interface WaterMaterialOptions {
  /** 遮罩图集（水体形状的 alpha） */
  maskAtlas: THREE.Texture
  /** 自然面混合场，B 通道 = 模糊水域度，用来分深浅 + 定岸线 */
  groundField: THREE.Texture
  /** ⚠️ 必填 */
  frame: FrameUniforms
  /** 画在第几高度 */
  order: number
}

export function createWaterMaterial(o: WaterMaterialOptions): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial()
  const iOffset = attr('iOffset', 'vec2')
  const iAtlas = attr('iAtlas', 'vec2')

  mat.positionNode = vec3(
    positionGeometry.x.add(iOffset.x),
    float(o.order * LAYER_STEP),
    positionGeometry.z.add(iOffset.y),
  )

  const rawEdge = texture(o.maskAtlas, maskUvNode(iAtlas)).r

  // 本片元世界坐标（未镜像）
  const worldXY = uv().sub(float(0.5)).add(iOffset)
  const w = worldXY as unknown as ShaderNode
  const no = o.frame.noiseOrigin as unknown as ShaderNode
  // ⚠️ windTime / sunAmount 是标量，绝不能 cast 成 ShaderNode（那是 vec3 类型）——
  // 一旦 mul 之后类型变成 vec3，就没法再拼进噪声的 vec3 坐标里
  const wt = o.frame.windTime
  const sun = o.frame.sunAmount

  const bx = add(w.x, no.x)
  const by = add(w.y, no.y)

  // 水线：原始遮罩偏硬，这里加一层世界空间碎边 + 更宽 smoothstep 羽化 —— 软化水陆边界、
  // 打成手绘那种不规则岸线。碎边按世界坐标 + noiseOrigin，接缝两侧同值不裂。
  const edgeBreak = mul(
    mx_noise_float(vec3(mul(bx, float(0.5)), mul(by, float(0.5)), float(0))),
    float(0.12),
  )
  const maskAlpha = smoothstep(float(0.16), float(0.66), add(rawEdge, edgeBreak))

  // ── 两层流动噪声 ──
  // 第一层：粗、沿 +x 缓流；第二层：细、沿 -y 稍快。
  // 噪声坐标从标量分量拼 vec3（z=0），避开 attr 把实例节点收窄成 vec3 的类型坑。
  const n1 = mx_noise_float(
    vec3(add(mul(bx, float(0.32)), mul(wt, float(0.06))), mul(by, float(0.32)), float(0)),
  )
  const n2 = mx_noise_float(
    vec3(mul(bx, float(0.7)), sub(mul(by, float(0.7)), mul(wt, float(0.11))), float(0)),
  )
  const ripple = add(mul(n1, float(0.6)), mul(n2, float(0.4)))

  // ── 深浅 ──
  const depth = texture(o.groundField, worldXY.mul(float(1 / WORLD_SIZE))).b
  const deepMix = smoothstep(float(0.45), float(0.85), depth)
  const baseCol = mix(vec3(...SHALLOW), vec3(...DEEP), deepMix)

  // ── 亮度：微起伏 + 日照微光 ──
  const glint = mul(pow(max(n1, float(0)), float(5)), mul(sun, float(0.18)))
  const bright = add(add(float(1), mul(ripple, float(0.05))), glint)
  let col = mul(baseCol, bright)

  // ── 岸线泡沫 ──
  // 近岸（depth 小）才有；用一层更快的噪声打成断续的泡沫花边
  const foamBand = smoothstep(float(0.72), float(0.44), depth)
  const foamN = mx_noise_float(
    vec3(add(mul(bx, float(0.9)), mul(wt, float(0.18))), mul(by, float(0.9)), float(0)),
  )
  const foamAmt = mul(foamBand, smoothstep(float(0.3), float(0.62), foamN))
  col = mix(col, vec3(...FOAM), mul(foamAmt, float(0.55)))

  // 水线内侧更亮的浅水圈（参考图岸边发亮的浅水）：近岸 depth 小处提亮
  const shore = smoothstep(float(0.5), float(0.16), depth)
  col = mix(col, mul(col, float(1.16)), mul(shore, float(0.45)))

  const cloud = cloudShadow(w.x, w.y, o.frame)
  mat.colorNode = vec4((col as unknown as ShaderNode).mul(o.frame.dayTint).mul(cloud), maskAlpha)
  mat.transparent = true
  mat.depthWrite = false
  mat.depthTest = true
  mat.side = THREE.FrontSide
  return mat
}

/** sRGB → 线性（编译期，一次） */
function srgbLin(c: readonly [number, number, number]): [number, number, number] {
  const f = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return [f(c[0]), f(c[1]), f(c[2])]
}
