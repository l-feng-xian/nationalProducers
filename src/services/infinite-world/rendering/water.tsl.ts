/** Painterly water: translucent shallows, broken shoreline ripples and slow surface streaks. */
import * as THREE from 'three/webgpu'
import {
  add,
  float,
  mix,
  mx_noise_float,
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
import { WORLD_SIZE } from '../core/constants'
import { LAYER_STEP, attr, worldLighting, type ShaderNode } from './ground.tsl'
import { CONTOUR_RANGE } from './contourField'
import type { FrameUniforms } from './frame.tsl'
import type { GroundTextures } from './groundTextures'

const REFLECTION = new THREE.Color('#a9c3ba')
const FOAM = new THREE.Color('#d0ded0')

export interface WaterMaterialOptions {
  contours: THREE.Texture
  flow: THREE.Texture
  ground: GroundTextures
  frame: FrameUniforms
  order: number
}

export function createWaterMaterial(o: WaterMaterialOptions): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial()
  const offset = attr('iOffset', 'vec2')
  mat.positionNode = vec3(
    positionGeometry.x.add(offset.x),
    float(o.order * LAYER_STEP),
    positionGeometry.z.add(offset.y),
  )
  const world = uv().sub(0.5).add(offset)
  const w = world as unknown as ShaderNode
  const origin = o.frame.noiseOrigin as unknown as ShaderNode
  const x = add(w.x, origin.x)
  const y = add(w.y, origin.y)
  const time = o.frame.windTime
  const fieldDistance = texture(o.contours, world.mul(1 / WORLD_SIZE))
    .a.sub(0.5)
    .mul(2 * CONTOUR_RANGE)
  const edgeNoise = mx_noise_float(vec3(x.mul(6), y.mul(6), float(0)))
  const edge = fieldDistance.add(edgeNoise.mul(0.06))
  const coverage = smoothstep(float(-0.22), float(0.04), edge)
  const distance = fieldDistance.add(0.28)
  const depth = smoothstep(float(0.15), float(5), distance)

  // Long, broken brush marks rather than isotropic boiling noise.
  const slow = mx_noise_float(
    vec3(x.mul(0.3).add(time.mul(0.035)), y.mul(0.55).sub(time.mul(0.045)), float(0)),
  )
  const detail = mx_noise_float(
    vec3(x.mul(1.8).add(time.mul(0.06)), y.mul(5).sub(time.mul(0.12)), float(2)),
  )
  const flow = texture(o.flow, world.mul(1 / WORLD_SIZE))
    .rg.sub(0.5)
    .mul(2)
  // Two short phase loops advect the painted water along the local hydrology vector.
  // Crossfade at the reset; accumulated time must never distort neighbouring flow cells.
  const phase = time.mul(0.018).fract()
  const phase2 = phase.add(0.5).fract()
  const waterUv = world.mul(0.25)
  const drift = vec2(flow.x, flow.y).mul(0.24)
  const first = texture(o.ground.array, waterUv.sub(drift.mul(phase))).depth(
    float(o.ground.palette.indexOf('water-shallow')),
  ).rgb
  const second = texture(
    o.ground.array,
    waterUv.sub(drift.mul(phase2)).add(vec2(0.37, 0.19)),
  ).depth(float(o.ground.palette.indexOf('water-shallow'))).rgb
  const painted = mix(mix(first, second, phase.mul(2).sub(1).abs()), vec3(0.135, 0.265, 0.27), 0.4)
  const strokes = smoothstep(float(0.32), float(0.65), detail).mul(0.1)
  const broadReflection = smoothstep(float(0.05), float(0.6), slow).mul(0.16)
  let color = mix(painted.mul(vec3(1.12, 1.1, 0.99)), painted.mul(vec3(0.8, 0.94, 0.98)), depth)
  color = color.mul(add(float(1), slow.mul(0.065)))
  color = mix(
    color,
    vec3(REFLECTION.r, REFLECTION.g, REFLECTION.b),
    broadReflection.add(strokes.mul(0.25)).mul(o.frame.sunAmount),
  )

  // Narrow, discontinuous wavelets follow the actual shore, including narrow streams.
  const shoreBand = sub(float(1), smoothstep(float(0.15), float(1.35), distance)).mul(
    smoothstep(float(-0.1), float(0.25), distance),
  )
  const shoreWave = sin(distance.mul(15).sub(time.mul(1.65)).add(slow.mul(3)))
  const crest = smoothstep(float(0.88), float(0.99), shoreWave)
  const broken = smoothstep(float(-0.05), float(0.4), detail)
  const foam = shoreBand.mul(crest).mul(broken).mul(0.3)
  color = mix(color, vec3(FOAM.r, FOAM.g, FOAM.b), foam)

  // Reveal the wet river bed near the edge, without a continuous white or dark outline.
  const opacity = coverage.mul(
    mix(float(0.68), float(0.98), smoothstep(float(-0.1), float(1.6), distance)),
  )
  mat.colorNode = vec4(
    (color as unknown as ShaderNode).mul(worldLighting(w.x, w.y, o.frame)),
    opacity,
  )
  mat.transparent = true
  mat.depthWrite = false
  mat.depthTest = true
  mat.side = THREE.FrontSide
  return mat
}
