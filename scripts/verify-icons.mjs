import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

// Exercise the rendered SVGs: interrupted transitions, selection, disabled
// controls, duplicate instances, keyboard focus and reduced-motion end states.
const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, open: false },
})
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mkdir('test-results/icons', { recursive: true })

  for (const route of ['chat', 'characters', 'groups', 'worlds', 'models', 'data', 'settings']) {
    await page.goto(`${origin}${route}`)
    // 侧栏导航 6 项：角色 / 演绎 / 世界书 / 模型管理 / 数据管理 / 设置
    await expect(page.locator('.foot .cbx-icon')).toHaveCount(6)
    assert.equal(
      await page.locator('.foot .cbx-icon').evaluateAll((icons) =>
        icons.every((icon) => {
          const rect = icon.getBoundingClientRect()
          return (
            rect.width === 20 && rect.height === 20 && icon.getAttribute('viewBox') === '0 0 24 24'
          )
        }),
      ),
      true,
      `${route}: navigation size`,
    )
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `${route}: overflow`,
    )
  }
  await page.goto(`${origin}characters`)
  // Starter templates populate the first run, so the empty state is optional.
  // The navigation icon is always present and still exercises the Characters SVG.
  await expect(page.locator('[data-icon="Characters"]').first()).toBeVisible()
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/icons/characters-light.png' })

  const settings = page.locator('.foot a[href$="/settings"]')
  const part = settings.locator('.cbx-icon__part').first()
  const transform = () => part.evaluate((el) => getComputedStyle(el).transform)
  const iconColor = () => settings.locator('.cbx-icon').evaluate((el) => getComputedStyle(el).color)
  const restColor = await iconColor()
  const rest = await transform()
  await settings.hover()
  await expect.poll(transform).not.toBe(rest)
  await page.waitForTimeout(550)
  const hover = await transform()
  const hoverColor = await iconColor()
  assert.notEqual(hoverColor, restColor, 'hover transitions from neutral to brand color')
  await page.mouse.move(700, 30)
  await page.waitForTimeout(50)
  const intermediate = await transform()
  assert.notEqual(intermediate, hover, 'exit transition moves from current frame')
  assert.notEqual(intermediate, rest, 'exit transition must not snap to rest')
  await settings.hover()
  await page.waitForTimeout(600)
  assert.equal(await transform(), hover, 'interrupted transition returns to hover')
  await settings.click()
  await page.mouse.move(700, 30)
  await settings.evaluate((el) => el.blur())
  await page.waitForTimeout(650)
  const selected = await transform()
  assert.notEqual(selected, rest, 'route selection has its own pose')
  assert.notEqual(selected, hover, 'selected and hovered poses are distinct')
  assert.equal(
    await iconColor(),
    hoverColor,
    'selection retains the brand color after pointer exit',
  )

  // Mount every glyph, including variants that normally require populated data.
  const count = await page.evaluate(async () => {
    const { createApp, h } = await import('/node_modules/.vite/deps/vue.js')
    const { default: AppIcon } = await import('/src/components/icons/AppIcon.vue')
    const { iconArtwork } = await import('/src/components/icons/artwork.ts')
    const names = Object.keys(iconArtwork)
    const host = document.createElement('div')
    host.id = 'icon-audit'
    host.style.cssText =
      'position:fixed;inset:0;z-index:999;background:var(--cbx-bg);padding:32px;overflow:auto'
    document.body.append(host)
    const app = createApp({
      render: () =>
        h('div', [
          h('h2', { style: 'margin-bottom:24px' }, 'SVG · 常态 / 激活'),
          h(
            'div',
            { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:12px' },
            names.map((name) =>
              h(
                'div',
                {
                  style:
                    'display:flex;align-items:center;gap:16px;border:1px solid var(--cbx-border);border-radius:12px;padding:16px;font-size:11px',
                },
                [
                  h('button', { 'data-audit': name, class: 'cbx-icon-btn', 'aria-label': name }, [
                    h(AppIcon, { name, tone: 'brand' }),
                  ]),
                  h(AppIcon, { name, tone: 'brand', active: true }),
                  h('span', name),
                ],
              ),
            ),
          ),
          h('button', { id: 'disabled-audit', disabled: true }, [h(AppIcon, { name: 'Plus' })]),
          h('button', { id: 'loading-audit', disabled: true }, [
            h(AppIcon, { name: 'LoaderCircle' }),
          ]),
          h('button', { id: 'expanded-audit', 'aria-expanded': 'true' }, [
            h(AppIcon, { name: 'Menu', active: true }),
          ]),
        ]),
    })
    app.config.idPrefix = 'audit'
    app.mount(host)
    window.__iconAudit = () => {
      app.unmount()
      host.remove()
    }
    return names.length
  })
  assert.ok(count > 40)
  const geometry = await page.locator('#icon-audit .cbx-icon').evaluateAll((icons) =>
    icons.map((icon) => {
      const b = icon.querySelector('.cbx-icon__optical').getBBox()
      return {
        name: icon.dataset.icon,
        w: b.width,
        h: b.height,
        nodes: icon.querySelectorAll('path,rect,circle,line,ellipse,polyline,polygon').length,
      }
    }),
  )
  for (const glyph of geometry) {
    // 一维字形是合法的：Minus 就是一条横线，getBBox().height 天然为 0，
    // 可见厚度来自描边。所以只要求「有节点 + 至少一个方向有长度」，
    // 真正什么都不画的字形（无节点、或两个方向都为 0）仍然会被抓出来。
    assert.ok(
      glyph.nodes > 0 && (glyph.w > 0 || glyph.h > 0),
      `empty glyph: ${JSON.stringify(glyph)}`,
    )
  }
  const ids = await page.locator('linearGradient').evaluateAll((nodes) => nodes.map((n) => n.id))
  assert.equal(ids.length, new Set(ids).size, 'gradient IDs must be unique for repeated icons')
  await page.screenshot({ path: 'test-results/icons/catalog-light.png' })
  const disabled = page.locator('#disabled-audit .cbx-icon__part').first()
  const disabledRest = await disabled.evaluate((el) => getComputedStyle(el).transform)
  await page.locator('#disabled-audit').hover({ force: true })
  await page.waitForTimeout(500)
  assert.equal(await disabled.evaluate((el) => getComputedStyle(el).transform), disabledRest)
  const menuPart = page.locator('#expanded-audit .cbx-icon__part').first()
  const openPose = await menuPart.evaluate((el) => getComputedStyle(el).transform)
  await page.locator('#expanded-audit').hover()
  await page.waitForTimeout(450)
  assert.equal(
    await menuPart.evaluate((el) => getComputedStyle(el).transform),
    openPose,
    'hover must preserve expanded menu geometry',
  )
  await page.keyboard.press('Tab')
  await page.locator('[data-audit="Copy"]').focus()
  await expect
    .poll(() =>
      page
        .locator('[data-audit="Copy"] .cbx-icon__part')
        .first()
        .evaluate((el) => getComputedStyle(el).transform),
    )
    .not.toBe('none')
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await page.waitForTimeout(500)
  await page.screenshot({ path: 'test-results/icons/catalog-dark.png' })
  const loader = page.locator('#loading-audit .cbx-icon__body')
  const loaderFrame = await loader.evaluate((el) => getComputedStyle(el).transform)
  await page.waitForTimeout(120)
  assert.notEqual(
    await loader.evaluate((el) => getComputedStyle(el).transform),
    loaderFrame,
    'disabled busy action keeps loading feedback',
  )

  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await page.locator('.cbx-icon').evaluateAll((icons) =>
      icons.every((icon) =>
        [icon, ...icon.querySelectorAll('*')].every((el) => {
          const style = getComputedStyle(el)
          return (
            style.animationName === 'none' &&
            style.transitionDuration.split(',').every((t) => parseFloat(t) === 0)
          )
        }),
      ),
    ),
    true,
    'reduced motion disables all icon animation',
  )
  const menuPoses = await page
    .locator('#icon-audit [data-icon="Menu"]')
    .evaluateAll((icons) =>
      icons.map((icon) =>
        [...icon.querySelectorAll('.cbx-icon__part')].map(
          (part) => getComputedStyle(part).transform,
        ),
      ),
    )
  assert.notDeepEqual(menuPoses[0], menuPoses[1], 'reduced motion preserves open menu geometry')
  await page.evaluate(() => window.__iconAudit())
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  const mobile = await browser.newPage({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  })
  mobile.on('pageerror', (e) => errors.push(e.message))
  await mobile.goto(`${origin}characters`)
  // Vue DevTools 悬浮按钮压在左下角，会挡住抽屉里的「设置」
  await mobile.addStyleTag({ content: '#__vue-devtools-container__{display:none!important}' })
  const menu = mobile.getByRole('button', { name: '菜单', exact: true })
  await expect(menu).toBeVisible()
  await menu.tap()
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await expect(mobile.locator('.sidebar')).toHaveClass(/sidebar--open/)
  await mobile.waitForTimeout(500)
  await mobile.screenshot({ path: 'test-results/icons/mobile-drawer.png' })
  // 手机上角色 / 演绎 / 世界书 / 模型 / 数据都在底部标签栏，抽屉里只剩「设置」
  await expect(mobile.locator('.foot .cbx-nav-item')).toHaveCount(1)
  await expect(mobile.locator('.tabbar .tab')).toHaveCount(5)
  await mobile.locator('.foot a[href$="/settings"]').tap()
  await expect(mobile).toHaveURL(/\/settings$/)
  await expect(mobile.locator('.sidebar')).not.toHaveClass(/sidebar--open/)
  assert.equal(
    await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  )
  assert.deepEqual(errors, [], 'no browser runtime errors')
  console.log(
    `✓ ${count} SVG glyphs; routes, transitions, selected/disabled/focus states, unique gradients, dark theme, reduced motion, mobile drawer`,
  )
} finally {
  await browser?.close()
  await server.close()
}
