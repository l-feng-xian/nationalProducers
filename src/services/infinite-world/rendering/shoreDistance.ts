import { WORLD_SIZE } from '../core/constants'
import { Surface } from '../generation/grid'

/** Signed distance in tiles, positive in water. Capped to keep RGBA8 precision near shore. */
export const SHORE_RANGE = 8

export function shoreDistance(surface: Uint8Array, size = WORLD_SIZE): Float32Array {
  const count = size * size
  const wet = new Uint8Array(count)
  const distance = new Float32Array(count).fill(SHORE_RANGE)
  const queue = new Int32Array(count)
  let head = 0
  let tail = 0
  for (let i = 0; i < count; i++) {
    wet[i] = Number(surface[i] === Surface.ShallowWater || surface[i] === Surface.DeepWater)
  }
  const neighbours = (i: number): [number, number, number, number] => {
    const x = i % size
    const y = Math.floor(i / size)
    return [
      y * size + ((x + size - 1) % size),
      y * size + ((x + 1) % size),
      ((y + size - 1) % size) * size + x,
      ((y + 1) % size) * size + x,
    ]
  }
  // Both sides start half a tile from the boundary. Multi-source BFS wraps across the torus.
  for (let i = 0; i < count; i++) {
    if (neighbours(i).some((j) => wet[j] !== wet[i])) {
      distance[i] = 0.5
      queue[tail++] = i
    }
  }
  while (head < tail) {
    const i = queue[head++]!
    const next = distance[i]! + 1
    if (next >= SHORE_RANGE) continue
    for (const j of neighbours(i)) {
      if (wet[j] !== wet[i] || distance[j]! <= next) continue
      distance[j] = next
      queue[tail++] = j
    }
  }
  for (let i = 0; i < count; i++) if (!wet[i]) distance[i] = -distance[i]!
  return distance
}
