import { WORLD_SIZE } from '../core/constants'
import { Decor, Flag, Surface, gridIndex, type WorldGrid } from './grid'
import { hashTile01, seedOf } from './rng'

export function isTree(d: number): boolean {
  return d === Decor.TreeBroad || d === Decor.TreeConifer || d === Decor.TreeBirch
}

/** One global spacing pass after wild and town planting; toroidal, seeded and order-independent. */
export function spaceTrees(grid: WorldGrid): void {
  const seed = seedOf(grid.seed) ^ 0x731b
  const trees: { i: number; priority: number }[] = []
  for (let i = 0; i < grid.decor.length; i++)
    if (isTree(grid.decor[i]!))
      trees.push({ i, priority: hashTile01(seed, i % WORLD_SIZE, Math.floor(i / WORLD_SIZE)) })
  trees.sort((a, b) => a.priority - b.priority || a.i - b.i)
  const occupied = new Uint8Array(grid.decor.length)
  for (const { i } of trees) {
    const x = i % WORLD_SIZE,
      y = Math.floor(i / WORLD_SIZE)
    if (occupied[i]) {
      grid.decor[i] = Decor.None
      if (
        !(grid.flags[i]! & (Flag.Building | Flag.Boundary)) &&
        grid.surface[i] !== Surface.DeepWater
      )
        grid.flags[i] = grid.flags[i]! | Flag.Walkable
      continue
    }
    grid.flags[i] = grid.flags[i]! & ~Flag.Walkable
    // Keep trunks at least 2.4 tiles apart. Crowns can overlap a little without
    // becoming a solid repeating carpet; removed trees restore actual passage.
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++)
        if (dx * dx + dy * dy < 2.4 * 2.4) occupied[gridIndex(x + dx, y + dy)] = 1
  }
}
