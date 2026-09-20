import * as THREE from 'three/webgpu'
import { attribute, float, mix, positionGeometry, texture, uv, vec2, vec3, vec4 } from 'three/tsl'
import { WORLD_SIZE } from '../core/constants'
import { SPRITE_FOOT_V } from './spriteAtlas'
import type { FrameUniforms } from './frame.tsl'
import { shadowIdentity, SHADOW_HEIGHT_RANGE } from './spriteLighting.tsl'

export function createSpriteShadowTarget() {
  const target = new THREE.RenderTarget(1024, 1024, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  })
  target.texture.colorSpace = THREE.NoColorSpace
  target.texture.name = 'sprite-sun-occluders'
  return target
}

function casterMaterial(atlas: THREE.DataArrayTexture, frame: FrameUniforms) {
  const m = new THREE.MeshBasicNodeMaterial()
  const foot = attribute<'vec2'>('iFoot', 'vec2'),
    size = attribute<'float'>('iSize', 'float')
  const layer = attribute<'float'>('iLayer', 'float'),
    flip = attribute<'float'>('iFlip', 'float'),
    sway = attribute<'float'>('iSway', 'float')
  const h = positionGeometry.y
    .sub(1 - SPRITE_FOOT_V)
    .mul(size)
    .max(0)
  const wind = foot.x
    .mul((2 * Math.PI * 5) / WORLD_SIZE)
    .add(foot.y.mul((2 * Math.PI * 3) / WORLD_SIZE))
    .add(frame.windTime.mul(1.1))
    .sin()
    .mul(sway)
    .mul(h)
    .mul(0.16)
  m.positionNode = vec3(
    foot.x.add(positionGeometry.x.mul(size)).add(wind).add(h.mul(frame.shadowVector.x)),
    h,
    foot.y.add(h.mul(frame.shadowVector.y)),
  )
  const st = vec2(mix(uv().x, uv().x.oneMinus(), flip), uv().y)
  const id = shadowIdentity(foot)
  const height = float(SPRITE_FOOT_V).sub(st.y).mul(size).max(0)
  m.colorNode = vec4(height.div(SHADOW_HEIGHT_RANGE), id.x, id.y, texture(atlas, st).depth(layer).a)
  m.alphaTest = 0.4
  m.toneMapped = false
  m.side = THREE.DoubleSide
  m.depthTest = true
  m.depthWrite = true
  return m
}

/** Highest silhouette along each sun ray. Uses current atlas frame and world transforms. */
export function createSpriteShadowMap(
  renderer: THREE.WebGPURenderer,
  target: THREE.RenderTarget,
  frame: FrameUniforms,
) {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0, 0, 0)
  const camera = new THREE.OrthographicCamera(-48, 48, 48, -48, 1, 40)
  camera.up.set(0, 0, -1)
  const copies = new Map<THREE.Mesh, THREE.Mesh>()
  const materials = new Map<THREE.DataArrayTexture, THREE.MeshBasicNodeMaterial>()
  let lastKey = ''
  return {
    update(world: THREE.Scene, px: number, py: number, span: number) {
      if (frame.sunAmount.value <= 0.001) return
      world.updateMatrixWorld(true)
      const sources: THREE.Mesh[] = []
      world.traverseVisible((o) => {
        if (o.name === 'sun-shadow') sources.push(o as THREE.Mesh)
      })
      const key = `${px},${py},${span},${frame.windTime.value},${frame.shadowVector.value.toArray()},${sources.map((s) => s.id).join(',')}`
      if (key === lastKey) return // Paused frames need no new shadow pass.
      lastKey = key
      const current = new Set(sources)
      for (const [source, copy] of copies)
        if (!current.has(source)) {
          scene.remove(copy)
          copies.delete(source)
        }
      for (const source of sources) {
        let copy = copies.get(source)
        if (!copy) {
          const atlas = (source.material as THREE.Material).userData
            .shadowAtlas as THREE.DataArrayTexture
          if (!atlas) continue
          let material = materials.get(atlas)
          if (!material) {
            material = casterMaterial(atlas, frame)
            materials.set(atlas, material)
          }
          copy = new THREE.Mesh(source.geometry, material)
          copy.frustumCulled = false
          copy.matrixAutoUpdate = false
          copies.set(source, copy)
          scene.add(copy)
        }
        copy.matrix.copy(source.matrixWorld)
      }
      camera.left = camera.bottom = -span / 2
      camera.right = camera.top = span / 2
      camera.position.set(px, 30, py)
      camera.lookAt(px, 0, py)
      camera.updateProjectionMatrix()
      frame.shadowCenter.value.set(px, py)
      frame.shadowSpan.value.set(span, span)
      const previous = renderer.getRenderTarget()
      try {
        renderer.setRenderTarget(target)
        renderer.render(scene, camera)
      } finally {
        renderer.setRenderTarget(previous)
      }
    },
    get count() {
      return copies.size
    },
    dispose() {
      copies.clear()
      scene.clear()
      materials.forEach((m) => m.dispose())
      materials.clear()
      target.dispose()
    },
  }
}
