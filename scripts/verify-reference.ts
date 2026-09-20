import assert from 'node:assert/strict'
import { createReferenceFixture } from '../src/services/infinite-world/generation/referenceFixture'
import {
  createEmptyGrid,
  Flag,
  Surface,
  gridIndex,
  transferablesOf,
  gridByteLength,
} from '../src/services/infinite-world/generation/grid'
import { bridgeDecks } from '../src/services/infinite-world/rendering/bridgeGeometry'
import { buildPlots } from '../src/services/infinite-world/rendering/plotBuild'
import { shoreRoot } from '../src/services/infinite-world/rendering/shorePlacement'
import { cropPlants } from '../src/services/infinite-world/rendering/farmCrops'
import { wrapTile } from '../src/services/infinite-world/core/torus'

const reference = createReferenceFixture(),
  town = reference.towns[0]!
assert.equal(town.buildings.length, 8, 'all seven reference buildings and well must exist')
assert.equal(town.beds?.length, 3, 'two vegetable beds and wheat remain present')
for (const b of town.buildings)
  if (b.door)
    assert.equal(
      reference.region[gridIndex(...b.door)],
      reference.region[gridIndex(...reference.spawn)],
      `${b.art} entrance reachable`,
    )
for (const bed of town.beds ?? [])
  for (const p of cropPlants(bed)) {
    const f = reference.flags[gridIndex(p.x, p.y)]!
    assert.ok(f & Flag.Farmland)
    assert.ok(!(f & (Flag.Road | Flag.Boundary | Flag.Building)))
  }
for (const b of reference.bridges)
  for (let k = 0; k < b.cells.length; k += 2)
    assert.equal(
      reference.region[gridIndex(b.cells[k]!, b.cells[k + 1]!)],
      reference.region[gridIndex(...reference.spawn)],
      'bridge is connected to town',
    )

const bridge = createEmptyGrid('seam-bridge', 'torus-4', 0)
bridge.bridges = [{ cells: Int32Array.from([510, 511, 511, 511, 0, 511, 0, 0, 0, 1]), span: 5 }]
const seen = new Set<number>()
for (const d of bridgeDecks(bridge))
  for (let y = 0; y < d.h; y++)
    for (let x = 0; x < d.w; x++) {
      const i = gridIndex(d.x - d.w / 2 + x, d.y - d.h / 2 + y)
      assert.ok(!seen.has(i), 'each bend cell has one deck')
      seen.add(i)
    }
assert.deepEqual(
  [...seen].sort(),
  [
    gridIndex(510, 511),
    gridIndex(511, 511),
    gridIndex(0, 511),
    gridIndex(0, 0),
    gridIndex(0, 1),
  ].sort(),
  'no phantom deck across water inside a bend',
)
let plots = 0
for (let y = 0; y < 16; y++)
  for (let x = 0; x < 16; x++)
    plots += buildPlots(bridge, x, y)
      .filter((p) => p.kind.startsWith('bridge'))
      .reduce((n, p) => n + p.count, 0)
assert.equal(plots, bridgeDecks(bridge).length, 'deck has one chunk owner across both seams')

const shore = createEmptyGrid('seam-shore', 'torus-4', 0)
for (let y = 0; y < 512; y++)
  for (let x = -2; x < 2; x++) shore.surface[gridIndex(x, y)] = Surface.DeepWater
const left = shoreRoot(shore, 509, 100),
  same = shoreRoot(shore, -3, 612)
assert.ok(left && same)
assert.ok(
  Math.abs(wrapTile(left.x) - wrapTile(same.x)) < 1e-6,
  'shore root wraps with the water contour',
)
assert.ok(Math.abs(left.nx - same.nx) < 1e-6 && Math.abs(left.ny - same.ny) < 1e-6)
const length = gridByteLength(reference),
  bytes = reference.flow!.byteLength
const transferred = structuredClone(reference, { transfer: transferablesOf(reference) })
assert.equal(reference.flow!.byteLength, 0, 'flow buffer is transferred, not cloned')
assert.equal(transferred.flow!.byteLength, bytes)
assert.equal(gridByteLength(transferred), length)
console.log(
  'PASS: complete reference town, reachable bridge/doors, rooted crops, bent bridge and shore seams, worker flow transfer',
)
