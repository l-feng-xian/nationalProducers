import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildWorld } from '../src/services/infinite-world/generation/pipeline'
import {
  buildWorldAsync,
  buildWorldSync,
  clearWorldCache,
} from '../src/services/infinite-world/generation/worldSource'
import { Flag, gridIndex, type WorldGrid } from '../src/services/infinite-world/generation/grid'
import { isBlockingDecor } from '../src/services/infinite-world/generation/decor'
import { delta } from '../src/services/infinite-world/core/torus'
import { cropPlants } from '../src/services/infinite-world/rendering/farmCrops'

const settings = {
  waterRatio: 0.15,
  forestDensity: 0.5,
  fieldDensity: 0.5,
  season: 0,
  dayMinutes: 20,
  townDensity: 0.5,
  riverDensity: 0.5,
}
function digest(grid: WorldGrid) {
  const hash = createHash('sha256')
  for (const key of ['elevation', 'surface', 'biome', 'flags', 'decor', 'region'] as const)
    hash.update(new Uint8Array(grid[key].buffer))
  hash.update(
    JSON.stringify({
      towns: grid.towns,
      bridges: grid.bridges,
      spawn: grid.spawn,
      mainRegion: grid.mainRegion,
    }),
  )
  return hash.digest('hex')
}
// Captured from the original torus-1 implementation, before the village layout change.
for (const [seed, expected] of [
  ['world-v3-review', '2b611f5691285cfc4b29d07dabd9caf5d0a357440b66c0742f920c09cc9ddca8'],
  ['legacy-seam', '94cafd94a4fd3e5c24a533c9ec18580bf12fb03b116f1307d85d404ba1ecbac6'],
] as const) {
  const req = { seed, settings, generatorVersion: 'torus-1' }
  clearWorldCache()
  const sync = buildWorldSync(req)
  assert.equal(digest(sync), expected, 'legacy topology and decorations must stay identical')
  clearWorldCache()
  const asyncGrid = await buildWorldAsync(req)
  assert.equal(digest(asyncGrid), expected, 'async fallback honors the saved generator version')
}
assert.throws(
  () => buildWorld({ seed: 'unknown', settings, generatorVersion: 'torus-999' }),
  /Unsupported generator/,
)
for (const [seed, expected] of [
  ['world-v3-review', 'fd0d7556d6ad188665abdab5497b22582daec370328df38d0bbdc36478fb7e0e'],
  ['legacy-seam', 'a758322affc8ac0860c180cb565fe1ff93133739920f4d3c0f3a14475d6417d0'],
] as const) {
  const req = { seed, settings, generatorVersion: 'torus-2' }
  assert.equal(digest(buildWorld(req)), expected, 'v2 parcels remain unchanged')
  clearWorldCache()
  assert.equal(digest(await buildWorldAsync(req)), expected, 'v2 async dispatch remains unchanged')
}
let homes = 0
let beds = 0
for (const [seed, expected] of [
  ['world-v3-review', '5f5617116087b326d3b9f82a5b734f18d7b08e66b82b2c8d021dddd7e6ab951a'],
  ['legacy-seam', '52dd9334881f6bccea09d157e5b508247c5117763b573bdc2a10412b0db1946f'],
] as const)
  assert.equal(
    digest(buildWorld({ seed, settings, generatorVersion: 'torus-3' })),
    expected,
    'v3 generation stays unchanged',
  )
