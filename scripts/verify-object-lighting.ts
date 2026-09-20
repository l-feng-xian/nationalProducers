import assert from 'node:assert/strict'
import { spriteNormalPixels } from '../src/services/infinite-world/rendering/spriteNormals'
import { nightLightPixels } from '../src/services/infinite-world/rendering/nightLightField'

// A flat-colour silhouette isolates surface shape from painted highlights and outlines.
const size = 64
const source = new Uint8Array(size * size * 4)
for (let y = 5; y < 59; y++)
  for (let x = 9; x < 55; x++) {
    source.set([100, 140, 80, 255], (y * size + x) * 4)
  }
const original = source.slice()
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0)
for (const name of ['oak-round', 'cottage', 'walk-left-0']) {
  const map = spriteNormalPixels(source, size, name, size)
  const normal = (x: number, y: number) =>
    Array.from(map.slice((y * size + x) * 4, (y * size + x) * 4 + 3), (v) => (v / 255) * 2 - 1)
  const left = normal(16, 16),
    right = normal(47, 16)
  assert.ok(left[0]! < -0.1 && right[0]! > 0.1, `${name} has opposing surface slopes`)
  for (const n of [left, right, normal(32, 32)]) {
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 0.015, 'normals remain unit length after encoding')
    assert.ok(n[2]! > 0, 'visible surfaces face the camera')
  }
  assert.ok(
    dot(right, [0.8, 0.6, 0]) > dot(left, [0.8, 0.6, 0]) + 0.2,
    'eastern sun lights the east-facing surface',
  )
  assert.ok(
    dot(left, [-0.8, 0.6, 0]) > dot(right, [-0.8, 0.6, 0]) + 0.2,
    'western sun reverses the lit side',
  )
  assert.deepEqual(source, original, 'lighting preserves the source colour and alpha')
}

const field = nightLightPixels([{ x: 0, y: 10, radius: 3, strength: 1 }], 512)
const east = 10 * 512 * 4,
  west = (10 * 512 + 511) * 4
assert.equal(field[east], field[west], 'lamp strength is continuous across the world seam')
assert.ok(
  field[east + 1]! < 128 && field[west + 1]! > 128,
  'lamp direction points toward the same source across the seam',
)
assert.ok(field[east + 2]! < 128, 'north/south direction points toward the source')
assert.ok(Math.abs((field[east + 3]! / 255) * 8 - 3) < 0.02, 'lamp radius survives encoding')
console.log(
  'PASS: tree/building/character surface normals, reversible sun direction, preserved source art and toroidal lamp directions',
)
