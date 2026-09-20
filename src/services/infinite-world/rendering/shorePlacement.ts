import { WORLD_SIZE } from '../core/constants'
import { LAYERS } from '../grid/dualGrid'
import type { WorldGrid } from '../generation/grid'
import { sampleContour, smoothDistance } from './contourField'

const cache = new WeakMap<WorldGrid, Float32Array>()
/** The same signed distance used by the water shader places stone roots and grass edges. */
export function shoreRoot(grid: WorldGrid, x: number, y: number) {
  let field = cache.get(grid)
  if (!field) {
    const mask = new Uint8Array(WORLD_SIZE * WORLD_SIZE),
      water = LAYERS.find((l) => l.id === 'water')!
    for (let i = 0; i < mask.length; i++) mask[i] = Number(water.test(grid, i))
    field = smoothDistance(mask, WORLD_SIZE)
    cache.set(grid, field)
  }
  const at = (xx: number, yy: number) => sampleContour(field!, WORLD_SIZE, xx - 0.5, yy - 0.5)
  let px = x + 0.5,
    py = y + 0.5,
    nx = 0,
    ny = 0
  for (let k = 0; k < 4; k++) {
    const gx = (at(px + 0.12, py) - at(px - 0.12, py)) / 0.24,
      gy = (at(px, py + 0.12) - at(px, py - 0.12)) / 0.24
    const length = Math.hypot(gx, gy)
    if (length < 0.1) return null
    nx = gx / length
    ny = gy / length
    const step = Math.max(-0.7, Math.min(0.7, (at(px, py) + 0.2) / length))
    px -= nx * step
    py -= ny * step
  }
  return { x: px, y: py, nx, ny }
}