for (const version of ['torus-3', 'torus-4']) {
  for (const seed of ['world-v3-review', 'village-doors', 'village-wrap', 'village-forest']) {
    const grid = buildWorld({ seed, settings, generatorVersion: version })
    for (const town of grid.towns) {
      if (version === 'torus-4') {
        assert.equal(
          town.buildings.length,
          8,
          'reference street blocks retain all seven buildings and the well',
        )
        assert.equal(town.beds?.length, 3, 'reference farms retain both vegetable beds and wheat')
      }
      assert.equal(
        town.lots?.length,
        town.buildings.length - 1,
        'each building belongs to one planned lot',
      )
      const declaredPaths = new Set<number>()
      for (let k = 0; k < town.paths.length; k += 2)
        declaredPaths.add(gridIndex(town.paths[k]!, town.paths[k + 1]!))
      for (const lot of town.lots ?? []) {
        const b = town.buildings[lot.building]!
        assert.ok(
          delta(b.door![1], lot.streetY) >= (b.kind === 'house' ? 1 : 0),
          'homes retain a yard; public buildings can face the street directly',
        )
        assert.ok(grid.flags[gridIndex(b.door![0], lot.streetY)]! & Flag.Road)
        for (let yy = 0; yy < lot.h; yy++)
          for (let xx = 0; xx < lot.w; xx++) {
            const i = gridIndex(lot.x + xx, lot.y + yy)
            assert.ok(grid.flags[i]! & Flag.Parcel)
            if (grid.flags[i]! & Flag.Road)
              assert.ok(declaredPaths.has(i), 'external roads cannot cut through a parcel')
          }
      }
      for (const bed of town.beds ?? []) {
        beds++
        const plants = cropPlants(bed)
        if (bed.density === 'dense')
          assert.ok(
            plants.length >= bed.w * bed.h * 3,
            'reference crops have dense independent roots',
          )
        else assert.equal(plants.length, bed.w * bed.h)
        for (const crop of plants) {
          const i = gridIndex(crop.x, crop.y)
          assert.ok(grid.flags[i]! & Flag.Farmland, 'every crop is rooted inside the bed')
          assert.ok(!(grid.flags[i]! & (Flag.Road | Flag.Building | Flag.Boundary)))
        }
      }
      for (const edge of town.boundaries ?? [])
        for (let xx = 0; xx < edge.w; xx++) {
          const i = gridIndex(
            edge.x + (edge.axis === 'y' ? 0 : xx),
            edge.y + (edge.axis === 'y' ? xx : 0),
          )
          assert.ok(
            !(grid.flags[i]! & (Flag.Road | Flag.Walkable)),
            'fences have matching collision and never block a path',
          )
        }
      const footprint = new Set<number>()
      for (const b of town.buildings)
        for (let yy = 0; yy < b.h; yy++)
          for (let xx = 0; xx < b.w; xx++) {
            const i = gridIndex(b.x + xx, b.y + yy)
            assert.ok(!footprint.has(i), 'building footprints cannot overlap')
            footprint.add(i)
            assert.ok(grid.flags[i]! & Flag.Building)
            assert.ok(
              !(grid.flags[i]! & (Flag.Road | Flag.Walkable)),
              'roads and repairs cannot carve through a building',
            )
          }
      for (const b of town.buildings) {
        if (b.kind === 'well') continue
        homes++
        assert.ok(b.door, 'each home has a declared visible entrance')
        const door = gridIndex(...b.door)
        assert.ok(grid.flags[door]! & Flag.Road, 'entrance is connected to a path')
        assert.ok(grid.flags[door]! & Flag.Walkable, 'entrance stays walkable after decorations')
        assert.equal(
          grid.region[door],
          grid.mainRegion,
          `entrance reachable from spawn: ${seed}/${town.id}`,
        )
        for (let yy = -2; yy < b.h + 3; yy++)
          for (let xx = -2; xx < b.w + 2; xx++) {
            const i = gridIndex(b.x + xx, b.y + yy)
            assert.ok(
              !isBlockingDecor(grid.decor[i]! as never),
              'yard must not be buried under trees or rocks',
            )
          }
      }
      for (let i = 0; i < town.fields.length; i += 2) {
        assert.ok(
          !footprint.has(gridIndex(town.fields[i]!, town.fields[i + 1]!)),
          'garden cannot overlap a house',
        )
      }
    }
  }
}
assert.ok(homes > 100, 'sample enough actual homes')
assert.ok(beds > 10, 'sample actual farm compounds')
console.log(
  `PASS: ${homes} planned homes, ${beds} planted beds; reachable gates, reserved parcels, torus-1/2 baselines preserved`,
)
