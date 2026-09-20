import { chromium } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const out = 'output/preview/world-v6/object-lighting'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const reports = []
try {
  for (const backend of ['webgpu', 'webgl']) {
    const page = await browser.newPage({
      viewport: { width: 1536, height: 1024 },
      deviceScaleFactor: 1,
    })
    const errors = []
    page.on('pageerror', (e) => {
      errors.push(e.message)
      console.error(e.message)
    })
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    async function open(query) {
      if (await page.evaluate(() => !!window.preview).catch(() => false))
        await page.evaluate(() => window.preview.dispose())
      await page.goto(
        `http://127.0.0.1:5173/scripts/worldgen/preview.html?freeze&backend=${backend}&${query}`,
      )
      await page.waitForFunction(() => window.ready && window.summary, undefined, {
        timeout: 60000,
      })
      await page.waitForTimeout(400)
      await page.screenshot()
      assert.equal(await page.evaluate(() => window.preview.backend), backend)
    }
    for (const [name, query] of [
      ['morning', 'reference&minute=480'],
      ['afternoon', 'reference&minute=960'],
      ['night', 'reference&minute=1320'],
    ]) {
      await open(query)
      await page.screenshot({ path: `${out}/${name}-${backend}.png` })
      await page.evaluate(() => window.__world.debugSurfaceLighting(false))
      await page.waitForTimeout(80)
      await page.screenshot({ path: `${out}/${name}-flat-${backend}.png` })
      await page.evaluate(() => window.__world.debugSurfaceLighting(true))
    }
    await open('lighting&minute=480')
    assert.ok((await page.evaluate(() => window.__world.info.spriteShadowBatches)) > 0)
    const clip = { x: 710, y: 410, width: 116, height: 112 }
    const shaded = await page.screenshot({ path: `${out}/tree-shade-${backend}.png` })
    await page.screenshot({ path: `${out}/hero-shaded-${backend}.png`, clip })
    await page.evaluate(() => window.__world.debugReceivedShadows(false))
    await page.waitForTimeout(80)
    const lit = await page.screenshot({ path: `${out}/tree-no-reception-${backend}.png` })
    await page.screenshot({ path: `${out}/hero-unshaded-${backend}.png`, clip })
    assert.ok(
      !lit.equals(shaded),
      'tree shadow changes receiving sprites, with surface lighting unchanged',
    )
    await page.evaluate(() => window.__world.debugReceivedShadows(true))
    await page.waitForTimeout(80)
    const frozen = await page.locator('canvas').screenshot()
    await page.waitForTimeout(160)
    assert.ok(
      frozen.equals(await page.locator('canvas').screenshot()),
      'shadow pass is stable while paused',
    )
    const start = await page.evaluate(() => window.preview.position())
    await page.evaluate(() => {
      window.preview.direction(-1, 0)
      window.preview.pause(false)
    })
    await page.waitForFunction((x) => window.preview.position()[0] < x - 2, start[0], {
      timeout: 10000,
    })
    await page.evaluate(() => window.preview.pause(true))
    await page.screenshot({ path: `${out}/left-the-shade-${backend}.png` })
    await page.screenshot({ path: `${out}/hero-outside-${backend}.png`, clip })
    await page.evaluate(() => window.__world.debugReceivedShadows(false))
    await page.waitForTimeout(80)
    await page.screenshot({ path: `${out}/hero-outside-unshaded-${backend}.png`, clip })
    await open('lighting=building&minute=480')
    await page.screenshot({ path: `${out}/building-shade-${backend}.png` })
    const buildingShade = await page.screenshot({
      path: `${out}/hero-building-shaded-${backend}.png`,
      clip,
    })
    await page.evaluate(() => window.__world.debugReceivedShadows(false))
    await page.waitForTimeout(80)
    const buildingLit = await page.screenshot({
      path: `${out}/hero-building-unshaded-${backend}.png`,
      clip,
    })
    assert.ok(!buildingLit.equals(buildingShade), 'building shadow reaches the character')
    assert.deepEqual(errors, [])
    reports.push({ backend, errors, info: await page.evaluate(() => window.__world.info) })
    await page.evaluate(() => window.preview.dispose())
    await page.close()
  }
  await writeFile(`${out}/report.json`, JSON.stringify(reports, null, 2) + '\n')
  console.log(
    'PASS: directional sprite relief, local night lighting, tree shadow reception, moving receiver and pause on both backends',
  )
} finally {
  await browser.close()
}
