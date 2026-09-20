import * as THREE from 'three/webgpu'
import {
  attribute,
  float,
  mix,
  mx_noise_float,
  positionGeometry,
  sin,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { worldLighting } from './ground.tsl'
import type { FrameUniforms } from './frame.tsl'
import type { GroundTextures } from './groundTextures'
import type { PlotKind } from './plotBuild'

/** Analytic soil edges and directional furrow lighting, independent of texture repeat. */
export function createPlotMaterial(kind: PlotKind, ground: GroundTextures, frame: FrameUniforms) {
  const mat = new THREE.MeshBasicNodeMaterial()
  const center = attribute<'vec2'>('iCenter', 'vec2'),
    size = attribute<'vec2'>('iExtent', 'vec2')
  const angle = attribute<'float'>('iAngle', 'float')
  const cosine = angle.cos(),
    sine = angle.sin()
  // A margin outside the footprint contains feathered edges and the shallow soil bank.
  const extent = size.add(0.6)
  const local = uv().sub(0.5).mul(vec2(extent.x, extent.y))
  const world = vec2(
    local.x.mul(cosine).sub(local.y.mul(sine)),
    local.x.mul(sine).add(local.y.mul(cosine)),
  ).add(vec2(center.x, center.y))
  const px = positionGeometry.x.mul(extent.x),
    pz = positionGeometry.z.mul(extent.y)
  mat.positionNode = vec3(
    px.mul(cosine).sub(pz.mul(sine)).add(center.x),
    float(
      kind.startsWith('bridge')
        ? 0.055
        : kind === 'yard'
          ? 0.03
          : kind === 'bed'
            ? 0.034
            : kind === 'stone' || kind === 'step'
              ? 0.04
              : 0.044,
    ),
    px.mul(sine).add(pz.mul(cosine)).add(center.y),
  )
  const radius =
    kind === 'stone' ? 0.035 : kind === 'step' ? 0.115 : kind.startsWith('bridge') ? 0.025 : 0.18
  const q = local.abs().sub(vec2(size.x, size.y).mul(0.5).sub(radius))
  const distance = q.max(0).length().add(q.x.max(q.y).min(0)).sub(radius)
  const grain = mx_noise_float(vec3(world.x.mul(18), world.y.mul(18), 2))
  const coarse = mx_noise_float(vec3(world.x.mul(3), world.y.mul(3), 4))
  let alpha = smoothstep(
    float(-0.12),
    float(0.13),
    distance.add(coarse.mul(0.07)).add(grain.mul(0.025)),
  ).oneMinus()
  let col = texture(ground.array, world.mul(0.2)).depth(
    float(ground.palette.indexOf('dirt-path')),
  ).rgb
  if (kind === 'yard') {
    alpha = smoothstep(float(-0.55), float(0.2), distance.add(coarse.mul(0.14)))
      .oneMinus()
      .mul(0.65)
    col = col.mul(0.92)
  } else if (kind === 'bed') {
    // Match the plant columns, including their inset and sub-cell spacing.
    const columnStep = size.x.sub(0.3).div(size.x.sub(0.24).div(0.44).floor().max(1))
    const phase = local.x
      .add(size.x.mul(0.5))
      .sub(0.15)
      .div(columnStep)
      .sub(0.5)
      .mul(Math.PI * 2)
      .add(coarse.mul(0.12))
    const crown = phase.cos().mul(0.5).add(0.5)
    const relief = crown.pow(0.7).mul(0.5).add(sin(phase).mul(0.26)).add(0.48)
    const earth = texture(ground.array, world.mul(0.42)).depth(
      float(ground.palette.indexOf('soil-tilled')),
    ).rgb
    col = earth.mul(relief).mul(grain.mul(0.2).add(1))
    const bank = smoothstep(float(-0.34), float(-0.03), distance)
    const bankLight = local.y.div(size.y).mul(-0.65).sub(local.x.div(size.x).mul(0.2)).add(0.87)
    col = mix(col, earth.mul(bankLight), bank.mul(0.9))
  } else if (kind.startsWith('shadow')) {
    const ellipse = local.div(vec2(size.x, size.y).mul(0.5)).length()
    alpha =
      kind === 'shadow-building'
        ? smoothstep(float(-0.16), float(0.2), distance).oneMinus().mul(0.24)
        : kind === 'shadow-canopy'
          ? smoothstep(float(0.4), float(1.12), ellipse.add(coarse.mul(0.16)))
              .oneMinus()
              .mul(0.28)
          : smoothstep(float(0.12), float(1.12), ellipse).oneMinus().mul(0.46)
    col = vec3(0.055, 0.069, 0.039)
  } else if (kind.startsWith('bridge')) {
    const across = kind === 'bridge-x' ? local.x : local.y
    const along = kind === 'bridge-x' ? local.y : local.x
    const plank = across.add(size.x).mul(4.6).fract()
    const joint = smoothstep(float(0.02), float(0.085), plank).mul(
      smoothstep(float(0.91), float(0.99), plank).oneMinus(),
    )
    const grainWood = mx_noise_float(vec3(across.mul(9), along.mul(0.9), 1))
    const wood = texture(ground.array, world.mul(0.16)).depth(
      float(ground.palette.indexOf('dirt-path')),
    ).rgb
    col = wood
      .mul(vec3(0.77, 0.75, 0.69))
      .mul(grainWood.mul(0.22).add(0.91))
      .mul(joint.mul(0.4).add(0.6))
    alpha = smoothstep(float(-0.035), float(0.015), distance).oneMinus()
  } else {
    alpha = smoothstep(
      float(-0.025),
      float(0.018),
      distance.add(grain.mul(kind === 'step' ? 0.025 : 0.008)),
    ).oneMinus()
    const bevel = smoothstep(float(-0.055), float(-0.015), distance)
    col = vec3(0.4, 0.365, 0.28)
      .mul(grain.mul(0.16).add(1))
      .mul(mix(float(1.1), float(0.65), bevel))
  }
  // Contact occlusion remains at night, while solar silhouettes fade separately.
  if (kind.startsWith('shadow')) alpha = alpha.mul(frame.sunAmount.mul(.45).add(.55))
  mat.colorNode = vec4(col.mul(worldLighting(world.x, world.y, frame)), alpha)
  mat.transparent = true
  mat.depthWrite = false
  mat.depthTest = true
  return mat
}
