/**
 * 定型数组 → THREE 对象。
 *
 * ## ⚠️ matrixAutoUpdate = false
 * chunk 会被挪到「离玩家最近的那个镜像」位置，每帧可能变。
 * 关掉自动更新是为了不在每帧对 250 个对象做矩阵分解/合成。
 *
 * **但这条有个致命的配套要求：改了 position 必须自己调 `updateMatrix()`。**
 * 漏掉的话 Scene 会从**陈旧的 matrix** 重算 matrixWorld —— 物体静默画在
 * 老地方，连视锥剔除都拿旧包围球去测，症状是「chunk 莫名其妙闪进闪出」，
 * 而代码里改 position 那一行看起来完全正常。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { CHUNK } from '../core/constants'
import { LAYERS } from '../grid/dualGrid'
import { naturalDescriptor, type ChunkBuild, type LayerInstances } from './chunkBuild'
import { createBaseMaterial, createGroundMaterial, createGroundQuad } from './ground.tsl'
import { createWaterMaterial } from './water.tsl'
import { createSpriteMaterial, createSpriteQuad } from './sprite.tsl'
import type { FrameUniforms } from './frame.tsl'
import type { MaskTextures } from './atlas'
import type { GroundTextures } from './groundTextures'
import type { GroundField } from './groundField'
import type { SpriteAtlas } from './spriteAtlas'

export interface ChunkObject {
  cx: number
  cy: number
  centerX: number
  centerY: number
  group: THREE.Group
  meshes: THREE.Mesh[]
  /** 当前的镜像偏移 */
  ox: number
  oy: number
  visible: boolean
  drawCalls: number
  dispose(): void
}

/** 共享的单位四边形与材质，所有 chunk 复用 —— 不是每块各造一份 */
export interface ChunkMeshDeps {
  quad: THREE.BufferGeometry
  materials: Map<string, THREE.MeshBasicNodeMaterial>
  masks: MaskTextures
  ground: GroundTextures
  groundField: GroundField
  spriteAtlas: SpriteAtlas
  spriteQuad: THREE.BufferGeometry
  spriteMaterial: THREE.MeshBasicNodeMaterial
  frame: FrameUniforms
}

export function createChunkMeshDeps(
  masks: MaskTextures,
  ground: GroundTextures,
  groundField: GroundField,
  spriteAtlas: SpriteAtlas,
  frame: FrameUniforms,
): ChunkMeshDeps {
  const quad = createGroundQuad()
  const spriteQuad = createSpriteQuad()
  const spriteMaterial = createSpriteMaterial({ atlas: spriteAtlas.texture, frame })
  const materials = new Map<string, THREE.MeshBasicNodeMaterial>()

  // 底色层：世界空间软混合草地/林地/湿地（不透明，见 createBaseMaterial）
  materials.set(
    'base',
    createBaseMaterial({
      ground: ground.array,
      groundField: groundField.texture,
      frame,
      naturals: {
        grass: naturalDescriptor('grass-meadow', ground.palette),
        forest: naturalDescriptor('forest-floor', ground.palette),
        marsh: naturalDescriptor('marsh', ground.palette),
      },
    }),
  )
  // 覆盖层：各用自己的遮罩套。水面走专属 TSL 材质
  for (const def of LAYERS) {
    if (def.id === 'water') {
      materials.set(
        def.id,
        createWaterMaterial({
          maskAtlas: masks.get(def.maskSet),
          groundField: groundField.texture,
          frame,
          order: def.order,
        }),
      )
      continue
    }
    materials.set(
      def.id,
      createGroundMaterial({
        maskAtlas: masks.get(def.maskSet),
        ground: ground.array,
        frame,
        order: def.order,
        transparent: true,
      }),
    )
  }

  return { quad, materials, masks, ground, groundField, spriteAtlas, spriteQuad, spriteMaterial, frame }
}

export function disposeChunkMeshDeps(deps: ChunkMeshDeps): void {
  deps.quad.dispose()
  deps.spriteQuad.dispose()
  deps.spriteMaterial.dispose()
  for (const m of deps.materials.values()) m.dispose()
  deps.materials.clear()
}

