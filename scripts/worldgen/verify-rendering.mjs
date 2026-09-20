import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const out = process.argv.find((a) => a.startsWith('--out='))?.slice(6) ?? 'output/preview/world-v6'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const results = []
try {
  for (const variant of [
    'reference',
    'bridge',
    'fixture',
    'natural',
    'shore',
    'overview',
    'farm',
    'seed-wrap',
    'seed-forest',
    'seam',
    'mobile',
    'legacy',
    'v2',
    'v3',
  ]) {
    const viewport =
      variant === 'overview'
        ? { width: 2560, height: 1600 }
        : variant === 'reference' || variant === 'bridge'
          ? { width: 1536, height: 1024 }
          : variant === 'mobile'
            ? { width: 390, height: 844 }
            : { width: 1440, height: 900 }
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    const backend = process.argv.includes('--webgpu') ? 'webgpu' : 'webgl'
    const query = new URLSearchParams({ backend, freeze: '' })
    if (variant === 'reference' || variant === 'bridge') query.set('reference', '')
    else if (variant !== 'fixture') {
      query.set('natural', '')
      query.set(variant, '')
    }
    if (variant === 'legacy') query.set('version', 'torus-1')
    if (variant === 'v2') query.set('version', 'torus-2')
    if (variant === 'v3') query.set('version', 'torus-3')
    if (variant === 'seed-wrap') query.set('seed', 'village-wrap')
    if (variant === 'seed-forest') query.set('seed', 'village-forest')
    if (variant === 'seam') query.set('start', '511.5,511.5')
    if (variant === 'bridge') query.set('start', '52.2,66.5')
    await page.goto(`http://127.0.0.1:5173/scripts/worldgen/preview.html?${query}`)
    await page.waitForFunction(() => window.ready && window.summary, undefined, { timeout: 60000 })
    await page.waitForTimeout(1500)
    await page.evaluate(() => window.preview.pause(true))
    await page.screenshot({ path: `${out}/${variant}-${backend}.png` })
    const result = await page.evaluate(() => ({
      summary: window.summary,
      messages: window.previewMessages,
      generatorVersion: window.previewGrid.generatorVersion,
    }))
    assert.equal(result.summary.backend, backend, 'requested renderer must actually be active')
    assert.equal(
      result.generatorVersion,
      variant === 'legacy'
        ? 'torus-1'
        : variant === 'fixture'
          ? 'review'
          : variant === 'v2'
            ? 'torus-2'
            : variant === 'v3'
              ? 'torus-3'
              : 'torus-4',
      'Worker preserves the requested generator version',
    )
    if (variant === 'fixture' || variant === 'reference' || variant === 'bridge') {
      const before = await page.evaluate(() => window.preview.position())
      await page.evaluate(() => {
        window.preview.pause(false)
        window.preview.direction(1, 0)
      })
      await page.waitForTimeout(variant === 'bridge' ? 850 : 450)
      await page.evaluate(() => window.preview.pause(true))
      const after = await page.evaluate(() => window.preview.position())
      assert.ok(after[0] > before[0] + 0.4, 'player actually moves while playing')
      await page.waitForTimeout(100)
      const pausedA = await page.locator('#world canvas').screenshot()
      await page.waitForTimeout(250)
      const pausedB = await page.locator('#world canvas').screenshot()
      if (!pausedA.equals(pausedB)) {
        await writeFile(`${out}/pause-a-${backend}.png`, pausedA)
        await writeFile(`${out}/pause-b-${backend}.png`, pausedB)
        console.log(await page.evaluate(() => window.__world?.info))
      }
      assert.deepEqual(
        await page.evaluate(() => window.preview.position()),
        after,
        'pause freezes position',
      )
      assert.ok(pausedA.equals(pausedB), 'pause freezes water, clouds and the current walk frame')
      result.pauseVerified = true
      result.movement = { before, after }
      if (variant === 'reference') {
        await mkdir(`${out}/animation-${backend}`, { recursive: true })
        for (let frame = 0; frame < 16; frame++) {
          await page.evaluate(() => {
            window.preview.pause(false)
            window.preview.direction(-1, 0)
          })
          await page.waitForTimeout(65)
          await page.evaluate(() => window.preview.pause(true))
          await page.locator('#world canvas').screenshot({
            path: `${out}/animation-${backend}/${String(frame).padStart(2, '0')}.png`,
          })
        }
      }
    }
    results.push({ variant, ...result, errors })
    if (errors.length || result.messages.some((m) => m.includes('未载入')))
      throw Error(JSON.stringify(results, null, 2))
    await page.evaluate(() => window.preview.dispose())
    await page.close()
  }
  await writeFile(
    `${out}/report${process.argv.includes('--webgpu') ? '-webgpu' : ''}.json`,
    JSON.stringify(results, null, 2),
  )
  console.log(JSON.stringify(results, null, 2))
} finally {
  await browser.close()
}
