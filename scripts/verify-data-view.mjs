/** 使用本地 IndexedDB 构造数据，验证数据管理页：会话级子表格、分页、其他数据表浏览与级联删除。 */
import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

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
  page.on('pageerror', (error) => errors.push(error.message))
  // evaluate 里的动态 import 需要 vite 运行时，先进入应用任意页面
  await page.goto(`${origin}characters`)

  // ── 构造数据：角色 + 群组 + 单聊 120 条消息（3 页）+ 向量块 120 块 + 3 张配图 ──
  const setup = await page.evaluate(async () => {
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const { useGroupsStore } = await import('/src/stores/groups.ts')
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const { useWorldsStore } = await import('/src/stores/worlds.ts')
    const { blobsRepo, memchunksRepo, messagesRepo } = await import('/src/db/repositories/index.ts')
    const chars = useCharactersStore()
    const groups = useGroupsStore()
    const chats = useChatsStore()
    const worlds = useWorldsStore()

    const char = await chars.create('时雨')
    char.data.description = '深夜书店的魔女'
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 48
    canvas.getContext('2d').fillRect(0, 0, 32, 48)
    const pngUrl = canvas.toDataURL('image/png')
    const avatarBlob = await (await fetch(pngUrl)).blob()
    char.avatarBlobId = await blobsRepo.put(avatarBlob)
    await chars.save(char)

    const book = await worlds.create('测试世界书')
    const group = await groups.create('双人书店')
    group.members = [char.id]
    await groups.save(group)

    const meta = await chats.createSolo(char.id, '雨夜书店')
    await chats.open(meta.id)
    for (let i = 0; i < 120; i++)
      await (i % 2 ? chats.appendAi('时雨', char.id) : chats.appendUser(`消息 ${i}：内容。`))
    // 给最后 3 条消息各挂一张配图 + 一张孤儿图
    const rows = await messagesRepo.all(meta.id)
    const imageBlob = await (await fetch(pngUrl)).blob()
    const msgBlobIds = []
    for (const row of rows.slice(-3)) {
      const updated = await messagesRepo.attachImage(meta.id, row.id, {
        blob: imageBlob,
        prompt: 'p',
        model: 'm',
        serviceName: 's',
      })
      msgBlobIds.push(updated.images.at(-1).blobId)
    }
    const orphanBlobId = await blobsRepo.put(imageBlob)
    // 120 块向量：60 窗口 + 60 事实
    const chunks = []
    for (let i = 0; i < 60; i++) {
      chunks.push(
        {
          chatId: meta.id,
          kindRank: 0,
          ord: i,
          text: `窗口块 ${i}`,
          srcSeqs: [i],
          endSeq: i,
          vec: new Float32Array(8),
          srcHash: 0,
        },
        {
          chatId: meta.id,
          kindRank: 1,
          ord: i,
          text: `事实块 ${i}`,
          srcSeqs: [i],
          endSeq: i,
          vec: new Float32Array(8),
          srcHash: 0,
        },
      )
    }
    await memchunksRepo.putMany(chunks)
    return {
      chatId: meta.id,
      charId: char.id,
      avatarBlobId: char.avatarBlobId,
      orphanBlobId,
      msgBlobIds,
      worldBookId: book.id,
    }
  })

  // ── 数据管理页：整库备份区不动，会话表派生列正确 ──
  await page.goto(`${origin}data`)
  await expect(page.getByRole('heading', { name: '整库备份', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出全部数据', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导入备份', exact: true })).toBeVisible()
  const chatRow = page.locator('.tbl__row', { hasText: '雨夜书店' })
  await expect(chatRow).toBeVisible()
  await expect(chatRow.locator('td').nth(1)).toHaveText('120')
  await expect(chatRow.locator('td').nth(3)).toHaveText('120')
  console.log('✓ 备份区保留、会话表派生列（消息 120 / 向量块 120）')

  // ── 行内展开：四选项卡 ──
  await chatRow.click()
  const panel = page.locator('.exprow .panel')
  await expect(panel).toBeVisible()
  for (const name of ['消息', '向量块', '图片', '状态与设置'])
    await expect(panel.getByRole('tab', { name, exact: true })).toBeVisible()

  // 消息 tab：默认最新一页（第 3/3 页），向上翻页
  await expect(panel.getByText('共 120 条 · 第 3 / 3 页')).toBeVisible()
  await expect(panel.locator('.msgtab tbody tr')).toHaveCount(50)
  await panel.getByRole('button', { name: '更早', exact: true }).click()
  await expect(panel.getByText('共 120 条 · 第 2 / 3 页')).toBeVisible()
  await panel.getByRole('button', { name: '更新', exact: true }).click()
  await expect(panel.getByText('共 120 条 · 第 3 / 3 页')).toBeVisible()
  // 行点击出 JSON 详情
  await panel.locator('.msgtab .dtbl__row').first().click()
  await expect(panel.locator('.msgdetail')).toBeVisible()
  await expect(panel.locator('.msgdetail')).toContainText('"seq"')
  console.log('✓ 消息子表：50/页分页、3 页、行 JSON 详情')

  // 向量块 tab：计数 + 首页 50 行
  await panel.getByRole('tab', { name: '向量块', exact: true }).click()
  await expect(panel.getByText('共 120 块。')).toBeVisible()
  await expect(panel.locator('.chunktab tbody tr')).toHaveCount(50)
  await expect(panel.getByText('第 1 / 3 页')).toBeVisible()
  console.log('✓ 向量块子表：元数据分页（不含向量本体）')

  // 图片 tab：行数与 chatBlobRefs 的引用聚合一致（3 条消息引用同一 blob → 1 行 3 次）
  const refSize = await page.evaluate(
    async (id) => (await (await import('/src/db/repositories/index.ts')).browseRepo.chatBlobRefs(id)).size,
    setup.chatId,
  )
  await panel.getByRole('tab', { name: '图片', exact: true }).click()
  await expect(panel.locator('.imgtab tbody tr')).toHaveCount(refSize)
  assert.ok(refSize >= 1)
  console.log(`✓ 图片子表：按会话引用聚合（${refSize} 个 blob）`)

  // 点缩略图放大预览，Esc 关闭
  await panel.locator('.dpreview__btn').first().click()
  await expect(page.locator('.lightbox[open] .lightbox__img')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.lightbox')).toHaveCount(0)
  console.log('✓ 图片子表：点缩略图放大预览、Esc 关闭')

  // 状态与设置：改名 + 变量保存 + 清空消息（确认弹窗）
  await panel.getByRole('tab', { name: '状态与设置', exact: true }).click()
  await panel.getByLabel('会话标题', { exact: true }).fill('雨夜书店改名')
  await panel.getByLabel('会话标题', { exact: true }).blur()
  await expect(page.locator('.tbl__row', { hasText: '雨夜书店改名' })).toBeVisible()
  await panel.getByRole('button', { name: '添加变量', exact: true }).click()
  await panel.locator('input.varrow__k').first().fill('心情')
  await panel.locator('input.varrow__v').first().fill('平静')
  await panel.getByRole('button', { name: '保存变量', exact: true }).click()
  await expect(chatRow.locator('td').nth(2)).toHaveText('1')
  await panel.getByRole('button', { name: '清空消息', exact: true }).click()
  await page.getByRole("contentinfo").getByRole("button", { name: "清空", exact: true }).click()
  await expect(chatRow.locator('td').nth(1)).toHaveText('0')
  await expect(chatRow.locator('td').nth(3)).toHaveText('0')
  // 清空后消息 tab 缓存被强制失效
  await panel.getByRole('tab', { name: '消息', exact: true }).click()
  await expect(panel.getByText('还没有消息')).toBeVisible()
  await panel.getByRole('tab', { name: '图片', exact: true }).click()
  await expect(panel.getByText('本会话没有引用图片')).toBeVisible()
  console.log('✓ 状态与设置：改名、变量保存、清空消息并级联失效各 tab 缓存')

  // 清空消息连带回收该会话的配图 blob（不再依赖设置页手动「清理未引用」）
  const clearedGone = await page.evaluate(async (ids) => {
    const { blobsRepo } = await import('/src/db/repositories/index.ts')
    const present = await Promise.all(ids.map((id) => blobsRepo.get(id)))
    return present.every((b) => !b)
  }, setup.msgBlobIds)
  assert.ok(clearedGone, '清空消息应连带回收该会话的配图 blob，实测仍在库中')
  console.log('✓ 清空消息连带回收 3 张配图 blob')

  // 多行同时展开：再开一个群聊会话，两块面板互不影响
  await page.evaluate(async ({ charId }) => {
    const { useGroupsStore } = await import('/src/stores/groups.ts')
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const groups = useGroupsStore()
    const chats = useChatsStore()
    await groups.load()
    const group = groups.items[0]
    const meta = await chats.createGroup(group.id, group.name)
    await chats.open(meta.id)
    await chats.appendUser('群聊消息')
  }, { charId: setup.charId })
  await page.goto(`${origin}data`)
  await page.locator('.tbl__row', { hasText: '雨夜书店' }).click()
  await page.locator('.tbl__row', { hasText: '双人书店' }).click()
  await expect(page.locator('.exprow .panel')).toHaveCount(2)
  console.log('✓ 多行同时展开互不影响')

  // ── 其他数据表：六表浏览 ──
  const sb = page.locator('.browser')
  await expect(sb.getByRole('tab', { name: '角色', exact: true })).toBeVisible()
  await expect(sb.locator('tbody tr', { hasText: '时雨' })).toBeVisible()
  await sb.locator('tr', { hasText: '时雨' }).getByRole('button', { name: '详情', exact: true }).click()
  await expect(page.locator('.rowdetail__json')).toContainText('时雨')
  await page.locator('.rowdetail__head button').click()

  await sb.getByRole('tab', { name: '世界书', exact: true }).click()
  await expect(sb.locator('tbody tr', { hasText: '测试世界书' })).toBeVisible()

  // 密钥：写入一条再删除
  await page.evaluate(async () => {
    const { secretsRepo } = await import('/src/db/repositories/index.ts')
    await secretsRepo.set('image-service:test', 'sk-test-value-123456')
  })
  await sb.getByRole('tab', { name: '密钥', exact: true }).click()
  await expect(sb.locator('tbody tr', { hasText: 'image-service:test' })).toBeVisible()
  await expect(sb.locator('tbody tr', { hasText: 'image-service:test' })).toContainText('••••')
  await sb.locator('tr', { hasText: 'image-service:test' }).getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole("contentinfo").getByRole("button", { name: "删除", exact: true }).click()
  await expect(sb.locator('tbody tr', { hasText: 'image-service:test' })).toHaveCount(0)
  console.log('✓ 其他数据：角色详情 JSON、世界书浏览、密钥掩码与删除')

  // 图片表：引用标注 + 清理未引用。清空消息已连带回收配图，这里只剩一张
  // 从未被任何记录引用的孤儿图（orphanBlobId），验证手动清理仍能删它。
  await sb.getByRole('tab', { name: '图片', exact: true }).click()
  await expect(sb.locator('tr', { hasText: '被引用' }).first()).toBeVisible()
  // 行内缩略图直接出图（已取代「详情」按钮），点击放大预览、点背景关闭
  await expect(sb.locator('tbody .dpreview__btn').first()).toBeVisible()
  await expect(sb.locator('tbody tr').first().getByRole('button', { name: '详情', exact: true })).toHaveCount(0)
  // 插桩：记录过渡 ready 时文档上真实跑着的 view-transition 动画（验证共享元素形变确实发生）
  const vtSupported = await page.evaluate(() => {
    window.__vtNames = []
    if (!('startViewTransition' in document)) return false
    const orig = document.startViewTransition.bind(document)
    document.startViewTransition = (cb) => {
      const t = orig(cb)
      t.ready.then(
        () => {
          for (const a of document.getAnimations()) {
            const p = a.effect && a.effect.pseudoElement
            if (p) window.__vtNames.push(p)
          }
        },
        () => {},
      )
      return t
    }
    return true
  })
  await sb.locator('.dpreview__btn').first().click()
  await expect(page.locator('.lightbox[open] .lightbox__img')).toBeVisible()
  if (vtSupported) {
    const names = await page.evaluate(() => window.__vtNames)
    assert.ok(
      names.some((p) => p.includes('cbx-blob-morph')),
      `打开应跑缩略图→大图的共享元素形变，实际伪元素动画：${JSON.stringify(names)}`,
    )
  }
  // 舞台必须铺满整个弹层。曾经是 flex 纵向布局、底栏从布局里切走一条，
  // 放大后图片会在底栏上沿被硬切出一条横边（下面露出压暗的页面）。
  const stageFills = await page.evaluate(() => {
    const r = document.querySelector('.lightbox__stage').getBoundingClientRect()
    return r.x === 0 && r.y === 0 && r.width === innerWidth && r.height === innerHeight
  })
  assert.ok(stageFills, '放大预览的舞台必须铺满视口，否则放大后图片会被容器切断')

  // 缩放：初始 100%（缩小到底禁用）→ 放大 → 点百分比复位
  const pct = page.locator('.lightbox__pct')
  await expect(pct).toHaveText('100%')
  await expect(page.getByRole('button', { name: '缩小', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: '放大', exact: true }).click()
  await expect(pct).toHaveText('150%')
  await pct.click()
  await expect(pct).toHaveText('100%')
  await page.mouse.click(20, 20)
  await expect(page.locator('.lightbox')).toHaveCount(0)
  // 名字留在缩略图上会和下一次撞名，过渡收尾必须摘干净。
  // ⚠️ 不能同步断言：关闭时 dialog 在回调里就被 v-if 摘了，但形变还要再跑 320ms，
  // 名字要等 finished 才卸 —— 同步查必然抓到「残留」，那是动画在飞不是泄漏。
  await page.waitForFunction(
    () => [...document.querySelectorAll('.dpreview__btn')].every((e) => !e.style.viewTransitionName),
    null,
    { timeout: 3000 },
  )
  console.log('✓ 图片表：行内缩略图、无详情按钮、形变过渡、缩放复位、点背景关闭')
  const expectedFree = await page.evaluate(async () => {
    const { browseRepo } = await import('/src/db/repositories/index.ts')
    const { getDb } = await import('/src/db/schema.ts')
    const refs = await browseRepo.referencedBlobIds()
    const db = await getDb()
    const ids = await db.getAllKeys('blobs')
    return ids.filter((id) => !refs.has(id)).length
  })
  assert.ok(expectedFree >= 1, `应有至少 1 张未引用图片，实际 ${expectedFree}`)
  await expect(sb.locator('tr', { hasText: '未引用' })).toHaveCount(expectedFree)
  await sb.getByRole('button', { name: '清理未引用', exact: true }).click()
  await page.getByRole('contentinfo').getByRole('button', { name: '删除', exact: true }).click()
  await expect(sb.locator('tr', { hasText: '未引用' })).toHaveCount(0)
  const orphanGone = await page.evaluate(
    async (id) => !!(await (await import('/src/db/repositories/index.ts')).blobsRepo.get(id)),
    setup.orphanBlobId,
  )
  assert.equal(orphanGone, false)
  console.log('✓ 图片表：引用标注、清理未引用（孤儿已删）')

  // 删除角色 → 级联删它的单聊会话；群聊属于群组，只移除成员不删会话
  await sb.getByRole('tab', { name: '角色', exact: true }).click()
  await sb.locator('tr', { hasText: '时雨' }).getByRole('button', { name: '删除', exact: true }).click()
  await page.getByRole('contentinfo').getByRole('button', { name: '删除', exact: true }).click()
  await expect(sb.locator('tbody tr', { hasText: '时雨' })).toHaveCount(0)
  await expect(page.locator('.tbl__row', { hasText: '雨夜书店' })).toHaveCount(0)
  await expect(page.locator('.tbl__row', { hasText: '双人书店' })).toHaveCount(1)
  console.log('✓ 删除角色级联删除其单聊会话（群聊会话保留，会话区同步刷新）')

  // 窄屏：展开面板与表格不横向溢出
  await page.setViewportSize({ width: 375, height: 812 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

  assert.deepEqual(errors, [])
  console.log('✓ 数据管理页：行内展开子表格、分页、懒加载失效、其他表浏览/级联删除/GC、窄屏不溢出')
} finally {
  await browser?.close()
  await server.close()
}