export function createChunkObject(build: ChunkBuild, deps: ChunkMeshDeps): ChunkObject {
  const group = new THREE.Group()
  // ⚠️ 见文件头：关了自动更新，改 position 之后必须自己 updateMatrix()
  group.matrixAutoUpdate = false
  const meshes: THREE.Mesh[] = []
  const owned: THREE.BufferGeometry[] = []

  for (const layer of build.layers) {
    const mat = deps.materials.get(layer.layer)
    if (!mat || layer.count === 0) continue
    const geo = makeInstancedGeometry(deps.quad, layer)
    owned.push(geo)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.frustumCulled = false // 由 chunkManager 用环面距离剔除，视锥剔除帮不上忙
    mesh.matrixAutoUpdate = false
    mesh.renderOrder = layer.order
    mesh.updateMatrix()
    group.add(mesh)
    meshes.push(mesh)
  }

  // ── 装饰精灵：一块一个实例化公告牌批 ──
  if (build.sprites.count > 0) {
    const geo = makeSpriteGeometry(deps.spriteQuad, build.sprites)
    owned.push(geo)
    const mesh = new THREE.Mesh(geo, deps.spriteMaterial)
    mesh.frustumCulled = false
    mesh.matrixAutoUpdate = false
    // 精灵现在是不透明+深度写入，遮挡由 z-buffer 解（见 sprite.tsl 文件头）。
    // renderOrder 归 0 —— 装饰/NPC/主角谁在前由脚底深度决定，不再靠画家序分层。
    mesh.renderOrder = 0
    mesh.updateMatrix()
    group.add(mesh)
    meshes.push(mesh)
  }

  const obj: ChunkObject = {
    cx: build.cx,
    cy: build.cy,
    centerX: build.centerX,
    centerY: build.centerY,
    group,
    meshes,
    ox: Number.NaN, // NaN 保证第一次 relayout 必定写入
    oy: Number.NaN,
    visible: false,
    drawCalls: meshes.length,
    dispose() {
      for (const g of owned) g.dispose()
      group.clear()
      meshes.length = 0
    },
  }
  return obj
}

function makeInstancedGeometry(
  quad: THREE.BufferGeometry,
  layer: LayerInstances,
): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = quad.index
  geo.setAttribute('position', quad.getAttribute('position'))
  geo.setAttribute('uv', quad.getAttribute('uv'))
  geo.setAttribute('normal', quad.getAttribute('normal'))
  geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(layer.offset, 2))
  geo.setAttribute('iAtlas', new THREE.InstancedBufferAttribute(layer.atlas, 2))
  geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(layer.color, 3))
  geo.setAttribute('iMat', new THREE.InstancedBufferAttribute(layer.mat, 1))
  geo.instanceCount = layer.count
  // 包围球设成整块 chunk —— 我们关了 frustumCulled，但 three 某些路径仍会读它
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), CHUNK)
  return geo
}

function makeSpriteGeometry(
  quad: THREE.BufferGeometry,
  s: import('./decorBuild').SpriteInstances,
): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry()
  geo.index = quad.index
  geo.setAttribute('position', quad.getAttribute('position'))
  geo.setAttribute('uv', quad.getAttribute('uv'))
  geo.setAttribute('iFoot', new THREE.InstancedBufferAttribute(s.foot, 2))
  geo.setAttribute('iSize', new THREE.InstancedBufferAttribute(s.size, 1))
  geo.setAttribute('iLayer', new THREE.InstancedBufferAttribute(s.layer, 1))
  geo.setAttribute('iFlip', new THREE.InstancedBufferAttribute(s.flip, 1))
  geo.setAttribute('iSway', new THREE.InstancedBufferAttribute(s.sway, 1))
  geo.instanceCount = s.count
  // 精灵向上长出去，包围球放大一点，含最高的树
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), CHUNK + 8)
  return geo
}

/**
 * 把 chunk 挪到指定的镜像偏移。
 *
 * ⚠️ 这里是那条「改 position 必须 updateMatrix」的唯一执行点。
 * 所有位移都必须走这个函数，不要在别处直接改 group.position。
 */
export function placeChunk(obj: ChunkObject, ox: number, oy: number): void {
  if (obj.ox === ox && obj.oy === oy) return
  obj.ox = ox
  obj.oy = oy
  obj.group.position.set(ox, 0, oy)
  obj.group.updateMatrix()
}

export function setChunkVisible(obj: ChunkObject, visible: boolean): void {
  if (obj.visible === visible) return
  obj.visible = visible
  obj.group.visible = visible
}
