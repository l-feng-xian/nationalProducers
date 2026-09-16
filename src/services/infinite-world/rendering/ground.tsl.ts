/**
 * 地表材质：双网格的一层 = 一个实例化四边形批。
 *
 * 每个实例是一个显示格，携带：
 *   iOffset (vec2)  显示格中心的世界坐标
 *   iAtlas  (vec2)  遮罩图集里那一格的归一化偏移（CPU 侧算好）
 *   iColor  (vec3)  色调补偿（贴图 × 它 = 目标色）
 *   iMat    (float) 地表贴图在数组纹理里的层号
 *
 * 遮罩图集是 4×4 的 16 形态。帧号 → 格偏移的换算放在 CPU（chunkBuild），
 * 着色器里一次 mod/floor 都不做。
 *
 * ## 形状与材质是两张纹理，职责完全分开
 *   - **形状**来自遮罩图集：程序化生成，16 形态拓扑精确，`ClampToEdge` + 无 mipmap
 *   - **材质**来自 AI 生成的可平铺贴图：`DataArrayTexture`，`RepeatWrapping` + 全 mipmap
 * 两者的采样参数正好相反，这也是它们必须是两张纹理、不能合并的原因。
 *
 * ## ⚠️ dayTint 是必填参数，不是可选项
 * TSL 的 `colorNode` 完全绕开 `material.color`。忘了接的后果是
 * 「入夜后这一层不会变暗」，而且只在夜里才看得出来。
 * 做成必填的构造参数，漏不掉。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import {
  add,
  attribute,
  float,
  mix,
  mul,
  mx_noise_float,
  positionGeometry,
  smoothstep,
  sub,
  texture,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { WORLD_SIZE } from '../core/constants'
import { MASK_ATLAS_COLS, MASK_ATLAS_PX } from '../grid/masks'
import { TILE_WORLD } from './groundTextures'
import type { NaturalDescriptor } from './chunkBuild'
import type { FrameUniforms } from './frame.tsl'

/** 层与层之间的高度间隔，避免 z-fighting。62° 俯角下 2mm 足够 */
export const LAYER_STEP = 0.004

// 广义标量节点（= Node<"float">）。用 mx_noise_float 的返回类型取到它 ——
// `ReturnType<typeof float>` 是更窄的 VarNode，装不下 add/sub/swizzle 的结果
type Scalar = ReturnType<typeof mx_noise_float>

/** 云影：空间频率（越小云越大）、漂移速度、最深压暗 */
const CLOUD_FREQ = 0.05
const CLOUD_DRIFT_X = 0.06
const CLOUD_DRIFT_Y = 0.022
const CLOUD_DARKEN = 0.24

/**
 * 云影乘子（1 = 无遮，越小越暗）。
 *
 * 地面/覆盖层/水面/精灵**都乘同一个它**，云才会整片一致地扫过所有东西 ——
 * 只要有一层漏乘，那层就会在云影里诡异地亮着。
 *
 * ⚠️ 只在白天出现：乘 `sunAmount`，入夜自动消失（夜里没有日光投影）。
 * ⚠️ 噪声坐标加 `noiseOrigin`（过缝补偿），漂移用 `windTime`（暂停冻结）。
 *
 * @param wx,wy 采样点的世界坐标标量（精灵传脚底坐标，地面传本片元世界坐标）
 */
export function cloudShadow(wx: Scalar, wy: Scalar, frame: FrameUniforms): Scalar {
  const no = frame.noiseOrigin as unknown as ShaderNode
  const wt = frame.windTime
  const nx = add(mul(add(wx, no.x), float(CLOUD_FREQ)), mul(wt, float(CLOUD_DRIFT_X)))
  const ny = add(mul(add(wy, no.y), float(CLOUD_FREQ)), mul(wt, float(CLOUD_DRIFT_Y)))
  const n = mx_noise_float(vec3(nx, ny, float(0)))
  const shade = smoothstep(float(0.12), float(0.5), n)
  const amt = mul(shade, mul(frame.sunAmount, float(CLOUD_DARKEN)))
  return sub(float(1), amt)
}

