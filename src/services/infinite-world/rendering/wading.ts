import { WORLD_SIZE } from '../core/constants'
import { Flag, gridIndex, type WorldGrid } from '../generation/grid'
import { CONTOUR_RANGE } from './contourField'

/** Sample the exact water contour texture used by the shader, including its half-texel offset. */
export function wadingDepth(
  grid: WorldGrid,
  pixels: Uint8Array,
  size: number,
  x: number,
  y: number,
): number {
  if (grid.flags[gridIndex(x, y)]! & Flag.Bridge) return 0
  const sx = (x / WORLD_SIZE) * size - 0.5,
    sy = (y / WORLD_SIZE) * size - 0.5
  const ix = Math.floor(sx),
    iy = Math.floor(sy),
    tx = sx - ix,
    ty = sy - iy
  const at = (xx: number, yy: number) =>
    pixels[((((yy % size) + size) % size) * size + (((xx % size) + size) % size)) * 4 + 3]! / 255
  const v =
    (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) +
    (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty
  const distance = (v - 0.5) * 2 * CONTOUR_RANGE
  return Math.max(0, Math.min(1, (distance + 0.22) / 0.85)) * 0.28
}

export function movementSpeed(grid: WorldGrid, x: number, y: number, depth: number): number {
  const i = gridIndex(x, y)
  if (grid.flags[i]! & Flag.Bridge) return 3.2
  // Terrain IDs describe the unsmoothed navigation grid. Marsh is rendered as
  // grass, and narrow water cells can disappear when the shoreline is rounded.
  // Slow down only where the same visible water contour actually covers the feet.
  return depth > 0.07 ? 1.7 : 3.2
}
