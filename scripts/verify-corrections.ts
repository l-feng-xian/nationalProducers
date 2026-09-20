import assert from 'node:assert/strict'
import { heroGroupScales } from '../src/services/infinite-world/rendering/heroScale'
import { spaceTrees, isTree } from '../src/services/infinite-world/generation/treeSpacing'
import {
  createEmptyGrid,
  Decor,
  Flag,
  Surface,
  gridIndex,
} from '../src/services/infinite-world/generation/grid'
import { wadingDepth, movementSpeed } from '../src/services/infinite-world/rendering/wading'
import { buildContourPixels } from '../src/services/infinite-world/rendering/contourField'

// Reproduce the measured mismatch in the shipped sheets; preserve stride variation.
const scales = heroGroupScales(
  new Map([
    ['idle-down-0', 182],
    ['walk-down-0', 207],
    ['walk-down-1', 205],
    ['walk-down-2', 208],
    ['idle-left-0', 179],
    ['walk-left-0', 195],
  ]),
)
assert.equal(scales.get('walk-down-0'), scales.get('walk-down-1'))
assert.ok(Math.abs(scales.get('walk-down-0')! * 207 - 182) < 1e-9)
assert.equal(scales.get('idle-down-0'), 1)
assert.ok(Math.abs(scales.get('walk-left-0')! * 195 - 182) < 1e-9)

const grid = createEmptyGrid('tree-spacing-seam', 'torus-4', 0)
grid.flags.fill(Flag.Walkable)
for (let y = -7; y <= 7; y++)
  for (let x = -7; x <= 7; x++) grid.decor[gridIndex(x, y)] = Decor.TreeBroad
const same = structuredClone(grid)
spaceTrees(grid)
spaceTrees(same)
assert.deepEqual(grid.decor, same.decor, 'deterministic selection')
let kept = 0,
  removed = 0
for (let y = -7; y <= 7; y++)
  for (let x = -7; x <= 7; x++) {
    const i = gridIndex(x, y)
    if (isTree(grid.decor[i]!)) {
      kept++
      assert.ok(!(grid.flags[i]! & Flag.Walkable))
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if ((dx || dy) && dx * dx + dy * dy < 2.4 ** 2)
            assert.ok(
              !isTree(grid.decor[gridIndex(x + dx, y + dy)]!),
              'minimum spacing includes world seam',
            )
    } else {
      removed++
      assert.ok(grid.flags[i]! & Flag.Walkable, 'removed trunks restore passage')
    }
  }
assert.ok(kept > 10 && removed > kept * 2, 'dense forest becomes separated groups')

const water = createEmptyGrid('wading', 'torus-4', 0),
  pixels = new Uint8Array(16 * 16 * 4)
for (let i = 0; i < 16 * 16; i++) pixels[i * 4 + 3] = 160
water.surface.fill(Surface.ShallowWater)
assert.equal(wadingDepth(water, pixels, 16, 10, 10), 0.28)
assert.equal(movementSpeed(water, 10, 10, 0.28), 1.7, 'shallow water slows walking, not just marsh')
water.flags[gridIndex(10, 10)] = Flag.Walkable | Flag.Bridge
assert.equal(wadingDepth(water, pixels, 16, 10, 10), 0, 'bridge keeps boots dry')
assert.equal(movementSpeed(water, 10, 10, 0), 3.2)
assert.equal(wadingDepth(water, pixels, 16, -1, 10), wadingDepth(water, pixels, 16, 511, 10))
for (let i = 0; i < 16 * 16; i++) pixels[i * 4 + 3] = 100
assert.equal(wadingDepth(water, pixels, 16, 20, 10), 0)

// Regression: logical wetland / water IDs are not the visible water footprint.
// A marsh meadow and an isolated water cell rounded away by the renderer are dry.
const meadow = createEmptyGrid('dry-grass-speed', 'torus-4', 0)
meadow.surface.fill(Surface.Marsh)
meadow.flags.fill(Flag.Walkable)
meadow.surface[gridIndex(30, 30)] = Surface.ShallowWater
for (let y = 60; y < 70; y++)
  for (let x = 60; x < 70; x++) meadow.surface[gridIndex(x, y)] = Surface.ShallowWater
const contour = buildContourPixels(meadow)
for (const [x, y] of [[10.5, 10.5], [30.5, 30.5], [58.5, 64.5], [-1.5, 10.5]]) {
  const depth = wadingDepth(meadow, contour.data, contour.size, x!, y!)
  assert.equal(depth, 0, 'rendered meadow stays dry even with a wet navigation tile')
  assert.equal(movementSpeed(meadow, x!, y!, depth), 3.2, 'dry meadow never slows walking')
}
const pondDepth = wadingDepth(meadow, contour.data, contour.size, 64.5, 64.5)
assert.ok(pondDepth > 0.07)
assert.equal(movementSpeed(meadow, 64.5, 64.5, pondDepth), 1.7, 'visible pond still slows walking')
for (const surface of Object.values(Surface)) {
  meadow.surface[gridIndex(10, 10)] = surface
  assert.equal(movementSpeed(meadow, 10.5, 10.5, 0), 3.2, 'dry contour overrides material ID')
}
meadow.flags[gridIndex(64, 64)] |= Flag.Bridge
assert.equal(movementSpeed(meadow, 64.5, 64.5, pondDepth), 3.2, 'bridge excludes water slowdown')
console.log(
  `PASS: fixed animation scale, ${kept} spaced trees / ${removed} removed across seams, dry meadow speed, visible water immersion and bridge exclusion`,
)