export interface GroundMaterialOptions {
  /** 遮罩图集（单通道存在 R 里） */
  maskAtlas: THREE.Texture
  /** 可平铺地表材质的数组纹理 */
  ground: THREE.DataArrayTexture
  /** ⚠️ 必填。见文件头 */
  frame: FrameUniforms
  /** 这一层画在第几高度 */
  order: number
  /** 透明层（覆盖层）还是不透明层（底色） */
  transparent: boolean
}

/**
 * 实例属性节点。
 *
 * ⚠️ `@types/three@0.185.4` 的 `attribute()` 返回 `AttributeNode<string>`，
 * 上面既没有 swizzle（`.x` / `.y`）也没有算子（`.mul` / `.min` / `.div`）——
 * 而实装的 three 0.186 运行时是有的。
 *
 * 这里显式收窄成「与 positionGeometry 同类的节点」，而不是在调用处撒 `as any`：
 * 全局 any 会顺带吞掉真正的类型错误（比如把 vec2 当 vec3 用、属性名拼错）。
 * 收在这一个函数里，将来 @types 补齐只需删掉它。
 */
export type ShaderNode = typeof positionGeometry
export function attr(name: string, type: string): ShaderNode {
  return attribute(name, type) as unknown as ShaderNode
}

/**
 * 遮罩图集 UV（含半纹素内缩）。所有走双网格遮罩的层共用 —— 包括水面。
 * iAtlas 是 CPU 算好的归一化格偏移。
 */
export function maskUvNode(iAtlas: ShaderNode): ShaderNode {
  const CELL = 1 / MASK_ATLAS_COLS
  const INSET = 0.5 / MASK_ATLAS_PX
  return uv().mul(float(CELL - INSET * 2)).add(float(INSET)).add(iAtlas) as unknown as ShaderNode
}

export interface BaseMaterialOptions {
  /** 可平铺地表材质的数组纹理 */
  ground: THREE.DataArrayTexture
  /** 自然面混合场（R=林地度 G=湿地度 B=水域度），见 groundField.ts */
  groundField: THREE.Texture
  /** ⚠️ 必填。见文件头 */
  frame: FrameUniforms
  /** 三种自然面：草地是底，林地/湿地按场值叠上去 */
  naturals: { grass: NaturalDescriptor; forest: NaturalDescriptor; marsh: NaturalDescriptor }
}

/** 采样一种自然面贴图（世界空间平铺 UV）并施加亮度补偿 */
function sampleNatural(
  ground: THREE.DataArrayTexture,
  tileUv: ShaderNode,
  d: NaturalDescriptor,
): ShaderNode {
  return texture(ground, tileUv).depth(float(d.layer)).rgb.mul(float(d.tint)) as unknown as ShaderNode
}

/**
 * 底色层材质：**世界空间软混合**草地 / 林地 / 湿地。
 *
 * 这是「转折过于生硬」和「过暗的网格拼花」的正解 —— 底色不再逐格挑贴图，
 * 而是按 `groundField` 的平滑场在三张贴图间过渡。过渡宽度 = 场的模糊半径，
 * 天然跨十几格；再叠一层世界空间噪声把边界打成有机手绘的碎边。
 *
 * ## ⚠️ 三条硬约束（见 §6）
 *   - UV 用 `iOffset`（未镜像世界坐标），不用 `positionWorld` —— 否则接缝两侧对不上
 *   - 噪声参数加 `noiseOrigin`，但**只加进噪声**，绝不加进顶点位置
 *   - 颜色链必须乘 `dayTint`/`seasonTint`，否则入夜不变暗
 */
