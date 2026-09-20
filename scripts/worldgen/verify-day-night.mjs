import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const out = process.argv.find(a=>a.startsWith('--out='))?.slice(6) ?? 'output/preview/world-v6/day-night'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const backend of ['webgpu', 'webgl']) {
    const page = await browser.newPage({
      viewport: { width: 1536, height: 1024 },
      deviceScaleFactor: 1,
    })
    const errors = []
    page.on('pageerror', (e) => {errors.push(e.message);console.error(e.message)})
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('response', (r) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`)
    })
    async function open(minute, extra = {}) {
      if (await page.evaluate(() => !!window.preview).catch(() => false))
        await page.evaluate(() => window.preview.dispose())
      const query = new URLSearchParams({
        reference: '',
        freeze: '',
        backend,
        minute: String(minute),
        ...extra,
      })
      if ('natural' in extra) query.delete('reference')
      await page.goto(`http://127.0.0.1:5173/scripts/worldgen/preview.html?${query}`)
      await page.waitForFunction(() => window.ready && window.summary, undefined, {
        timeout: 60000,
      })
      await page.waitForTimeout(250)
      assert.equal(await page.evaluate(() => window.preview.backend), backend)
    }
    for (const [name, minute] of [
      ['dawn', 360],
      ['morning', 480],
      ['noon', 720],
      ['sunset', 1050],
      ['twilight', 1140],
      ['night', 1320],
    ]) {
      await open(minute)
      const info = await page.evaluate(() => window.__world.info)
      assert.equal(info.clock.minute, minute, 'paused load starts at the saved time')
      assert.equal(info.lighting.lampsVisible, info.lighting.lamps > 0.001)
      await page.screenshot({ path: `${out}/${name}-${backend}.png` })
      if (name === 'morning') {
        const withShadow = await page.locator('canvas').screenshot()
        await page.evaluate(() => window.__world.debugShadows(false))
        await page.waitForTimeout(100)
        const withoutShadow = await page
          .locator('canvas')
          .screenshot({ path: `${out}/morning-no-shadows-${backend}.png` })
        assert.ok(
          !withShadow.equals(withoutShadow),
          'projected silhouettes actually change the rendered scene',
        )
        await page.evaluate(() => window.__world.debugShadows(true))
      }
      if (name === 'night') {
        assert.equal(info.lighting.shadowOpacity, 0)
        assert.ok(info.lighting.lampCount > 0, 'night scene has visible lanterns')
        const paused = await page.locator('canvas').screenshot()
        await page.waitForTimeout(250)
        assert.ok(
          paused.equals(await page.locator('canvas').screenshot()),
          'pause freezes lighting, shadows and water',
        )
      }
      results.push({ backend, name, info })
    }
    // Runtime rollover rather than only calling the pure clock helper.
    await open(1439, { dayMinutes: '0.1' })
    await page.evaluate(() => window.preview.pause(false))
    await page.waitForFunction(() => window.preview.snapshot().day === 2, undefined, {
      timeout: 10000,
    })
    await page.evaluate(() => window.preview.pause(true))
    const saved = await page.evaluate(() => window.preview.snapshot())
    assert.equal(saved.day, 2)
    assert.ok(saved.minute < 180, 'midnight does not skip a day')
    await page.waitForTimeout(250)
    assert.equal((await page.evaluate(() => window.preview.snapshot())).minute, saved.minute)
    results.push({ backend, name: 'rollover', saved })
    for (const [name, extra] of [
      ['rain', { weather: 'rain' }],
      ['legacy', { natural: '', version: 'torus-1' }],
      ['seam', { natural: '', start: '511.5,511.5' }],
      ['mobile', {}],
    ]) {
      if (name === 'mobile') await page.setViewportSize({ width: 390, height: 844 })
      await open(name === 'rain' ? 720 : 1320, extra)
      await page.screenshot({ path: `${out}/${name}-${backend}.png` })
      const info = await page.evaluate(() => window.__world.info)
      if (name === 'legacy')
        assert.equal(await page.evaluate(() => window.previewGrid.generatorVersion), 'torus-1')
      results.push({ backend, name, info })
    }
    assert.deepEqual(errors, [])
    await page.evaluate(() => window.preview.dispose())
    await page.close()
  }
  await writeFile(`${out}/report.json`, JSON.stringify(results, null, 2) + '\n')
  console.log(
    'PASS: dawn/day/dusk/night, visible projected shadows, lamps, paused saves and midnight rollover on WebGPU/WebGL',
  )
} finally {
  await browser.close()
}
