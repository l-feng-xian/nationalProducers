/**
 * 精灵公告牌材质。
 *
 * ## 脚底深度写入 z-buffer，遮挡由深度测试解（§5 的结构性性质）
 * 正交、俯角 62°、偏航恒 0 → 屏幕基向量是常量：
 *   right = (1,0,0)   up = (0,cos62°,-sin62°)   forward = (0,-sin62°,-cos62°)
 * 且 `up·forward = 0` —— 屏幕对齐四边形的**整片深度恒等于脚底深度**。
 * 于是每个精灵（连它高高的树冠）都以**脚底深度**写进 z-buffer：脚底更靠南（大 z、离
 * 相机近）的精灵，其整片（含树冠）会正确遮住脚底更靠北的精灵。这样主角走到树北侧会被
 * 树冠挡住、走到树南侧压在树前 —— 跨 mesh（装饰批 / NPC / 主角各是独立 draw）也成立，
 * 因为解遮挡的是**深度缓冲**而不是画家序。
 *
 * ## ⚠️ 深度写入的镂空 + alphaToCoverage（不是 transparent 混合）
 * 早期用 `transparent:true + depthWrite:false + renderOrder` 靠画家序叠精灵 —— 那样
 * 主角 renderOrder 最高就**永远**压在所有装饰之上，走到树后也在树冠前（结构性 bug）。
 * 现在改成**不透明队列 + 深度写入**：`transparent:false` + `depthWrite:true` +
 * `alphaTest` 裁掉透明外围（否则透明像素也写深度、在精灵四周打出一圈深度洞）。
 * 镂空硬边的锯齿交给 **MSAA 的 alphaToCoverage** 抗掉（renderer 开了 antialias，
 * 主帧缓冲是多重采样的，两后端都支持）。
 *
 * ## 顶点
 * 基础四边形 X∈[-0.5,0.5]、Y∈[0,1]、Z=0，仅用来携带局部坐标；真正的世界位置在
 * positionNode 里用屏幕基向量重建：脚底钉在 `iFoot`（未镜像世界坐标，chunk 镜像
 * 偏移在 group.position 上），向 up 方向长出去。
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
  positionGeometry,
  sin,
  smoothstep,
  sub,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { PITCH, WORLD_SIZE } from '../core/constants'
import { worldLighting } from './ground.tsl'
import { SPRITE_FOOT_V } from './spriteAtlas'
import type { FrameUniforms } from './frame.tsl'
import { spriteSurfaceLighting } from './spriteLighting.tsl'
import type { Node } from 'three/webgpu'

/**
 * 风的行波。⚠️ 波数取成世界周长的整数倍 `2π·m/512`，
 * 于是 `sin(k·x)` 在环面上天然周期、接缝两侧同值 —— 不需要 noiseOrigin 补偿。
 */
const WIND_M_X = 5 // x 方向整周期数
const WIND_M_Z = 3 // z 方向整周期数
const WIND_KX = (2 * Math.PI * WIND_M_X) / WORLD_SIZE
const WIND_KZ = (2 * Math.PI * WIND_M_Z) / WORLD_SIZE
const WIND_FREQ = 1.1 // 时间频率（rad/s，windTime 单位是秒）
const WIND_AMP = 0.16 // 顶端最大摆幅（格）

type Vec3Node = typeof positionGeometry
type FloatNode = ReturnType<typeof float>

function attrV(name: string, type: string): Vec3Node {
  return attribute(name, type) as unknown as Vec3Node
}
function attrF(name: string): FloatNode {
  return attribute(name, 'float') as unknown as FloatNode
}

export interface SpriteMaterialOptions {
  atlas: THREE.DataArrayTexture
  normals?: THREE.DataArrayTexture
  /** ⚠️ 必填。精灵也要随昼夜变暗 */
  frame: FrameUniforms
  submersion?: FloatNode
}

