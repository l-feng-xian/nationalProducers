import * as THREE from 'three/webgpu'
import { WORLD_SIZE } from '../core/constants'
import type { WorldGrid } from '../generation/grid'

export interface TownLight {
  x: number
  y: number
  radius: number
  strength: number
}
export function townLights(grid: WorldGrid): TownLight[] {
  return grid.towns.flatMap((town) => [
    ...(town.props ?? [])
      .filter((p) => p.frame === 'town-lamp')
      .map((p) => ({ x: p.x, y: p.y, radius: 3.3, strength: 1 })),
    ...town.buildings
      .filter((b) => b.kind !== 'well')
      .map((b) => ({
        x: b.door ? b.door[0] + 0.5 : b.x + b.w / 2,
        y: b.y + b.h - 0.15,
        radius: 2.2,
        strength: 0.38,
      })),
  ])
}
/** Local illumination is baked once on the torus; the shared clock fades it at dawn. */
export function nightLightPixels(lights: readonly TownLight[], size = WORLD_SIZE * 2) {
  const pixels = new Uint8Array(size * size * 4)
  const scale = size / WORLD_SIZE
  for (const light of lights) {
    const r = light.radius * scale,
      cx = light.x * scale,
      cy = light.y * scale
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2) / (r * r)
        if (d >= 1) continue
        const i = ((((y % size) + size) % size) * size + (((x % size) + size) % size)) * 4
        const value = Math.round((1 - d) ** 2 * light.strength * 255)
        if (value > pixels[i]!) {
          pixels[i] = value
          // Direction to the dominant lamp and its radius for per-pixel sprite lighting.
          pixels[i + 1] = Math.round((((cx - x - 0.5) / r) * 0.5 + 0.5) * 255)
          pixels[i + 2] = Math.round((((cy - y - 0.5) / r) * 0.5 + 0.5) * 255)
          pixels[i + 3] = Math.round((light.radius / 8) * 255)
        }
      }
  }
  return pixels
}
export function createNightLightField(grid: WorldGrid) {
  const size = WORLD_SIZE * 2
  const texture = new THREE.DataTexture(
    nightLightPixels(townLights(grid), size),
    size,
    size,
    THREE.RGBAFormat,
  )
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
