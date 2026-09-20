import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'output/preview/world-v6/corrections'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const backend of ['webgpu', 'webgl']) {
    const errors = []
    const page = await browser.newPage({
      viewport: { width: 1536, height: 1024 },
      deviceScaleFactor: 1,
    })
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    await page.goto(
      `http://127.0.0.1:5173/scripts/worldgen/preview.html?natural&drywalk&freeze&backend=${backend}`,
    )
    await page.waitForFunction(() => window.ready && window.summary, undefined, { timeout: 60000 })
    const dryStart = await page.evaluate(() => window.__world.info)
    assert.equal(dryStart.surface, 3, 'reproduce the marsh material rendered as grass')
    assert.equal(dryStart.walkSpeed, 3.2, 'dry marsh meadow has full walking speed')
    const drySamples = []
    for (const direction of ['left', 'right']) {
      await mkdir(`${out}/drywalk-${direction}-${backend}`, { recursive: true })
      for (let i = 0; i < 16; i++) {
        const beforeX = await page.evaluate(() => window.__world.info.player[0])
        await page.evaluate((d) => {
          window.preview.direction(d === 'left' ? -1 : 1, 0)
          window.preview.pause(false)
        }, direction)
        await page.waitForTimeout(60)
        // Initial GPU compilation may occupy the first animation frame. Capture
        // only once the requested direction has actually moved, not the idle pose.
        await page.waitForFunction(({ x, sign }) => (window.__world.info.player[0] - x) * sign > 0.01,
          { x: beforeX, sign: direction === 'left' ? -1 : 1 }, { timeout: 10000 })
        await page.evaluate(() => window.preview.pause(true))
        drySamples.push({ direction, ...await page.evaluate(() => window.__world.info) })
        await page.locator('#world canvas').screenshot({
          path: `${out}/drywalk-${direction}-${backend}/${String(i).padStart(2, '0')}.png`,
        })
      }
    }
    assert.ok(drySamples.every((s) => s.walkSpeed === 3.2 && s.submersion === 0), 'dry grass never slows or submerges')
    assert.ok(drySamples.every((s) => s.playerSize === dryStart.playerSize), 'side gait retains the idle size')
    for (const direction of ['left', 'right']) {
      const samples = drySamples.filter((s) => s.direction === direction)
      assert.ok(new Set(samples.map((s) => s.playerLayer)).size >= 8, `${direction} walk advances multiple actual atlas layers`)
      const travel = Math.abs(samples.at(-1).player[0] - samples[0].player[0])
      assert.ok(travel > 1.5, `${direction} walking actually travels on dry grass`)
    }
    await page.evaluate(() => window.preview.dispose())
    await page.goto(
      `http://127.0.0.1:5173/scripts/worldgen/preview.html?natural&wading&freeze&backend=${backend}`,
    )
    await page.waitForFunction(() => window.ready && window.summary, undefined, { timeout: 60000 })
    await page.screenshot({ path: `${out}/wading-entry-${backend}.png` })
    const initial = await page.evaluate(() => window.__world.info)
    assert.equal(await page.evaluate(() => window.preview.backend), backend)
    await mkdir(`${out}/wading-${backend}`, { recursive: true })
    const samples = []
    for (let i = 0; i < 36; i++) {
      await page.evaluate(() => {
        window.preview.pause(false)
        window.preview.direction(1, 0)
      })
      await page.waitForTimeout(80)
      await page.evaluate(() => window.preview.pause(true))
      samples.push(await page.evaluate(() => window.__world.info))
      await page
        .locator('#world canvas')
        .screenshot({ path: `${out}/wading-${backend}/${String(i).padStart(2, '0')}.png` })
    }
    assert.ok(
      samples.some((s) => s.submersion > 0.1),
      'shallow water submerges feet',
    )
    assert.ok(
      samples.some((s) => s.walkSpeed === 1.7),
      'water actually slows movement',
    )
    assert.ok(
      samples.every((s) => s.playerSize === initial.playerSize),
      'one fixed quad scale across idle/walk frames',
    )
    const paused = await page.locator('#world canvas').screenshot()
    await page.waitForTimeout(250)
    assert.ok(
      paused.equals(await page.locator('#world canvas').screenshot()),
      'pause freezes ripples and player',
    )
    await page.screenshot({ path: `${out}/wading-final-${backend}.png` })
    assert.deepEqual(errors, [])
    const hero = await page.evaluate(async () => {
      const { loadSpriteAtlas } =
        await import('/src/services/infinite-world/rendering/spriteAtlas.ts')
      const atlas = await loadSpriteAtlas({ baseUrl: '/world/v6' })
      const pixels = atlas.texture.image.data
      const rows = ['down', 'up', 'left', 'right']
      const heights = []
      const canvas = document.createElement('canvas')
      canvas.width = 1152
      canvas.height = 512
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#718153'
      ctx.fillRect(0, 0, 1152, 512)
      const tile = document.createElement('canvas')
      tile.width = 256
      tile.height = 256
      const tc = tile.getContext('2d')
      for (let row = 0; row < 4; row++) {
        const direction = rows[row]
        const walkNames = [...atlas.meta.keys()].filter((name) => name.startsWith(`walk-${direction}-`))
        const names = [
          `idle-${direction}-0`,
          ...Array.from({ length: 8 }, (_, i) => `walk-${direction}-${Math.floor(i * walkNames.length / 8)}`),
        ]
        for (let col = 0; col < names.length; col++) {
          const name = names[col],
            layer = atlas.meta.get(name).layer
          const data = new Uint8ClampedArray(
            pixels.slice(layer * 256 * 256 * 4, (layer + 1) * 256 * 256 * 4),
          )
          let top = 256,
            bottom = 0
          for (let y = 0; y < 256; y++)
            for (let x = 0; x < 256; x++)
              if (data[(y * 256 + x) * 4 + 3] >= 160) {
                top = Math.min(top, y)
                bottom = Math.max(bottom, y)
              }
          heights.push({ name, height: bottom - top + 1 })
          tc.putImageData(new ImageData(data, 256, 256), 0, 0)
          ctx.drawImage(tile, col * 128, row * 128, 128, 128)
          ctx.fillStyle = 'white'
          ctx.font = '10px sans-serif'
          ctx.fillText(name, col * 128 + 2, row * 128 + 10)
        }
      }
      atlas.dispose()
      return { heights, image: canvas.toDataURL('image/png') }
    })
    const referenceHeight = hero.heights[0].height
    assert.ok(
      hero.heights.every((h) => Math.abs(h.height - referenceHeight) <= 6),
      'opaque hero body stays the same size across directions and walking poses',
    )
    await writeFile(
      `${out}/hero-normalized-${backend}.png`,
      Buffer.from(hero.image.split(',')[1], 'base64'),
    )
    results.push({ backend, dryStart, drySamples, initial, samples, heroHeights: hero.heights, errors })
    await page.evaluate(() => window.preview.dispose())
    await page.close()
  }
  await writeFile(`${out}/wading-report.json`, JSON.stringify(results, null, 2) + '\n')
  console.log(
    'PASS: dry meadow full speed, left/right gait, actual shallow-water travel, immersion, constant player scale and frozen ripples on WebGPU/WebGL',
  )
} finally {
  await browser.close()
}
