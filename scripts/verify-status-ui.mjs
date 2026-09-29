/**
 * 角色状态端到端：独立浏览器 + 本地流式 mock LLM，不碰真实数据、不调用付费服务。
 *
 * 跑法： npm run verify:status-ui   （截图输出到 test-results/status/）
 *
 * 覆盖：流式期间气泡不闪 JSON、落库剥离、下一轮只注入最新一份、历史不带状态、
 * 手改后以手改为准、删消息回滚、坏 JSON 沿用上一份并报警、群聊两位发言者、
 * 预览提示词可见、桌面固定/浮层、手机浮层（聚焦输入框收起 / 返回键关闭）。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

// ── mock LLM ──────────────────────────────────────────────
const requests = []
function replyFor(body) {
  const msgs = body.messages
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? ''
  const nudge = msgs.map((m) => m.content).join('\n').match(/只以 (\S+) 的身份/)
  // 1v1 没有 nudge：取状态提示词里必填名单的第一个（= 本轮发言者）
  const required = msgs
    .map((m) => m.content)
    .join('\n')
    .match(/必须包含以下每个人各一项：([^、（\n]+)/)
  const speaker = nudge?.[1] ?? required?.[1] ?? '艾莉'
  const n = msgs.filter((m) => m.role === 'user' && !m.content.includes('【')).length
  if (lastUser.includes('坏')) return `${speaker}皱了皱眉。\n<status>{"场景":{"时间":坏掉的</status>`
  const status = {
    场景: { 时间: `第1天 第${n}刻`, 地点: '酒馆', 天气: '小雨' },
    人物: [
      { 名字: speaker, 心理状态: `平静${n}`, 背包: ['短剑', `物品${n}`] },
      { 名字: '我', 背包: ['钱袋'] },
    ],
  }
  return `${speaker}把酒杯推了过来，第${n}轮。\n\n<status>${JSON.stringify(status)}</status>`
}
const mock = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS')
  // Authorization 不被 * 覆盖，必须回显
  res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*')
  if (req.method === 'OPTIONS') return res.end()
  let raw = ''
  for await (const c of req) raw += c
  const body = JSON.parse(raw || '{}')
  requests.push(body)
  const text = replyFor(body)
  if (!body.stream) {
    res.setHeader('content-type', 'application/json')
    return res.end(JSON.stringify({ choices: [{ message: { content: text } }] }))
  }
  res.setHeader('content-type', 'text/event-stream')
  for (let i = 0; i < text.length; i += 6) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 6) } }] })}\n\n`)
    await new Promise((r) => setTimeout(r, 25))
  }
  res.end('data: [DONE]\n\n')
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockBase = `http://127.0.0.1:${mock.address().port}/v1`

const server = await createServer({
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, open: false },
})
let browser
try {
  await server.listen()
  const origin = server.resolvedUrls.local[0]
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await mkdir('test-results/status', { recursive: true })
  // Vue DevTools 悬浮按钮会挡住点击
  const hideDevtools = () =>
    page.addStyleTag({ content: '#__vue-devtools-container__{display:none!important}' })

  // 首次进 /models 等页面会触发依赖预构建整页重载，先预热
  await page.goto(`${origin}chat`)
  await page.waitForTimeout(1500)
  await page.goto(`${origin}chat`)
  await hideDevtools()

  const chatId = await page.evaluate(async (base) => {
    const { useSettingsStore } = await import('/src/stores/settings.ts')
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const { defaultSettings } = await import('/src/types/settings.ts')
    const s = useSettingsStore()
    if (!s.loaded) await s.load()
    await s.saveModelService(
      {
        id: 'mock',
        name: 'mock',
        provider: { ...defaultSettings().provider, baseUrl: base, model: 'mock', secretRef: 'mock', stream: true },
      },
      'sk-test',
    )
    await s.selectModelService('mock')
    s.settings.chat.streamFlushMs = 20
    const chars = useCharactersStore()
    if (!chars.loaded) await chars.load()
    const c = await chars.create('艾莉')
    c.data.first_mes = '*艾莉擦着杯子。* 欢迎。'
    await chars.save(c)
    const meta = await useChatsStore().createSolo(c.id, '状态测试')
    return meta.id
  }, mockBase)
  await page.goto(`${origin}chat/${chatId}`)
  await hideDevtools()

  const composer = page.locator('.composer textarea')
  const store = (fn, arg) =>
    page.evaluate(
      async ([src, a]) => {
        const { useChatsStore } = await import('/src/stores/chats.ts')
        const { useStatusStore } = await import('/src/stores/status.ts')
        const { useGenerationStore } = await import('/src/stores/generation.ts')
        const { useUiStore } = await import('/src/stores/ui.ts')
        const f = new Function('ctx', 'arg', `return (${src})(ctx, arg)`)
        return f(
          { chats: useChatsStore(), status: useStatusStore(), gen: useGenerationStore(), ui: useUiStore() },
          a,
        )
      },
      [fn.toString(), arg],
    )
  const idle = () => expect.poll(() => store(({ gen }) => gen.busy), { timeout: 15000 }).toBe(false)

  async function send(text) {
    await composer.fill(text)
    // 流式期间持续采样气泡文字：任何时刻都不能出现状态 JSON
    let leaked = ''
    const sampler = setInterval(async () => {
      const t = await page
        .locator('.stream')
        .innerText()
        .catch(() => '')
      if (/<sta|"场景"/.test(t)) leaked = t
    }, 15)
    await composer.press('Enter')
    await expect.poll(() => store(({ gen }) => gen.busy)).toBe(true)
    await idle()
    clearInterval(sampler)
    assert.equal(leaked, '', `流式期间气泡里出现了状态 JSON：${leaked.slice(-120)}`)
  }

  // ── 第 1 轮 ──
  await send('你好')
  let last = await store(({ chats }) => chats.messages.at(-1))
  assert.ok(!last.mes.includes('<status'), '正文落库不带状态块')
  assert.equal(last.mes, '艾莉把酒杯推了过来，第1轮。')
  assert.equal(last.extra.status.data.scene['时间'], '第1天 第1刻')
  assert.equal(last.extra.status.source, 'ai')
  // 入口圆点：侧栏关着时来了新快照
  await expect(page.locator('.status-toggle .status-dot')).toBeVisible()

  // ── 第 2 轮：只注入最新一份，历史 assistant 不带状态 ──
  await send('继续')
  const req2 = requests.at(-1)
  const all2 = req2.messages.map((m) => m.content).join('\n')
  assert.equal(all2.split('【角色状态】').length - 1, 1, '只有一份状态注入')
  assert.ok(all2.includes('第1天 第1刻'), '注入的是上一轮的最新状态')
  for (const m of req2.messages.filter((x) => x.role === 'assistant')) {
    assert.ok(!m.content.includes('<status'), `历史 assistant 不带状态：${m.content}`)
  }
  // 状态注入是最后一条（depth 0、order 最大）
  assert.ok(req2.messages.at(-1).content.includes('【角色状态】'), 'depth 0：状态注入紧贴末尾')

  // ── 侧栏：桌面浮层 ──
  await page.getByRole('button', { name: '角色状态' }).click()
  const panel = page.locator('aside.sp')
  await expect(panel).toHaveClass(/sp--overlay/)
  await expect(panel).toHaveClass(/sp--open/)
  await expect(panel.getByText('第1天 第2刻')).toBeVisible()
  await expect(page.locator('.status-toggle .status-dot')).toHaveCount(0)
  await page.waitForTimeout(300)
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/status/desktop-overlay.png' })

  // 历史页签：两份快照 + diff
  await panel.getByRole('tab', { name: /历史/ }).click()
  await expect(panel.locator('.sp-hist__item')).toHaveCount(2)
  await expect(panel.getByRole('tab', { name: /历史/ })).toHaveClass(/cbx-tab--active/)
  await expect(panel.getByRole('tab', { name: '当前' })).not.toHaveClass(/cbx-tab--active/)
  await expect(panel.locator('.sp-hist__item').first().getByText('+物品2')).toBeVisible()
  await expect(panel.locator('.sp-hist__item').first().getByText('−物品1')).toBeVisible()
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/status/desktop-history.png' })
  await panel.getByRole('tab', { name: '当前' }).click()

  // ── 固定常驻 ──
  await panel.getByRole('button', { name: '固定侧栏' }).click()
  await expect(panel).toHaveClass(/sp--docked/)
  await expect(panel.getByRole('button', { name: '固定侧栏' })).toHaveClass(/sp-icon--on/)
  const docked = await panel.boundingBox()
  assert.equal(Math.round(docked.width), 320)
  const chatCol = await page.locator('.chat-col').boundingBox()
  assert.ok(chatCol.x + chatCol.width <= docked.x + 1, '常驻时聊天列让出宽度')
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/status/desktop-docked.png' })

  // ── 手改 → 下一轮以手改为准 ──
  await panel.getByRole('button', { name: '编辑状态' }).click()
  await panel.locator('#sc-地点').fill('城门口')
  await panel.getByRole('button', { name: '保存' }).click()
  await expect(panel.getByText('城门口')).toBeVisible()
  last = await store(({ chats }) => chats.messages.at(-1))
  assert.equal(last.extra.status.source, 'user')
  await send('走吧')
  assert.ok(
    requests.at(-1).messages.at(-1).content.includes('城门口'),
    '手改后的状态被注入下一轮',
  )
  // 固定时发送不收起
  await expect(panel).toHaveClass(/sp--open/)

  // ── 删消息 → 状态回滚 ──
  const before = await store(({ status }) => status.current.status.data.scene['时间'])
  assert.equal(before, '第1天 第3刻')
  await store(async ({ chats }) => {
    const m = chats.messages.at(-1)
    await chats.deleteMessage(m.id)
  })
  assert.equal(await store(({ status }) => status.current.status.data.scene['地点']), '城门口')

  // ── 坏 JSON：沿用上一份 + 报警 ──
  await send('坏一下')
  last = await store(({ chats }) => chats.messages.at(-1))
  assert.equal(last.mes, '艾莉皱了皱眉。')
  assert.ok(!last.extra.status && last.extra.statusError, '失败写 statusError')
  assert.equal(await store(({ status }) => status.current.status.data.scene['地点']), '城门口')
  await expect(panel.locator('.sp-warn')).toBeVisible()
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/status/desktop-error.png' })

  // ── 预览提示词能看到 STATUS 注入 ──
  const keys = await store(({ gen }) => gen.build({ isDryRun: true }).debug.injections.map((i) => i.key))
  assert.ok(keys.includes('STATUS'), `预览含 STATUS 注入：${keys}`)

  // ── 暗色 ──
  await page.emulateMedia({ colorScheme: 'dark' })
  await store(({ ui }) => ui.applyTheme('system'))
  await page.waitForTimeout(200)
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/status/desktop-docked-dark.png' })
  await page.emulateMedia({ colorScheme: 'light' })

  // ── 角色卡「状态」页签：专属字段（含仅用户字段）+ 初始状态 ──
  const linaId = await page.evaluate(async () => {
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const c = await useCharactersStore().create('莉娜')
    return c.id
  })
  await page.goto(`${origin}characters/${linaId}`)
  await hideDevtools()
  await page.getByRole('button', { name: '高级', exact: true }).click()
  await expect(page.getByText('角色状态（覆盖全局')).toHaveCount(0)
  await page.getByRole('button', { name: '状态', exact: true }).click()
  const statusPane = page.locator('section.pane').filter({ has: page.locator('.sce') })
  await statusPane.getByText('使用这个角色专属的状态字段').click()
  await statusPane.getByRole('button', { name: '添加字段' }).click()
  const newRow = statusPane.locator('.sfe-row').last()
  await newRow.locator('.sfe-key').fill('任务')
  await newRow.locator('.sfe-key').press('Tab')
  await newRow.locator('.sfe-sel').first().selectOption('user')
  // 初始状态表单：场景 + 莉娜 + 我（名字锁定）
  const initForm = statusPane.locator('.ed')
  await expect(initForm.locator('.ed-person__fixed')).toHaveCount(2)
  await initForm.locator('#sc-地点').fill('神殿')
  const linaCard = initForm.locator('.ed-group').filter({ hasText: '莉娜' })
  await linaCard.locator('.ed-row').filter({ hasText: '背包' }).locator('input').fill('法杖')
  await linaCard.locator('.ed-row').filter({ hasText: '背包' }).locator('input').press('Enter')
  const meCard = initForm.locator('.ed-group').filter({ hasText: '你' })
  await expect(meCard.locator('.ed-row').filter({ hasText: '关系' })).toHaveCount(0)
  await expect(linaCard.locator('.ed-row').filter({ hasText: '任务' })).toHaveCount(0)
  await meCard.locator('.ed-row').filter({ hasText: '任务' }).locator('input').fill('寻找圣物')
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/status/character-status-tab.png', fullPage: true })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const savedCfg = await page.evaluate(async (id) => {
    const { getDb } = await import('/src/db/schema.ts')
    return (await (await getDb()).get('characters', id)).data.extensions.np.status
  }, linaId)
  assert.equal(savedCfg.initial.scene['地点'], '神殿', '初始状态落库')
  assert.ok(savedCfg.fields.some((f) => f.key === '任务' && f.scope === 'user'), '仅用户字段落库')

  const linaChat = await page.evaluate(async (id) => {
    const { useChatsStore } = await import('/src/stores/chats.ts')
    return (await useChatsStore().createSolo(id, '莉娜测试')).id
  }, linaId)
  await page.goto(`${origin}chat/${linaChat}`)
  await hideDevtools()
  await send('你好')
  const linaReq = requests.at(-1).messages.at(-1).content
  assert.ok(linaReq.includes('神殿') && linaReq.includes('寻找圣物'), '首轮注入角色卡初始状态')
  const skel = JSON.parse(linaReq.match(/<status>(.*)<\/status>/)[1])
  assert.ok('任务' in skel['人物'][1] && !('任务' in skel['人物'][0]), '仅用户字段只在用户骨架里')
  assert.ok('关系' in skel['人物'][0] && !('关系' in skel['人物'][1]), '仅角色字段只在角色骨架里')
  // mock 没写用户的「任务」→ 按字段沿用初始状态
  const linaSnap = await store(({ status }) => status.current.status.data)
  const me = linaSnap.people.find((p) => p.name === '我')
  assert.equal(me.fields['任务'], '寻找圣物', '漏写的字段沿用上一份')
  await expect(page.locator('aside.sp .snap-person--user')).toContainText('任务')
  await expect(page.locator('aside.sp .snap-person:not(.snap-person--user)')).not.toContainText('任务')

  // ── 群聊：「状态」页签初始状态 + 每位成员都有记录（漏写沿用） ──
  const { groupId, groupChat } = await page.evaluate(async () => {
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const { useGroupsStore } = await import('/src/stores/groups.ts')
    const chars = useCharactersStore()
    const a = await chars.create('阿蓝')
    const b = await chars.create('小红')
    // 小红的角色卡上有本人初始状态；群聊页不给她填，应回落到这里
    b.data.extensions.np = { status: { initial: { scene: {}, people: [{ name: '小红', fields: { 背包: ['红绳'] } }] } } }
    await chars.save(b)
    const groups = useGroupsStore()
    if (!groups.loaded) await groups.load()
    const g = await groups.create('测试群')
    g.members = [a.id, b.id]
    g.activation_strategy = 1 // 列表：两人都说
    await groups.save(g)
    return { groupId: g.id, groupChat: null }
  })
  await page.goto(`${origin}groups/${groupId}`)
  await hideDevtools()
  await page.getByRole('button', { name: '状态', exact: true }).click()
  const gForm = page.locator('.sce .ed')
  await expect(gForm.locator('.ed-person__fixed')).toHaveCount(3)
  await gForm.locator('#sc-地点').fill('广场')
  const blueRow = gForm.locator('.ed-group').filter({ hasText: '阿蓝' }).locator('.ed-row').filter({ hasText: '背包' })
  await blueRow.locator('input').fill('蓝宝石')
  await blueRow.locator('input').press('Enter')
  await page.waitForTimeout(800) // 防抖静默保存
  await page.screenshot({ path: 'test-results/status/group-status-tab.png', fullPage: true })
  const gCfg = await page.evaluate(async (id) => {
    const { getDb } = await import('/src/db/schema.ts')
    return (await (await getDb()).get('groups', id)).status
  }, groupId)
  assert.equal(gCfg.initial.scene['地点'], '广场', '群聊初始状态防抖落库')

  const gChat = await page.evaluate(async (id) => {
    const { useChatsStore } = await import('/src/stores/chats.ts')
    return (await useChatsStore().createGroup(id, '群聊状态')).id
  }, groupId)
  await page.goto(`${origin}chat/${gChat}`)
  await hideDevtools()
  const before2 = requests.length
  await send('大家好')
  // 群聊的 nudge 在状态注入之后，所以看整份请求而不是最后一条
  const firstGroupReq = requests[before2].messages.map((m) => m.content).join('\n')
  assert.ok(firstGroupReq.includes('蓝宝石') && firstGroupReq.includes('红绳'), '群聊初始：群聊配置 + 角色卡回落')
  assert.ok(firstGroupReq.includes('阿蓝、小红、我'), '必填名单：全员 + 用户')
  const snaps = await store(({ chats }) =>
    chats.messages.filter((m) => m.extra?.status).map((m) => m.extra.status.data),
  )
  assert.deepEqual(snaps.map((d) => d.people[0].name), ['阿蓝', '小红'], '两位发言者各写一份')
  for (const d of snaps) {
    assert.deepEqual(d.people.map((p) => p.name).sort(), ['我', '小红', '阿蓝'].sort(), '每份快照三人都在')
  }
  const hong = snaps[0].people.find((p) => p.name === '小红')
  assert.ok(hong.carried && hong.fields['背包'].includes('红绳'), '阿蓝那轮漏写小红 → 沿用并标记')
  const blue = snaps[1].people.find((p) => p.name === '阿蓝')
  assert.ok(blue.carried && blue.fields['背包'].includes('物品1'), '小红那轮漏写阿蓝 → 沿用阿蓝上一份')
  await expect(page.locator('aside.sp .snap-carried')).toHaveCount(1)
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/status/group-chat-carried.png' })
  const groupMsgs = await store(({ chats }) => chats.messages.filter((m) => !m.is_user).map((m) => m.mes))
  assert.ok(groupMsgs.every((t) => !t.includes('<status')), '群聊正文不带状态')

  // 手机上的群聊「状态」页签
  const phoneG = await ctx.newPage()
  await phoneG.setViewportSize({ width: 390, height: 844 })
  await phoneG.goto(`${origin}groups/${groupId}`)
  await phoneG.addStyleTag({ content: '#__vue-devtools-container__{display:none!important}' })
  await phoneG.getByRole('button', { name: '状态', exact: true }).click()
  await expect(phoneG.locator('.sce .ed')).toBeVisible()
  assert.equal(await phoneG.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '手机群聊状态页无横向溢出')
  await phoneG.waitForTimeout(250)
  await phoneG.screenshot({ path: 'test-results/status/mobile-group-status-tab.png', fullPage: true })
  await phoneG.close()

  // ── 手机：浮层 / 聚焦收起 / 返回键关闭 ──
  await store(({ ui }) => ui.setStatusPinned(false))
  const phone = await ctx.newPage()
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(`${origin}chat/${chatId}`)
  await phone.addStyleTag({ content: '#__vue-devtools-container__{display:none!important}' })
  const mPanel = phone.locator('aside.sp')
  await expect(mPanel).toHaveClass(/sp--overlay/)
  await expect(mPanel).not.toHaveClass(/sp--open/)
  await phone.getByRole('button', { name: '角色状态' }).click()
  await expect(mPanel).toHaveClass(/sp--open/)
  await phone.waitForTimeout(350)
  const box = await mPanel.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390 + 0.5, '手机浮层在屏内')
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await phone.waitForTimeout(250)
  await phone.screenshot({ path: 'test-results/status/mobile-open.png' })
  // 返回键关闭，且仍停在聊天页
  const url = phone.url()
  await phone.goBack()
  await expect(mPanel).not.toHaveClass(/sp--open/)
  assert.equal(phone.url(), url)
  // 聚焦输入框收起
  await phone.getByRole('button', { name: '角色状态' }).click()
  await expect(mPanel).toHaveClass(/sp--open/)
  await phone.locator('.composer textarea').focus()
  await expect(mPanel).not.toHaveClass(/sp--open/)
  await phone.waitForTimeout(300)
  await phone.waitForTimeout(250)
  await phone.screenshot({ path: 'test-results/status/mobile-closed.png' })
  // 手机上侧栏按钮都 ≥44px
  await phone.getByRole('button', { name: '角色状态' }).click()
  const closeBtn = await mPanel.getByRole('button', { name: '关闭状态栏' }).boundingBox()
  assert.ok(closeBtn.height >= 44 && closeBtn.width >= 44, `触控区 ${closeBtn.width}×${closeBtn.height}`)
  await expect(mPanel.getByRole('button', { name: '固定侧栏' })).toHaveCount(0)

  assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
  console.log(`verify:status-ui 全部通过（${requests.length} 次模型请求）`)
} finally {
  await browser?.close()
  await server.close()
  mock.close()
}
