/** Playable visual benchmark: no backdrop image, all objects use the production pipeline. */
import { createEmptyGrid, Surface, Flag, Decor, gridIndex } from './grid'
import { stampTowns, type SettlementParams } from './settlement'
import { buildReferenceTown } from './referenceTown'
import { hashTile01 } from './rng'
import { dressReferenceTowns } from './townLandscape'
import { buildRegionMap } from '../navigation/regions'

export function createReferenceFixture() {
  const grid = createEmptyGrid('reference-town-v6', 'torus-4', 0)
  grid.flags.fill(Flag.Walkable)
  grid.region.fill(1)
  grid.mainRegion = 1
  grid.flow = new Int8Array(512 * 512)
  const river = (y: number) => 54 + 0.8 * Math.cos((y - 54) * 0.3) + Math.max(0, y - 68) * 0.85
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      const i = y * 512 + x,
        d = Math.abs(x + 0.5 - river(y + 0.5)),
        j = hashTile01(836, x, y)
      if (d < 1.2) {
        grid.surface[i] = Surface.DeepWater
        grid.flags[i] = 0
      } else if (d < 1.65) {
        grid.surface[i] = Surface.ShallowWater
        grid.flags[i] = 0
      } else if (d < 2.4) {
        grid.surface[i] = Surface.Sand
        grid.flags[i] = grid.flags[i]! | Flag.RiverBank
      } else if ((x < 57 || x > 79 || y < 53 || y > 76) && j > 0.62) {
        grid.decor[i] = j > 0.9 ? Decor.TreeBroad : j > 0.78 ? Decor.Bush : Decor.Flower
      }
      grid.flow[i] = 2
    }
  const dry = (x: number, y: number) => {
    const s = grid.surface[gridIndex(x, y)]
    return s !== Surface.ShallowWater && s !== Surface.DeepWater
  }
  const town = {
    id: 'reference-town',
    name: '溪畔镇',
    ...buildReferenceTown(
      1,
      0,
      0,
      65,
      63,
      24,
      { fieldDensity: 1 } as SettlementParams,
      dry,
      () => true,
    ),
  }
  grid.towns = [town]
  const masks = stampTowns(grid.towns)
  for (let i = 0; i < grid.flags.length; i++) {
    if (masks.parcel[i]) {
      grid.surface[i] = Surface.Grass
      grid.flags[i] = grid.flags[i]! | Flag.Parcel | Flag.Town
      grid.decor[i] = 0
    }
    if (masks.farm[i]) {
      grid.surface[i] = Surface.Tilled
      grid.flags[i] = grid.flags[i]! | Flag.Farmland
      grid.decor[i] = 0
    }
  }
  for (const [cells, stone] of [
    [town.paths, false],
    [town.plaza, true],
  ] as const)
    for (let k = 0; k < cells.length; k += 2) {
      const i = gridIndex(cells[k]!, cells[k + 1]!)
      grid.surface[i] = stone ? Surface.Cobble : Surface.Dirt
      grid.flags[i] = Flag.Walkable | Flag.Road | Flag.Town | (stone ? Flag.Plaza : 0)
      grid.decor[i] = 0
    }
  for (let i = 0; i < grid.flags.length; i++) {
    if (masks.building[i]) {
      grid.surface[i] = Surface.Grass
      grid.flags[i] = Flag.Building | Flag.Town
      grid.decor[i] = 0
    }
    if (masks.boundary[i]) grid.flags[i] = (grid.flags[i]! | Flag.Boundary) & ~Flag.Walkable
  }
  // The bridge lands directly on the west stone street. Separate rails sort around the player.
  for (let y = 66; y < 68; y++)
    for (let x = 52; x < 56; x++) {
      const i = gridIndex(x, y)
      grid.flags[i] = Flag.Bridge | Flag.Road | Flag.Walkable
      grid.surface[i] = Surface.Dirt
      grid.decor[i] = 0
    }
  grid.bridges = [
    {
      cells: Int32Array.from(
        Array.from({ length: 8 }, (_, k) => [52 + (k % 4), 66 + Math.floor(k / 4)]).flat(),
      ),
      span: 4,
    },
  ]
  dressReferenceTowns(grid)
  const regions = buildRegionMap((x, y) => ({
    biome: 'wild',
    height: 0,
    bridge: !!(grid.flags[gridIndex(x, y)]! & Flag.Bridge),
    walkable: !!(grid.flags[gridIndex(x, y)]! & Flag.Walkable),
  }))
  grid.region.set(regions.labels)
  grid.mainRegion = regions.mainLabel
  grid.spawn = [65, 66]
  return grid
}
