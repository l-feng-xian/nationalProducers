import assert from 'node:assert/strict'
import { Surface, Flag, createEmptyGrid } from '../src/services/infinite-world/generation/grid'
import { LAYERS } from '../src/services/infinite-world/grid/dualGrid'
import { buildChunk } from '../src/services/infinite-world/rendering/chunkBuild'
import {
  periodicDistance,
  smoothDistance,
  sampleContour,
} from '../src/services/infinite-world/rendering/contourField'
import { shoreDistance, SHORE_RANGE } from '../src/services/infinite-world/rendering/shoreDistance'
import { createPlayerMotion } from '../src/services/infinite-world/rendering/playerMotion'
import { bleedTransparentEdges } from '../src/services/infinite-world/rendering/spriteAtlas'
import { farmBeds } from '../src/services/infinite-world/rendering/farmCrops'
import { buildPlots } from '../src/services/infinite-world/rendering/plotBuild'
import type { Town } from '../src/services/infinite-world/generation/settlement'

const W = 16
// Compare the toroidal distance transform against an independent exhaustive oracle.
const mask = new Uint8Array(W * W)
for (let i = 0; i < mask.length; i++) mask[i] = Number((i * 31 + (i % W) * 13) % 23 < 4)
for (const target of [0, 1]) {
  const distances = periodicDistance(mask, target, W)
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      let best = Infinity
      for (let yy = 0; yy < W; yy++)
        for (let xx = 0; xx < W; xx++) {
          if (mask[yy * W + xx] !== target) continue
          const dx = Math.min(Math.abs(x - xx), W - Math.abs(x - xx))
          const dy = Math.min(Math.abs(y - yy), W - Math.abs(y - yy))
          best = Math.min(best, dx * dx + dy * dy)
        }
      assert.equal(distances[y * W + x], best, `Euclidean distance ${x},${y}`)
    }
}
mask.fill(0)
assert.ok(
  smoothDistance(mask, W).every((v) => v === -4),
  'empty contours never appear',
)
mask.fill(1)
assert.ok(
  smoothDistance(mask, W).every((v) => v === 4),
  'full coverage survives smoothing',
)
mask.fill(0)
for (let y = 0; y < W; y++) mask[y * W] = 1
const contour = smoothDistance(mask, W)
assert.ok(contour[0]! > -0.26, 'one-cell river and path retain visible centers')
assert.ok(contour[1]! < -0.55, 'a narrow path does not grow a second solid tile')
const translatedMask = new Uint8Array(mask.length)
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) translatedMask[y * W + ((x + 7) % W)] = mask[y * W + x]!
const translatedContour = smoothDistance(translatedMask, W)
for (let y = -1.5; y < W; y += 0.37)
  for (let x = -1.5; x < W; x += 0.37) {
    const value = sampleContour(contour, W, x, y)
    assert.ok(
      Math.abs(value - sampleContour(translatedContour, W, x + 7, y)) < 1e-6,
      'continuous torus translation',
    )
    assert.ok(
      Math.abs(value - sampleContour(contour, W, x + W, y - W)) < 1e-6,
      'continuous seam wrapping',
    )
  }
for (let y = 0; y < W; y++) {
  const left = sampleContour(contour, W, -0.001, y)
  const right = sampleContour(contour, W, 0.001, y)
  assert.ok(Math.abs(left - right) < 0.001, 'no seam in interpolated silhouette')
}
const layerGrid = createEmptyGrid('layers', 'test', 0)
layerGrid.surface[0] = Surface.Dirt
layerGrid.flags[0] = Flag.Road
const layer = (id: string) => LAYERS.find((l) => l.id === id)!
assert.ok(layer('dirt').test(layerGrid, 0))
assert.ok(!layer('road').test(layerGrid, 0), 'ordinary paths have exactly one painted fringe')
layerGrid.flags[0] |= Flag.Bridge
assert.ok(
  layer('road').test(layerGrid, 0) && !layer('dirt').test(layerGrid, 0),
  'bridges are above water',
)
layerGrid.surface[0] = Surface.Cobble
layerGrid.flags[0] = Flag.Building
assert.ok(!layer('cobble').test(layerGrid, 0), 'houses never get a rectangular stone platform')
// A contour near a chunk/world boundary needs geometry on both sides, including mask=0 cells.
const haloGrid = createEmptyGrid('halo', 'test', 0)
haloGrid.surface[32 * 512 + 32] = Surface.Dirt
haloGrid.surface[0] = Surface.Dirt
const palette = { ready: false, indexOf: () => 0, sourceOf: () => null }
const spriteMeta = { has: () => false, get: () => undefined }
for (const [cx, cy, x, y] of [
  [0, 0, 31, 31],
  [1, 1, 33, 33],
  [15, 15, 511, 511],
]) {
  const chunk = buildChunk(haloGrid, cx!, cy!, palette, spriteMeta)
  const dirt = chunk.layers.find((l) => l.layer === 'dirt')!
  assert.ok(dirt, 'contour halo survives chunk culling')
  assert.ok(
    Array.from({ length: dirt.count }, (_, i) => i).some(
      (i) => dirt.offset[i * 2] === x && dirt.offset[i * 2 + 1] === y,
    ),
    'geometry exists across the chunk/world seam',
  )
}

