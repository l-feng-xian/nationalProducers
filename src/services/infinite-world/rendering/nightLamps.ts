import * as THREE from 'three/webgpu'
import { attribute, float, positionGeometry, smoothstep, uv, vec3, vec4 } from 'three/tsl'
import { PITCH } from '../core/constants'
import { delta } from '../core/torus'
import type { WorldGrid } from '../generation/grid'
import { createSpriteQuad } from './sprite.tsl'
import type { SpriteAtlas } from './spriteAtlas'
import type { FrameUniforms } from './frame.tsl'

export function createNightLamps(grid: WorldGrid, atlas: SpriteAtlas, frame: FrameUniforms) {
  const spec = atlas.meta.get('town-lamp')
  const emitters = grid.towns.flatMap((t) => (t.props ?? []).filter((p) => p.frame === 'town-lamp'))
  const quad = createSpriteQuad(),
    geometry = new THREE.InstancedBufferGeometry()
  geometry.index = quad.index
  for (const name of ['position', 'uv']) geometry.setAttribute(name, quad.getAttribute(name))
  const centers = new Float32Array(64 * 3),
    sizes = new Float32Array(64)
  const ca = new THREE.InstancedBufferAttribute(centers, 3).setUsage(THREE.DynamicDrawUsage)
  const sa = new THREE.InstancedBufferAttribute(sizes, 1).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('iLamp', ca)
  geometry.setAttribute('iLampSize', sa)
  geometry.instanceCount = 0
  const center = attribute<'vec3'>('iLamp', 'vec3'),
    size = attribute<'float'>('iLampSize', 'float')
  const h = positionGeometry.y.sub(0.5).mul(size).add(center.z)
  const material = new THREE.MeshBasicNodeMaterial()
  material.positionNode = vec3(
    center.x.add(positionGeometry.x.mul(size)),
    h.mul(Math.cos(PITCH)).add(0.003),
    center.y.sub(h.mul(Math.sin(PITCH))),
  )
  const radius = uv().sub(0.5).length().mul(2)
  const halo = smoothstep(float(0), float(1), radius).oneMinus().pow(2)
  const core = smoothstep(float(0.05), float(0.22), radius).oneMinus()
  material.colorNode = vec4(
    vec3(1, 0.53, 0.16).add(vec3(0.1, 0.25, 0.32).mul(core)),
    halo.add(core.mul(0.45)).mul(frame.lampAmount).mul(0.75),
  )
  material.transparent = true
  material.blending = THREE.AdditiveBlending
  material.depthWrite = false
  material.depthTest = true
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 13
  mesh.name = 'night-lanterns'
  return {
    mesh,
    update(px: number, py: number) {
      mesh.visible = frame.lampAmount.value > 0.001
      let count = 0
      if (spec)
        for (const p of emitters) {
          const dx = delta(px, p.x),
            dy = delta(py, p.y)
          if (dx * dx + dy * dy > 45 * 45 || count === 64) continue
          centers[count * 3] = px + dx + p.width * 0.23
          centers[count * 3 + 1] = py + dy
          centers[count * 3 + 2] = (p.width / Math.max(0.2, spec.wFrac)) * spec.hFrac * 0.7
          sizes[count] = p.width * 1.15
          count++
        }
      geometry.instanceCount = count
      ca.needsUpdate = true
      sa.needsUpdate = true
    },
    dispose() {
      geometry.dispose()
      quad.dispose()
      material.dispose()
    },
  }
}
