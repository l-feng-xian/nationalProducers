/** Continuous world contours. Logical tiles remain unchanged for navigation and saved edits. */
import { WORLD_SIZE } from '../core/constants'
import { LAYERS, type LayerId } from '../grid/dualGrid'
import type { WorldGrid } from '../generation/grid'
import { delta } from '../core/torus'
import { pavingDistance } from '../generation/referenceTown'

export const CONTOUR_SCALE = 2
export const CONTOUR_RANGE = 4
export const CONTOUR_LAYERS: readonly LayerId[] = ['cobble', 'dirt', 'bank', 'water']

/** Exact squared Euclidean distance to a set on a torus, in O(size²). */
export function periodicDistance(mask: Uint8Array, target: number, size: number): Float32Array {
  const length = size * 3
  const input = new Float64Array(length)
  const output = new Float64Array(length)
  const sites = new Int32Array(length)
  const bounds = new Float64Array(length + 1)
  const horizontal = new Float32Array(size * size)
  const result = new Float32Array(size * size)
  const far = size * size * 16
  const transform = () => {
    let k = 0
    sites[0] = 0
    bounds[0] = -Infinity
    bounds[1] = Infinity
    for (let q = 1; q < length; q++) {
      let v = sites[k]!
      let split = (input[q]! + q * q - input[v]! - v * v) / (2 * (q - v))
      while (split <= bounds[k]!) {
        v = sites[--k]!
        split = (input[q]! + q * q - input[v]! - v * v) / (2 * (q - v))
      }
      sites[++k] = q
      bounds[k] = split
      bounds[k + 1] = Infinity
    }
    k = 0
    for (let q = 0; q < length; q++) {
      while (bounds[k + 1]! < q) k++
      const v = sites[k]!
      output[q] = (q - v) ** 2 + input[v]!
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < length; x++) input[x] = mask[y * size + (x % size)] === target ? 0 : far
    transform()
    for (let x = 0; x < size; x++) horizontal[y * size + x] = output[x + size]!
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < length; y++) input[y] = horizontal[(y % size) * size + x]!
    transform()
    for (let y = 0; y < size; y++) result[y * size + x] = output[y + size]!
  }
  return result
}

export function smoothDistance(mask: Uint8Array, size: number): Float32Array {
  const inside = periodicDistance(mask, 0, size)
  const outside = periodicDistance(mask, 1, size)
  const field = new Float32Array(mask.length)
  for (let i = 0; i < field.length; i++) {
    field[i] = Math.max(
      -CONTOUR_RANGE,
      Math.min(CONTOUR_RANGE, mask[i] ? Math.sqrt(inside[i]!) - 0.5 : 0.5 - Math.sqrt(outside[i]!)),
    )
  }
  // A compact separable kernel rounds the contour itself, instead of blurring a tile's alpha.
  const kernel = [0.06, 0.24, 0.4, 0.24, 0.06]
  const temp = new Float32Array(field.length)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let k = -2; k <= 2; k++)
        sum += field[y * size + ((x + k + size) % size)]! * kernel[k + 2]!
      temp[y * size + x] = sum
    }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let k = -2; k <= 2; k++)
        sum += temp[((y + k + size) % size) * size + x]! * kernel[k + 2]!
      field[y * size + x] = sum
    }
  return field
}

/** Catmull-Rom reconstruction is baked once; fragment shaders need only one linear sample. */
export function sampleContour(field: Float32Array, size: number, x: number, y: number): number {
  const ix = Math.floor(x),
    iy = Math.floor(y)
  const tx = x - ix,
    ty = y - iy
  const cubic = (a: number, b: number, c: number, d: number, t: number) =>
    b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)))
  const at = (xx: number, yy: number) =>
    field[(((yy % size) + size) % size) * size + (((xx % size) + size) % size)]!
  const row = (yy: number) => cubic(at(ix - 1, yy), at(ix, yy), at(ix + 1, yy), at(ix + 2, yy), tx)
  return cubic(row(iy - 1), row(iy), row(iy + 1), row(iy + 2), ty)
}

export function buildContourPixels(grid: WorldGrid): { data: Uint8Array; size: number } {
  const size = WORLD_SIZE * CONTOUR_SCALE
  const data = new Uint8Array(size * size * 4)
  for (let ch = 0; ch < CONTOUR_LAYERS.length; ch++) {
    const def = LAYERS.find((d) => d.id === CONTOUR_LAYERS[ch])!
    const mask = new Uint8Array(WORLD_SIZE * WORLD_SIZE)
    for (let i = 0; i < mask.length; i++) mask[i] = Number(def.test(grid, i))
    const field = smoothDistance(mask, WORLD_SIZE)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        // Source samples live at logical tile centers (x+0.5), not at display-grid vertices.
        let value = sampleContour(
          field,
          WORLD_SIZE,
          (x + 0.5) / CONTOUR_SCALE - 0.5,
          (y + 0.5) / CONTOUR_SCALE - 0.5,
        )
        if (ch === 0 && grid.generatorVersion === 'torus-4') {
          const wx = (x + 0.5) / CONTOUR_SCALE,
            wy = (y + 0.5) / CONTOUR_SCALE
          for (const town of grid.towns) {
            if (Math.abs(delta(town.cx, wx)) > 18 || Math.abs(delta(town.cy, wy)) > 14) continue
            // Paved squares retain straight edges and small corner bevels. Union streets
            // from the same polygons used by layout, instead of rounding a tile mask.
            let paved = -CONTOUR_RANGE
            for (const rect of town.paving ?? []) {
              paved = Math.max(paved, pavingDistance(rect, wx, wy))
            }
            value = paved
          }
        }
        data[(y * size + x) * 4 + ch] = Math.round(
          Math.max(0, Math.min(1, 0.5 + value / (2 * CONTOUR_RANGE))) * 255,
        )
      }
  }
  return { data, size }
}