export function createBaseMaterial(o: BaseMaterialOptions): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial()
  const iOffset = attr('iOffset', 'vec2')

  mat.positionNode = vec3(positionGeometry.x.add(iOffset.x), float(0), positionGeometry.z.add(iOffset.y))

  // 本片元的世界坐标（未镜像，环面唯一）
  const worldXY = uv().sub(float(0.5)).add(iOffset)
  const tileUv = worldXY.mul(float(1 / TILE_WORLD))
  const fieldUv = worldXY.mul(float(1 / WORLD_SIZE))

  const g = sampleNatural(o.ground, tileUv as unknown as ShaderNode, o.naturals.grass)
  const f = sampleNatural(o.ground, tileUv as unknown as ShaderNode, o.naturals.forest)
  const m = sampleNatural(o.ground, tileUv as unknown as ShaderNode, o.naturals.marsh)

  const field = texture(o.groundField, fieldUv)

  // 有机碎边：按世界坐标取一层噪声，扰动混合阈值。
  // ⚠️ 噪声参数加 noiseOrigin（过缝补偿），tile/field 的 UV 不能加。
  //
  // 从标量分量拼噪声坐标：`attr` 把所有实例节点都收窄成 vec3 类型，
  // 直接 `vec3(vec2节点, 0)` 过不了类型；取 `.x/.y` 标量再拼 vec3 稳妥。
  const w = worldXY as unknown as ShaderNode
  const no = o.frame.noiseOrigin as unknown as ShaderNode
  const nx = mul(add(w.x, no.x), float(0.18))
  const ny = mul(add(w.y, no.y), float(0.18))
  const wob = mul(mx_noise_float(vec3(nx, ny, float(0))), float(0.14))

  const forestW = smoothstep(float(0.3), float(0.62), add(field.r, wob))
  const marshW = smoothstep(float(0.26), float(0.58), add(field.g, wob))

  let col = mix(g, f, forestW)
  col = mix(col, m, marshW)

  // 接触阴影：贴着人造面（土路/城镇/耕地）的草地柔和压深，把硬边过渡揉软 ——
  // field.a 是模糊后的人造面覆盖度，路心最高、向外渐隐。参考图里路边草就是这样一圈暗。
  const contact = sub(float(1), mul(smoothstep(float(0.1), float(0.8), field.a), float(0.24)))

  // 湿岸带：贴近水的陆地压深 + 轻微偏冷，做出参考图水边那圈湿润软过渡。
  // field.b 是模糊后的水域度 —— 水线处最强、向内约 2–4 格渐隐；红通道压得比蓝绿多 → 偏冷湿。
  const wet = smoothstep(float(0.03), float(0.5), field.b)
  const wetMul = mix(vec3(1, 1, 1), vec3(0.72, 0.82, 0.86), wet)

  const cloud = cloudShadow(w.x, w.y, o.frame)
  mat.colorNode = vec4(
    (col as unknown as ShaderNode)
      .mul(wetMul as unknown as ShaderNode)
      .mul(contact)
      .mul(o.frame.dayTint)
      .mul(o.frame.seasonTint)
      .mul(cloud),
    float(1),
  )
  mat.transparent = false
  mat.depthWrite = true
  mat.side = THREE.FrontSide
  return mat
}

