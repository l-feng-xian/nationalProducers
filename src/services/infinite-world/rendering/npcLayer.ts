/**
 * NPC 公告牌层：一个**动态**实例化批，每帧更新位置。
 *
 * 装饰精灵是静态的、烤进 chunk 几何里；NPC 每帧在动，所以单独一个小批，
 * `iFoot` 缓冲每帧重写。复用 sprite 材质 —— NPC 因此自动获得昼夜压暗 + 云影。
 *
 * ## ⚠️ 就近镜像
 * chunk 精灵靠 group.position 挪到最近镜像；NPC 不进 chunk，改为**每帧算**
 * 每个 NPC 相对玩家的最近镜像坐标：`foot = player + delta(player, npc)`。
 * 于是玩家在接缝附近时，另一侧的 NPC 也画在正确的地方。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { delta } from '../core/torus'
import { createSpriteMaterial, createSpriteQuad } from './sprite.tsl'
import type { SpriteAtlas } from './spriteAtlas'
import type { FrameUniforms } from './frame.tsl'
import type { NpcRuntime } from '../simulation/npcSim'
import { createProjectedShadowMaterial, projectedShadowMesh } from './projectedShadow.tsl'

/** 村民世界高度（格）。Q 版小人比树矮得多 */
const NPC_HEIGHT = 1.6
/** variant 0..3 → 帧名 */
const VARIANT_FRAMES = [
  'villager-young-woman',
  'villager-farmer-man',
  'villager-elder',
  'villager-child',
]

export interface NpcLayer {
  mesh: THREE.Mesh
  shadow: THREE.Mesh
  /** 每帧调用：把 NPC 的插值位置写进实例缓冲 */
  update(npcs: readonly NpcRuntime[], px: number, py: number): void
  dispose(): void
}

/**
 * @param maxNpcs 预分配的实例上限（LOD0 上限 24，留些余量）
 */
export function createNpcLayer(
  atlas: SpriteAtlas,
  frame: FrameUniforms,
  maxNpcs = 48,
): NpcLayer | null {
  // 至少要有一个村民帧才建层
  const layerOf = VARIANT_FRAMES.map((name) => atlas.meta.get(name))
  if (!layerOf.some((m) => m)) return null
  // 每个 variant 的（层号, 世界尺寸）；缺帧的回退到第一个存在的
  const fallback = layerOf.find((m) => m)!
  const resolved = layerOf.map((m) => m ?? fallback)

  const quad = createSpriteQuad()
  const material = createSpriteMaterial({
    atlas: atlas.texture,
    normals: atlas.normalTexture,
    frame,
  })

  const geo = new THREE.InstancedBufferGeometry()
  geo.index = quad.index
  geo.setAttribute('position', quad.getAttribute('position'))
  geo.setAttribute('uv', quad.getAttribute('uv'))
  const foot = new Float32Array(maxNpcs * 2)
  const size = new Float32Array(maxNpcs)
  const layer = new Float32Array(maxNpcs)
  const flip = new Float32Array(maxNpcs)
  const sway = new Float32Array(maxNpcs) // NPC 不随风摆，恒 0
  const footAttr = new THREE.InstancedBufferAttribute(foot, 2)
  const sizeAttr = new THREE.InstancedBufferAttribute(size, 1)
  const layerAttr = new THREE.InstancedBufferAttribute(layer, 1)
  const flipAttr = new THREE.InstancedBufferAttribute(flip, 1)
  footAttr.setUsage(THREE.DynamicDrawUsage)
  layerAttr.setUsage(THREE.DynamicDrawUsage)
  flipAttr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute('iFoot', footAttr)
  geo.setAttribute('iSize', sizeAttr)
  geo.setAttribute('iLayer', layerAttr)
  geo.setAttribute('iFlip', flipAttr)
  geo.setAttribute('iSway', new THREE.InstancedBufferAttribute(sway, 1))
  geo.instanceCount = 0
  // 关掉视锥剔除：NPC 每帧动，包围球不好维护，靠 LOD 距离控制数量
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6)

  const mesh = new THREE.Mesh(geo, material)
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.renderOrder = 0 // 深度写入解遮挡，不再靠画家序分层（见 sprite.tsl 文件头）
  mesh.updateMatrix()
  const shadowMaterial = createProjectedShadowMaterial(atlas.texture, frame)
  const shadow = projectedShadowMesh(geo, shadowMaterial)

  // 排序用的临时数组
  const order: { k: number; z: number }[] = []

  function update(npcs: readonly NpcRuntime[], px: number, py: number): void {
    const n = Math.min(npcs.length, maxNpcs)
    // 按脚底 z（镜像后）升序：远的先画，近的覆在上面
    order.length = 0
    for (let k = 0; k < n; k++) {
      const npc = npcs[k]!
      order.push({ k, z: py + delta(py, npc.y) })
    }
    order.sort((a, b) => a.z - b.z)

    for (let s = 0; s < n; s++) {
      const npc = npcs[order[s]!.k]!
      const fx = px + delta(px, npc.x)
      const fy = py + delta(py, npc.y)
      foot[s * 2] = fx
      foot[s * 2 + 1] = fy
      const r = resolved[npc.variant] ?? fallback
      layer[s] = r.layer
      size[s] = NPC_HEIGHT / Math.max(0.2, r.hFrac)
      flip[s] = npc.face < 0 ? 1 : 0
    }
    geo.instanceCount = n
    footAttr.needsUpdate = true
    sizeAttr.needsUpdate = true
    layerAttr.needsUpdate = true
    flipAttr.needsUpdate = true
  }

  return {
    mesh,
    shadow,
    update,
    dispose() {
      quad.dispose()
      geo.dispose()
      material.dispose()
      shadowMaterial.dispose()
    },
  }
}
