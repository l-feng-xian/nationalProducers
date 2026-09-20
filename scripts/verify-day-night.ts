import assert from 'node:assert/strict'
import {
  createWorldClock,
  dayPhase,
  sampleDayNight,
} from '../src/services/infinite-world/simulation/dayNight'
import { nightLightPixels } from '../src/services/infinite-world/rendering/nightLightField'

const clock = createWorldClock(3, 1439, 20)
clock.step(1)
assert.equal(clock.day, 4)
assert.ok(
  Math.abs(clock.minute - 0.2) < 1e-9,
  'clock rolls over midnight without losing fractional minutes',
)
clock.step(90, true)
assert.ok(Math.abs(clock.minute - 0.2) < 1e-9, 'pause freezes time')
const saved = { day: clock.day, minute: clock.minute }
const loaded = createWorldClock(saved.day, saved.minute, 20)
loaded.step(1200)
assert.equal(loaded.day, 5)
assert.ok(
  Math.abs(loaded.minute - saved.minute) < 1e-9,
  'configured real duration equals one game day',
)
assert.deepEqual(sampleDayNight(0), sampleDayNight(1440), 'lighting is periodic at midnight')
for (let m = 0; m < 1440; m++) {
  const a = sampleDayNight(m),
    b = sampleDayNight(m + 1)
  assert.ok(
    a.tint.every((v, k) => Math.abs(v - b.tint[k]!) < 0.02),
    'no one-minute light jumps',
  )
  assert.ok(Math.abs(a.shadowOpacity - b.shadowOpacity) < 0.02, 'shadows fade near horizon')
  assert.ok(Math.hypot(...a.shadow) < 1.6, 'low sun projection remains inside chunk culling margin')
}
const morning = sampleDayNight(480),
  noon = sampleDayNight(720),
  evening = sampleDayNight(1020),
  night = sampleDayNight(1320)
assert.ok(morning.shadow[0] < 0 && evening.shadow[0] > 0, 'sun shadows change direction')
assert.ok(
  Math.hypot(...morning.shadow) > Math.hypot(...noon.shadow) * 2,
  'morning shadows are longer than noon',
)
assert.equal(night.shadowOpacity, 0, 'no residual solar silhouette at night')
assert.equal(night.lamps, 1)
assert.equal(noon.lamps, 0)
assert.ok(
  night.tint[2] > night.tint[0] && evening.tint[0] > evening.tint[2],
  'cool moonlight and warm sunset',
)
assert.ok(
  sampleDayNight(720, 'storm').shadowOpacity < noon.shadowOpacity,
  'overcast weakens direct shadows',
)
assert.equal(dayPhase(360), 'dawn')
assert.equal(dayPhase(720), 'day')
assert.equal(dayPhase(1080), 'dusk')
assert.equal(dayPhase(1300), 'night')
const pixels = nightLightPixels([{ x: 0, y: 10, radius: 3, strength: 1 }], 512)
for (let y = 7; y < 13; y++)
  for (let x = 0; x < 3; x++)
    assert.equal(
      pixels[(y * 512 + x) * 4],
      pixels[(y * 512 + 511 - x) * 4],
      'lamp lighting wraps without a seam',
    )
assert.ok(pixels[10 * 512 * 4]! > 200)
assert.equal(pixels[(10 * 512 + 6) * 4], 0, 'lamp has finite reach')
console.log(
  'PASS: world clock, save resume, midnight continuity, sun direction/length, night lamps and toroidal local illumination',
)
