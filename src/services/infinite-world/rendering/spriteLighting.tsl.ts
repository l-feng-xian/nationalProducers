import * as THREE from 'three/webgpu'
import type { Node } from 'three/webgpu'
import { float, mix, smoothstep, texture, vec2, vec3 } from 'three/tsl'
import { WORLD_SIZE } from '../core/constants'
import { cloudShadow } from './ground.tsl'
import type { FrameUniforms } from './frame.tsl'

export const SHADOW_HEIGHT_RANGE = 16
/** Stable identity across chunk mirrors; prevents a sprite receiving its own flat-card shadow. */
export function shadowIdentity(foot: Node<'vec2'>) {
  const p = foot.mod(WORLD_SIZE).add(WORLD_SIZE).mod(WORLD_SIZE)
  return vec2(
    p.x.mul(0.1031).add(p.y.mul(0.11369)).fract(),
    p.x.mul(0.1733).add(p.y.mul(0.13787)).fract(),
  )
    .mul(0.9)
    .add(0.05)
}

export function receivedSpriteShadow(
  foot: Node<'vec2'>,
  x: Node<'float'>,
  height: Node<'float'>,
  frame: FrameUniforms,
) {
  const projection = vec2(x, foot.y).add(frame.shadowVector.mul(height))
  const local = projection
    .sub(frame.shadowCenter)
    .add(WORLD_SIZE / 2)
    .mod(WORLD_SIZE)
    .sub(WORLD_SIZE / 2)
  const st = vec2(
    local.x.div(frame.shadowSpan.x).add(0.5),
    // TSL uses top-left texture coordinates and flips render targets on WebGL itself.
    // Camera up is -Z, so increasing world Z moves down the image on both backends.
    local.y.div(frame.shadowSpan.y).add(0.5),
  )
  const id = shadowIdentity(foot)
  const edge = st.sub(0.5).abs()
  const inside = smoothstep(float(0.48), float(0.5), edge.x.max(edge.y)).oneMinus()
  const tap = (dx: number, dy: number) => {
    const blocker = texture(frame.objectShadowMap, st.add(vec2(dx, dy)))
    const other = smoothstep(float(0.008), float(0.018), blocker.gb.sub(id).abs().length())
    return smoothstep(height.add(0.09), height.add(0.24), blocker.r.mul(SHADOW_HEIGHT_RANGE)).mul(
      other,
    )
  }
  const texel = 1 / 1024
  return tap(0, 0)
    .mul(0.4)
    .add(tap(texel, 0).mul(0.15))
    .add(tap(-texel, 0).mul(0.15))
    .add(tap(0, texel).mul(0.15))
    .add(tap(0, -texel).mul(0.15))
    .mul(inside)
    .mul(frame.receivedShadowAmount)
}

/** Surface normals, directional sunlight, other-object shadows and height-limited lantern light. */
export function spriteSurfaceLighting(
  normalAtlas: THREE.DataArrayTexture,
  st: Node<'vec2'>,
  layer: Node<'float'>,
  flip: Node<'float'>,
  foot: Node<'vec2'>,
  x: Node<'float'>,
  height: Node<'float'>,
  frame: FrameUniforms,
) {
  const encoded = texture(normalAtlas, st).depth(layer).rgb.mul(2).sub(1)
  const normal = vec3(
    encoded.x.mul(mix(float(1), float(-1), flip)),
    encoded.y,
    encoded.z,
  ).normalize()
  const sunDirection = vec3(
    frame.shadowVector.x.negate(),
    float(1),
    frame.shadowVector.y.negate(),
  ).normalize()
  const diffuse = normal.dot(sunDirection).max(0)
  const shade = receivedSpriteShadow(foot, x, height, frame)
  const sun = frame.sunAmount.mul(cloudShadow(x, foot.y, frame))
  const direct = diffuse.mul(0.68).mul(shade.oneMinus()).mul(sun)
  const ambient = float(1).sub(frame.sunAmount.mul(0.4))
  const day = frame.dayTint.mul(ambient.add(direct))
  // Sample across the actual image width, with the top slightly behind its base.
  const lamp = texture(frame.lampField, vec2(x, foot.y.sub(height.mul(0.18))).div(WORLD_SIZE))
  const reach = lamp.a.mul(8).max(0.1)
  const toLight = vec3(
    lamp.g.sub(0.5).mul(2).mul(reach),
    float(1.15).sub(height),
    lamp.b.sub(0.5).mul(2).mul(reach),
  )
  const falloff = float(1).div(height.sub(1.15).max(0).pow(2).mul(0.65).add(1))
  const incidence = normal.dot(toLight.normalize()).max(0).mul(0.75).add(0.25)
  const lampLight = vec3(0.95, 0.52, 0.19)
    .mul(lamp.r)
    .mul(frame.lampAmount)
    .mul(falloff)
    .mul(incidence)
  // Retain a tiny moonlit shape gradient without generating a second set of cast shadows.
  const moon = float(1).sub(frame.sunAmount).mul(normal.y.mul(0.08))
  return day.mul(moon.add(1)).add(lampLight)
}