export function createSpriteMaterial(o: SpriteMaterialOptions): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial()

  const iFoot = attrV('iFoot', 'vec2')
  const iSize = attrF('iSize')
  const iLayer = attrF('iLayer')
  const iFlip = attrF('iFlip')
  const iSway = attrF('iSway')

  const px = positionGeometry.x
  const py = positionGeometry.y

  // 脚底钉在 iFoot，向 up 方向长出去。内容底边在层内 v=SPRITE_FOOT_V，
  // 对应四边形 Y = 1 - SPRITE_FOOT_V，把它对齐到地面
  const footY = float(1 - SPRITE_FOOT_V)
  const t = mul(sub(py, footY), iSize).sub(o.submersion ?? float(0))
  const cos = float(Math.cos(PITCH))
  const negSin = float(-Math.sin(PITCH))

  // ── 风摆：脚底不动、顶端摆动 ──
  //
  // 相位含脚底世界坐标 → 相邻精灵是一列**行波**（成片的阵风），不是各晃各的。
  // 摆幅按 (py-footY) 缩放 → 越靠顶摆得越大，脚底恒为 0。
  // windTime 暂停时冻结（见 frame.tsl），过缝天然连续（波数是周长整数倍）。
  const wt = o.frame.windTime
  const phase = add(
    add(mul(iFoot.x, float(WIND_KX)), mul(iFoot.y, float(WIND_KZ))),
    mul(wt, float(WIND_FREQ)),
  )
  const heightAbove = mul(sub(py, footY), iSize) // 顶端 ≈ 整株高度，脚底为 0
  const swayX = mul(mul(sin(phase), iSway), mul(heightAbove, float(WIND_AMP)))

  const worldX = add(add(iFoot.x, mul(px, iSize)), swayX)
  const worldY = mul(t, cos)
  const worldZ = add(iFoot.y, mul(t, negSin))
  mat.positionNode = vec3(worldX, worldY, worldZ)

  // UV：几何 uv 已经是 (X+0.5, 1-Y)。水平翻转做左右变体，脚底一致不受影响
  const base = uv()
  const u = mix(base.x, sub(float(1), base.x), iFlip)
  const sample = texture(o.atlas, vec2(u, base.y)).depth(iLayer)

  // 云影按**脚底**世界坐标采样：整株精灵随脚下这片地一起进出云影
  let lighting = worldLighting(iFoot.x, iFoot.y, o.frame)
  if (o.normals) {
    const imageHeight = float(SPRITE_FOOT_V).sub(base.y).mul(iSize)
    const height = imageHeight.sub(o.submersion ?? float(0)).max(0)
    // Match the wind displacement of the visible surface and its shadow caster.
    const wind = sin(phase).mul(iSway).mul(imageHeight).mul(WIND_AMP)
    const x = iFoot.x.add(base.x.sub(0.5).mul(iSize)).add(wind)
    const surface = spriteSurfaceLighting(
      o.normals,
      vec2(u, base.y),
      iLayer,
      iFlip,
      iFoot as unknown as Node<'vec2'>,
      x,
      height,
      o.frame,
    )
    lighting = mix(lighting, surface, o.frame.surfaceLightAmount)
  }
  let alpha = sample.a
  let color = (sample.rgb as unknown as Vec3Node).mul(1)
  if (o.submersion) {
    const height = float(SPRITE_FOOT_V).sub(base.y).mul(iSize)
    const wet = smoothstep(float(0), float(0.07), o.submersion)
    alpha = alpha.mul(
      mix(float(1), smoothstep(o.submersion.sub(0.008), o.submersion.add(0.012), height), wet),
    )
    const wetHem = smoothstep(o.submersion, o.submersion.add(0.16), height).oneMinus().mul(wet)
    color = color.mul(mix(vec3(1, 1, 1), vec3(0.56, 0.76, 0.75), wetHem))
  }
  mat.colorNode = vec4(color.mul(lighting), alpha)
  // 不透明队列 + 深度写入：脚底深度进 z-buffer，跨 mesh 由深度测试解遮挡（见文件头）
  mat.transparent = false
  mat.depthWrite = true
  mat.depthTest = true
  // ⚠️ 裁掉透明外围，否则透明像素照样写深度、在每个精灵四周打出一圈深度洞。
  // 阈值取 0.4：保留主体，抗锯齿描边的软边（0.4~1）由 alphaToCoverage 平滑成部分覆盖。
  mat.alphaTest = 0.4
  // MSAA 覆盖抗锯齿：镂空硬边不再是阶梯，而是按 alpha 分级的部分采样覆盖
  mat.alphaToCoverage = true
  // 公告牌永远正对相机，双面免去「绕序反了整片精灵不可见」这类无声 bug
  mat.side = THREE.DoubleSide

  return mat
}

/** 精灵公告牌四边形：X∈[-0.5,0.5] Y∈[0,1] Z=0，uv=(X+0.5, 1-Y) */
export function createSpriteQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const positions = new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0])
  // v = 1 - Y：底边 Y=0 → v=1（层底），顶边 Y=1 → v=0（层顶）
  const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}
