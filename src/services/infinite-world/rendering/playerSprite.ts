/**
 * 玩家角色公告牌：单实例，四朝向 + 逐帧走循环 + 逐帧待机循环。
 *
 * 每个方向有两套帧：站定播 `idle-<dir>-0..`（缓慢呼吸循环），走动播 `walk-<dir>-0..`。
 * 缺哪套就退回单张站姿（`hero-<dir>`），于是素材分批到位也能跑、到位后自动接上。
 *
 * ## 相位由 worldScene 的 walkPhase 驱动，暂停时冻结
 * walkPhase 每个「未暂停」帧递增（走 / 站都推进），所以站定也能播待机呼吸；
 * 走循环用 WALK_CYCLE_SEC 定节奏、待机用更慢的 IDLE_CYCLE_SEC，都与帧数无关。
 *
 * ## 不叠程序化颠簸
 * 走 / 待机都由真帧驱动，mesh 恒在原点、位置全靠 shader 从 iFoot 重建。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { createSpriteMaterial, createSpriteQuad } from './sprite.tsl'
import type { SpriteAtlas } from './spriteAtlas'
import type { FrameUniforms } from './frame.tsl'

/** 主角世界高度（格） */
const PLAYER_HEIGHT = 1.7
/** 一整个走循环放完要多少秒 —— 与帧数无关，4 帧和 16 帧节奏一致 */
const WALK_CYCLE_SEC = 0.75
/** 一整个待机呼吸循环放完要多少秒（慢，站定时播） */
const IDLE_CYCLE_SEC = 3.0

export type Facing = 'down' | 'up' | 'left' | 'right'
const DIRS: Facing[] = ['down', 'up', 'left', 'right']

interface Frame {
  layer: number
  hFrac: number
}

/** 一个方向的两套帧序列：站定播 idle，走动播 walk。 */
interface DirFrames {
  idle: Frame[]
  walk: Frame[]
}

export interface PlayerSprite {
  mesh: THREE.Mesh
  /** 每帧：位置、朝向、动画相位（未暂停时递增秒数）、是否在移动 */
  update(px: number, py: number, facing: Facing, phase: number, moving: boolean): void
  dispose(): void
}

/** 连续收集 `<prefix>-<dir>-0,1,2,…`（任意帧数，缺则停）。 */
function collectSeq(atlas: SpriteAtlas, prefix: string, dir: Facing): Frame[] {
  const out: Frame[] = []
  for (let f = 0; f < 64; f++) {
    const m = atlas.meta.get(`${prefix}-${dir}-${f}`)
    if (!m) break
    out.push({ layer: m.layer, hFrac: m.hFrac })
  }
  return out
}

/**
 * 解析某方向的 idle / walk 两套序列。
 * 缺 idle → 退回站姿单帧（`hero-<dir>`，再退回 walk 第 0 帧）；缺 walk → 退回同一站姿。
 */
function resolveFrames(atlas: SpriteAtlas, dir: Facing): DirFrames {
  const idle = collectSeq(atlas, 'idle', dir)
  const walk = collectSeq(atlas, 'walk', dir)
  const hero = atlas.meta.get(`hero-${dir}`)
  const stand: Frame[] = hero
    ? [{ layer: hero.layer, hFrac: hero.hFrac }]
    : walk.length > 0
      ? [walk[0]!]
      : []
  return {
    idle: idle.length > 0 ? idle : stand,
    walk: walk.length > 0 ? walk : stand,
  }
}

export function createPlayerSprite(atlas: SpriteAtlas, frame: FrameUniforms): PlayerSprite | null {
  const frames: Record<Facing, DirFrames> = {
    down: resolveFrames(atlas, 'down'),
    up: resolveFrames(atlas, 'up'),
    left: resolveFrames(atlas, 'left'),
    right: resolveFrames(atlas, 'right'),
  }
  // 主角素材完全没到位（连站姿都没有）就不渲染
  if (frames.down.idle.length === 0 && frames.down.walk.length === 0) return null
  // 缺哪个方向就借 down（不该发生，防御）
  for (const d of DIRS) {
    if (frames[d].walk.length === 0) frames[d].walk = frames.down.walk
    if (frames[d].idle.length === 0) frames[d].idle = frames.down.idle
  }

  const quad = createSpriteQuad()
  const material = createSpriteMaterial({ atlas: atlas.texture, frame })
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = quad.index
  geo.setAttribute('position', quad.getAttribute('position'))
  geo.setAttribute('uv', quad.getAttribute('uv'))
  const foot = new Float32Array(2)
  const size = new Float32Array(1)
  const layer = new Float32Array(1)
  const footAttr = new THREE.InstancedBufferAttribute(foot, 2)
  const sizeAttr = new THREE.InstancedBufferAttribute(size, 1)
  const layerAttr = new THREE.InstancedBufferAttribute(layer, 1)
  footAttr.setUsage(THREE.DynamicDrawUsage)
  sizeAttr.setUsage(THREE.DynamicDrawUsage)
  layerAttr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('iFoot', footAttr)
  geo.setAttribute('iSize', sizeAttr)
  geo.setAttribute('iLayer', layerAttr)
  geo.setAttribute('iFlip', new THREE.InstancedBufferAttribute(new Float32Array([0]), 1))
  geo.setAttribute('iSway', new THREE.InstancedBufferAttribute(new Float32Array([0]), 1))
  geo.instanceCount = 1
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6)

  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.renderOrder = 0 // 深度写入解遮挡，不再靠画家序（见 sprite.tsl 文件头）
  mesh.updateMatrix()

  function update(px: number, py: number, facing: Facing, phase: number, moving: boolean): void {
    const df = frames[facing] ?? frames.down
    // 走动播 walk（0.75s/循环）、站定播 idle（3s/循环）；phase 只在未暂停时推进
    const seq = moving ? df.walk : df.idle
    const cycle = moving ? WALK_CYCLE_SEC : IDLE_CYCLE_SEC
    const idx = seq.length > 1 ? Math.floor((phase / cycle) * seq.length) % seq.length : 0
    const fr = seq[idx] ?? seq[0]
    if (!fr) return
    foot[0] = px
    foot[1] = py
    size[0] = PLAYER_HEIGHT / Math.max(0.2, fr.hFrac)
    layer[0] = fr.layer
    footAttr.needsUpdate = true
    sizeAttr.needsUpdate = true
    layerAttr.needsUpdate = true
  }

  return {
    mesh,
    update,
    dispose() {
      quad.dispose()
      geo.dispose()
      material.dispose()
    },
  }
}
