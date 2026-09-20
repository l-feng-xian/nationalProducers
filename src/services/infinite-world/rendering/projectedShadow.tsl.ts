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
import { WORLD_SIZE } from '../core/constants'
import { SPRITE_FOOT_V } from './spriteAtlas'
import { cloudShadow } from './ground.tsl'
import type { FrameUniforms } from './frame.tsl'

/** Flatten the actual animated alpha silhouette onto the terrain, anchored at its foot. */
export function createProjectedShadowMaterial(atlas: THREE.DataArrayTexture, frame: FrameUniforms) {
  const material = new THREE.MeshBasicNodeMaterial()
  const foot = attribute<'vec2'>('iFoot', 'vec2'),
    size = attribute<'float'>('iSize', 'float')
  const layer = attribute<'float'>('iLayer', 'float'),
    flip = attribute<'float'>('iFlip', 'float')
  const sway = attribute<'float'>('iSway', 'float')
  const height = positionGeometry.y
    .sub(1 - SPRITE_FOOT_V)
    .mul(size)
    .max(0)
  const wind = foot.x
    .mul((2 * Math.PI * 5) / WORLD_SIZE)
    .add(foot.y.mul((2 * Math.PI * 3) / WORLD_SIZE))
    .add(frame.windTime.mul(1.1))
    .sin()
    .mul(sway)
    .mul(height)
    .mul(0.16)
  material.positionNode = vec3(
    foot.x.add(positionGeometry.x.mul(size)).add(wind).add(height.mul(frame.shadowVector.x)),
    float(0.066),
    foot.y.add(height.mul(frame.shadowVector.y)),
  )
  const st = vec2(mix(uv().x, uv().x.oneMinus(), flip), uv().y)
  // A small cross filter softens the silhouette without an extra offscreen render.
  const sample = (x: number, y: number) => texture(atlas, st.add(vec2(x, y))).depth(layer).a
  const edge = 1.5 / atlas.image.width
  const coverage = sample(0, 0)
    .mul(0.4)
    .add(sample(edge, 0).mul(0.15))
    .add(sample(-edge, 0).mul(0.15))
    .add(sample(0, edge).mul(0.15))
    .add(sample(0, -edge).mul(0.15))
  const alpha = smoothstep(float(0.06), float(0.86), coverage)
    .mul(frame.shadowOpacity)
    .mul(cloudShadow(foot.x, foot.y, frame))
  material.colorNode = vec4(vec3(0.035, 0.05, 0.085), alpha)
  material.transparent = true
  material.depthWrite = false
  material.depthTest = true
  material.side = THREE.DoubleSide
  material.userData.shadowAtlas = atlas
  return material
}

/** Reuse sprite attributes so every animated pose, flip and step moves its shadow too. */
export function projectedShadowMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.MeshBasicNodeMaterial,
) {
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'sun-shadow'
  mesh.frustumCulled = false
  mesh.matrixAutoUpdate = false
  mesh.renderOrder = 12
  mesh.updateMatrix()
  return mesh
}
