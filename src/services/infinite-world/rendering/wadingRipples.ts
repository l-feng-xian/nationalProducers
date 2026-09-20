import * as THREE from 'three/webgpu'
import {
  attribute,
  float,
  mix,
  positionGeometry,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { delta, wrap } from '../core/torus'
import { WORLD_SIZE } from '../core/constants'
import { CONTOUR_RANGE } from './contourField'
import { worldLighting, createGroundQuad } from './ground.tsl'
import type { FrameUniforms } from './frame.tsl'

/** Short-lived footsteps on the water plane. Each ring stays at the footfall, not glued to the sprite. */
export function createWadingRipples(frame: FrameUniforms, contours: THREE.Texture) {
  const quad = createGroundQuad(),
    geometry = new THREE.InstancedBufferGeometry()
  geometry.index = quad.index
  for (const name of ['position', 'uv', 'normal'])
    geometry.setAttribute(name, quad.getAttribute(name))
  const positions = new Float32Array(16),
    births = new Float32Array(8).fill(-100),
    strengths = new Float32Array(8)
  const centers = new THREE.InstancedBufferAttribute(positions, 2).setUsage(THREE.DynamicDrawUsage)
  const starts = new THREE.InstancedBufferAttribute(births, 1).setUsage(THREE.DynamicDrawUsage)
  const gains = new THREE.InstancedBufferAttribute(strengths, 1).setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('iRippleCenter', centers)
  geometry.setAttribute('iRippleStart', starts)
  geometry.setAttribute('iRippleGain', gains)
  geometry.instanceCount = 8
  const center = attribute<'vec2'>('iRippleCenter', 'vec2')
  const age = frame.windTime.sub(attribute<'float'>('iRippleStart', 'float')).div(1.05)
  const gain = attribute<'float'>('iRippleGain', 'float')
  const local = uv().sub(0.5).mul(1.7),
    world = local.add(center)
  const radius = age.clamp(0, 1).mul(0.33).add(0.08)
  const dist = vec2(local.x, local.y.mul(1.65)).length().sub(radius).abs()
  const ring = smoothstep(float(0.004), float(0.025), dist).oneMinus()
  const broken = smoothstep(float(-0.45), float(0.55), local.x.mul(21).add(local.y.mul(13)).sin())
  const waterDistance = texture(contours, world.div(WORLD_SIZE))
    .a.sub(0.5)
    .mul(2 * CONTOUR_RANGE)
  const coverage = smoothstep(float(-0.2), float(0.04), waterDistance)
  const alpha = ring.mul(broken).mul(age.oneMinus().clamp(0, 1)).mul(gain).mul(coverage).mul(0.38)
  const material = new THREE.MeshBasicNodeMaterial()
  material.positionNode = vec3(
    positionGeometry.x.mul(1.7).add(center.x),
    float(0.06),
    positionGeometry.z.mul(1.7).add(center.y),
  )
  material.colorNode = vec4(
    mix(vec3(0.25, 0.43, 0.4), vec3(0.65, 0.8, 0.7), ring)
      .mul(worldLighting(world.x, world.y, frame)),
    alpha,
  )
  material.transparent = true
  material.depthWrite = false
  material.depthTest = true
  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 12
  const roots = Array.from({ length: 8 }, () => [0, 0])
  let lastX = NaN,
    lastY = NaN,
    travel = 0,
    next = 0
  return {
    mesh,
    update(x: number, y: number, depth: number) {
      const dx = Number.isFinite(lastX) ? delta(lastX, x) : 0,
        dy = Number.isFinite(lastY) ? delta(lastY, y) : 0
      const distance = Math.hypot(dx, dy)
      travel += distance
      if (depth > 0.035 && distance > 0 && travel > 0.38) {
        const side = next % 2 === 0 ? 1 : -1
        roots[next] = [
          wrap(x - (dy / distance) * 0.13 * side),
          wrap(y + (dx / distance) * 0.13 * side),
        ]
        births[next] = frame.windTime.value
        strengths[next] = Math.min(1, depth / 0.2)
        next = (next + 1) % 8
        travel = 0
        starts.needsUpdate = true
        gains.needsUpdate = true
      }
      if (depth <= 0.035) travel = 0
      lastX = x
      lastY = y
      for (let k = 0; k < 8; k++) {
        positions[k * 2] = x + delta(x, roots[k]![0]!)
        positions[k * 2 + 1] = y + delta(y, roots[k]![1]!)
      }
      centers.needsUpdate = true
    },
    dispose() {
      geometry.dispose()
      quad.dispose()
      material.dispose()
    },
  }
}
