import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const out = 'output/preview/world-v6/interactions'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const backend of ['webgpu', 'webgl']) {
    let page
    const errors = []
    async function open(start, natural = false) {
      if (page) {
        await page.evaluate(() => window.preview.dispose())
        await page.close()
      }
      page = await browser.newPage({
        viewport: { width: 1536, height: 1024 },
        deviceScaleFactor: 1,
      })
      page.on('pageerror', (e) => errors.push(e.message))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      const query = new URLSearchParams({
        [natural ? 'natural' : 'reference']: '',
        backend,
        freeze: '',
      })
      if (start) query.set('start', start.join(','))
      await page.goto(`http://127.0.0.1:5173/scripts/worldgen/preview.html?${query}`)
      await page.waitForFunction(() => window.ready && window.summary, undefined, {
        timeout: 60000,
      })
      await page.waitForTimeout(1500)
      // Flush first-frame presentation before timing input; headless Chrome can
      // postpone animation callbacks until the first compositor capture.
      await page.screenshot()
      assert.equal(await page.evaluate(() => window.preview.backend), backend)
    }
    async function move(direction, milliseconds) {
      const before = await page.evaluate(() => window.preview.position())
      await page.evaluate((d) => {
        window.preview.pause(false)
        window.preview.direction(...d)
      }, direction)
      await page.waitForTimeout(milliseconds)
      await page.evaluate(() => window.preview.pause(true))
      return { before, after: await page.evaluate(() => window.preview.position()) }
    }
    await open()
    const yards = await page.evaluate(() => {
      const town = window.previewGrid.towns[0]
      return town.lots
        .filter((l) => town.buildings[l.building].kind === 'house')
        .map((l) => {
          const b = town.buildings[l.building]
          return { art: b.art, start: [b.door[0] + 0.5, l.streetY + 0.5], doorY: b.door[1] }
        })
    })
    for (const yard of yards) {
      await open(yard.start)
      const inward = await move([0, -1], 850)
      assert.ok(
        inward.after[1] < inward.before[1] - 0.7,
        `${yard.art}: pass through courtyard gate`,
      )
      assert.ok(
        inward.after[1] >= yard.doorY && inward.after[1] < yard.doorY + 0.55,
        `${yard.art}: stop at the visible building entrance`,
      )
      await page.screenshot({ path: `${out}/door-${yard.art}-${backend}.png` })
      const outward = await move([0, 1], 550)
      assert.ok(outward.after[1] > outward.before[1] + 1, `${yard.art}: leave the yard`)
      results.push({ backend, yard: yard.art, inward, outward })
    }
    await open([52.2, 66.5])
    const bridge = await move([1, 0], 1600)
    assert.ok(bridge.after[0] > 56.5, 'cross entire bridge and reach the opposite bank')
    await page.screenshot({ path: `${out}/bridge-crossed-${backend}.png` })
    results.push({ backend, bridge })
    // Actual depth-sorted sprite output, retained for manual front/back inspection.
    for (const [side, start] of [
      ['behind', [65.5, 62.7]],
      ['front', [65.5, 64.35]],
    ]) {
      await open(start)
      await page.screenshot({ path: `${out}/well-${side}-${backend}.png` })
    }
    await open(undefined, true)
    const seamY = await page.evaluate(() => {
      const g = window.previewGrid
      for (let y = 10; y < 502; y++)
        if (
          Array.from(
            { length: 7 },
            (_, i) => (g.flags[y * 512 + ((509 + i) % 512)] & 1) !== 0,
          ).every(Boolean)
        )
          return y + 0.5
      throw Error('No walkable seam crossing in test seed')
    })
    await open([511.2, seamY], true)
    await page.screenshot({ path: `${out}/seam-before-${backend}.png` })
    const seam = await move([1, 0], 700)
    assert.ok(seam.after[0] > 0.8 && seam.after[0] < 2.5, 'move continuously through x=512/0')
    await page.screenshot({ path: `${out}/seam-after-${backend}.png` })
    results.push({ backend, seam })
    assert.deepEqual(errors, [])
    await page.evaluate(() => window.preview.dispose())
    await page.close()
  }
  await writeFile(`${out}/report.json`, JSON.stringify(results, null, 2) + '\n')
  console.log(
    `PASS: ${results.length} courtyard/bridge/seam routes; both renderers, entrance collision and front/back captures`,
  )
} finally {
  await browser.close()
}
