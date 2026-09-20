/** Seeded planted margins around compact town blocks; roads and entrances remain clear. */
import { delta, wrapTile } from '../core/torus'
import { Decor, Flag, Surface, gridIndex, type WorldGrid } from './grid'
import { hashTile01, seedOf } from './rng'
import { spaceTrees } from './treeSpacing'

export function dressReferenceTowns(grid: WorldGrid): void {
  const seed = seedOf(grid.seed)
  for (const town of grid.towns)
    for (let dy = -17; dy <= 17; dy++)
      for (let dx = -18; dx <= 18; dx++) {
        const x = wrapTile(town.cx + dx),
          y = wrapTile(town.cy + dy),
          i = gridIndex(x, y),
          f = grid.flags[i]!
        if (f & (Flag.Road | Flag.Building | Flag.Farmland | Flag.Boundary | Flag.Bridge)) continue
        if (grid.surface[i] === Surface.ShallowWater || grid.surface[i] === Surface.DeepWater)
          continue
        let nearHouse = false,
          nearRoad = false
        for (const b of town.buildings) {
          const bx = delta(b.x, x),
            by = delta(b.y, y)
          if (bx >= -2 && bx < b.w + 2 && by >= -2 && by < b.h + 3) {
            nearHouse = true
            break
          }
        }
        for (let yy = -1; yy <= 1; yy++)
          for (let xx = -1; xx <= 1; xx++)
            if (grid.flags[gridIndex(x + xx, y + yy)]! & Flag.Road) nearRoad = true
        for (let yy = -3; yy <= 3; yy++)
          for (let xx = -3; xx <= 3; xx++)
            if (grid.flags[gridIndex(x + xx, y + yy)]! & Flag.Bridge) nearRoad = true
        if (nearRoad && grid.decor[i] === Decor.TreeBroad) {
          grid.decor[i] = Decor.None
          grid.flags[i] = grid.flags[i]! | Flag.Walkable
        }
        const r = hashTile01(seed ^ 0x3c87, x, y)
        const clump = hashTile01(seed ^ 0x7581, Math.floor(x / 3), Math.floor(y / 3))
        const outer = dy < -6 || dy > 10 || dx < -9 || dx > 11
        if (
          !nearHouse &&
          !nearRoad &&
          !(f & Flag.Parcel) &&
          clump > 0.24 &&
          r < (outer ? 0.22 : 0.08)
        ) {
          grid.decor[i] = Decor.TreeBroad
          grid.flags[i] = f & ~Flag.Walkable
        } else if (grid.decor[i] === Decor.None) {
          if (r < 0.11) grid.decor[i] = Decor.Bush
          else if (r < 0.27) grid.decor[i] = Decor.Flower
          else if (r < 0.36) grid.decor[i] = Decor.TallGrass
        }
      }
  spaceTrees(grid)
}