// Old farmland crossing x=511/0 becomes one visual bed; no duplicated chunk-owned plot.
const farmGrid = createEmptyGrid('farm-seam', 'torus-2', 0)
const oldFarm: Town = {
  id: 'farm',
  name: 'farm',
  cx: 511,
  cy: 10,
  radius: 5,
  plaza: new Int32Array(),
  paths: new Int32Array(),
  buildings: [],
  gates: new Int32Array(),
  fields: Int32Array.from([511, 10, 0, 10, 511, 11, 0, 11]),
}
farmGrid.towns.push(oldFarm)
for (let k = 0; k < oldFarm.fields.length; k += 2)
  farmGrid.flags[oldFarm.fields[k + 1]! * 512 + oldFarm.fields[k]!] = Flag.Farmland
assert.equal(farmBeds(farmGrid, oldFarm).length, 1, 'legacy field wraps into one bed')
assert.equal(buildPlots(farmGrid, 0, 0).find((p) => p.kind === 'bed')?.count, 1)
assert.ok(!buildPlots(farmGrid, 15, 0).some((p) => p.kind === 'bed'), 'bed has one chunk owner')
farmGrid.flags[20 * 512 + 20] = Flag.Farmland
const farmChunk = buildChunk(farmGrid, 0, 0, palette, spriteMeta)
assert.ok(
  farmChunk.layers.some((l) => l.layer === 'tilled'),
  'unrelated farmland keeps its surface',
)
farmGrid.flags[10 * 512] = 0
assert.equal(
  farmBeds(farmGrid, oldFarm).reduce((n, b) => n + b.w * b.h, 0),
  3,
  'legacy crop conversion honors changed cells',
)

const surface = new Uint8Array(W * W)
assert.ok(
  shoreDistance(surface, W).every((v) => v === -SHORE_RANGE),
  'all-land world',
)
surface.fill(Surface.DeepWater)
assert.ok(
  shoreDistance(surface, W).every((v) => v === SHORE_RANGE),
  'all-water world',
)
surface.fill(Surface.Grass)
for (let y = 0; y < W; y++) surface[y * W] = Surface.ShallowWater
const thin = shoreDistance(surface, W)
assert.equal(thin[0], 0.5, 'one-tile river must retain positive depth')
assert.equal(thin[1], -0.5)
assert.equal(thin[W - 1], -0.5, 'shore distance wraps across world boundary')
// Translating a world across its seam must translate the entire field identically.
const translated = new Uint8Array(surface.length)
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) translated[y * W + ((x + 7) % W)] = surface[y * W + x]!
const shifted = shoreDistance(translated, W)
for (let y = 0; y < W; y++)
  for (let x = 0; x < W; x++) assert.equal(thin[y * W + x], shifted[y * W + ((x + 7) % W)])
for (let y = 0; y < W; y++) for (let x = 0; x < 6; x++) surface[y * W + x] = Surface.DeepWater
const wide = shoreDistance(surface, W)
assert.ok(wide[2]! > wide[0]!, 'wide river gets deeper toward center')

const motion = createPlayerMotion()
const walk = motion.step(0.1, 0.32)
assert.equal(walk.moving, true)
assert.deepEqual(motion.step(10, 0, true), walk, 'pause preserves walking pose and phase')
assert.equal(motion.step(0.1, 0).moving, false, 'collision stops gait')
const first = motion.step(0.02, 0.064)
const restarted = createPlayerMotion().step(0.02, 0.064)
assert.deepEqual(first, restarted, 'walking starts at a predictable planted phase')
function simulate(fps: number, speed: number) {
  const state = createPlayerMotion()
  let result = state.step(0, 0)
  for (let i = 0; i < fps; i++) result = state.step(1 / fps, speed / fps)
  return result.phase
}
assert.ok(
  Math.abs(simulate(30, 1.7) - simulate(144, 1.7)) < 1e-10,
  'gait independent of refresh rate',
)
assert.ok(simulate(60, 0.8) < simulate(60, 1.7), 'slower travel produces slower gait')

const rgba = new Uint8Array(9 * 9 * 4)
rgba.set([120, 160, 80, 255], (4 * 9 + 4) * 4)
bleedTransparentEdges(rgba, 9, 9)
assert.deepEqual(
  [...rgba.slice((4 * 9 + 3) * 4, (4 * 9 + 3) * 4 + 4)],
  [120, 160, 80, 0],
  'transparent edge carries foreground RGB, no black matte',
)
assert.equal(rgba[(4 * 9 + 4) * 4 + 3], 255, 'bleeding does not change coverage')
console.log(
  'PASS: exact continuous contours, torus seams, thin streams, layer composition, shore depth, motion and sprite edges',
)