export function createGroundMaterial(o: GroundMaterialOptions): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial()

  const iOffset = attr('iOffset', 'vec2')
  const iAtlas = attr('iAtlas', 'vec2')
  const iColor = attr('iColor', 'vec3')
  const iMat = attr('iMat', 'float')

  // ── 顶点：把单位四边形放到显示格上 ──
  //
  // 基础几何是 XZ 平面上的单位四边形（-0.5..0.5）。
  // 显示格 D(i,j) 的中心恰在世界点 (i, j)，所以直接加 iOffset 即可。
  mat.positionNode = vec3(
    positionGeometry.x.add(iOffset.x),
    float(o.order * LAYER_STEP),
    positionGeometry.z.add(iOffset.y),
  )

  // 遮罩 UV（半纹素内缩，见 maskUvNode）
  const maskSample = texture(o.maskAtlas, maskUvNode(iAtlas))

  // ── 地表材质 UV：世界空间，不是逐格 ──
  //
  // 单位四边形的 uv (0..1) 对应世界坐标 iOffset ± 0.5，所以
  //   world = iOffset + (uv - 0.5)
  // 再除以「一张贴图横跨多少格」。这样贴图跨着格子边界连续铺开 ——
  // 逐格 0..1 会让每一格都是同一张图的副本，远看就是一片整齐方格纹。
  //
  // ⚠️ 用的是 iOffset（**未镜像**的世界坐标），不是 positionWorld。
  // chunk 的镜像位移在 group.position 上，取 positionWorld 会让接缝
  // 两侧的同一块地贴图对不上；而 iOffset 在环面上本来就是唯一的。
  const worldUv = uv().sub(float(0.5)).add(iOffset).mul(float(1 / TILE_WORLD))
  const groundSample = texture(o.ground, worldUv).depth(iMat)

  // ── 碎边 + 内描边：把「过于生硬的转折」做成手绘感 ──
  //
  // 人造面的双网格边缘本来是干净的数学阶梯。这里按**世界坐标**取一层噪声
  // 扰动 alpha 的过渡带，把边缘打成有机碎边；再沿边缘内侧压一道暗线（ink rim），
  // 就是参考图里土路/石板那种手绘描边。
  //
  // ⚠️ 噪声按世界坐标 + noiseOrigin —— 接缝两侧取到同一个值，边缘不裂
  // （见 masks.ts 头注释：碎边只能在着色器里按世界坐标加，不能进遮罩）。
  // 这层噪声将来可无缝换成一张 AI 碎边灰度图（世界空间采样），机制不变。
  const wxy = uv().sub(float(0.5)).add(iOffset)
  const wn = wxy as unknown as ShaderNode
  const non = o.frame.noiseOrigin as unknown as ShaderNode
  const enx = mul(add(wn.x, non.x), float(0.55))
  const eny = mul(add(wn.y, non.y), float(0.55))
  // 加大碎边幅度 + 加宽过渡带：把双网格数学阶梯打成手绘碎边、并让边缘羽化更软消锯齿。
  const ebreak = mul(mx_noise_float(vec3(enx, eny, float(0))), float(0.2))
  const alpha = smoothstep(float(0.28), float(0.72), add(maskSample.r, ebreak))

  // 内描边：alpha 处于过渡带（~0.5）时最强，压暗颜色画出手绘墨线
  const rim = mul(mul(alpha, sub(float(1), alpha)), float(0.7))
  const shade = sub(float(1), mul(rim, float(0.55)))

  const cloud = cloudShadow(wn.x, wn.y, o.frame)
  mat.colorNode = vec4(
    groundSample.rgb.mul(iColor).mul(shade).mul(o.frame.dayTint).mul(o.frame.seasonTint).mul(cloud),
    alpha,
  )
  mat.transparent = o.transparent
  mat.depthWrite = !o.transparent
  mat.side = THREE.FrontSide

  if (o.transparent) {
    // ⚠️ 覆盖层必须排进**透明队列**。
    // three 永远先画完不透明队列再画透明队列，renderOrder 只在队列内部生效。
    // 留在不透明队列的话，覆盖层会先于底色被画，底色再覆上去把它盖掉。
    mat.depthTest = true
  }

  return mat
}

/**
 * 单位四边形（XZ 平面），所有地表层共用。
 *
 * ⚠️ 绕序必须让法线朝 **+Y**，否则相机在上方时整片地面会被背面剔除 ——
 * 画面上看到的是纯粹的场景背景色，**控制台一句报错都没有**，
 * canvas 尺寸也完全正常，极难往「面朝向」上想。
 *
 * 验算：顶点 0→1→2 即 (-.5,0,-.5)→(.5,0,-.5)→(.5,0,.5)，
 *   (v1-v0) × (v2-v0) = (1,0,0) × (1,0,1) = (0,-1,0)   ← 朝下，错
 * 改成 0→2→1 之后：
 *   (v2-v0) × (v1-v0) = (1,0,1) × (1,0,0) = (0,1,0)    ← 朝上，对
 */
export function createGroundQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const positions = new Float32Array([
    -0.5, 0, -0.5,
    0.5, 0, -0.5,
    0.5, 0, 0.5,
    -0.5, 0, 0.5,
  ])
  const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex([0, 2, 1, 0, 3, 2])
  g.computeVertexNormals()
  return g
}
