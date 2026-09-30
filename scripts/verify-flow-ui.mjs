/**
 * 流程控制端到端：独立浏览器 + 本地流式 mock LLM，不碰真实数据、不调用付费服务。
 *
 * 跑法： npm run verify:flow-ui   （截图输出到 test-results/flow/）
 *
 * 覆盖：数值字段夹上限、初始阶段引导注入、规则触发（固定台词 / 引导 / 设变量 /
 * 激活世界书 / 打开配图面板）、阶段切换、下一轮注入、重新生成连带删固定台词、
 * 「流程」标记点开明细（桌面 + 手机）、演绎静音 + 预览发言者一致。
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

// ── mock LLM：好感度按轮数递增（40 / 80 / 120），第 3 轮故意超上限 ──
const requests = []
function replyFor(body) {
  const msgs = body.messages
  const all = msgs.map((m) => m.content).join('\n')
  const nudge = all.match(/只以 (\S+) 的身份/)
  const required = all.match(/必须包含以下每个人各一项：([^、（\n]+)/)
  const speaker = nudge?.[1] ?? required?.[1] ?? '艾莉'
  const n = msgs.filter((m) => m.role === 'user' && !m.content.includes('【')).length
  const status = {
    场景: { 地点: '酒馆' },
    人物: [{ 名字: speaker, 好感度: String(n * 40) }, { 名字: '我' }],
  }
  return `${speaker}笑了笑，第${n}轮。\n\n<status>${JSON.stringify(status)}</status>`
}
const mock = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS')
  res.setHeader(
    'access-control-allow-headers',
    req.headers['access-control-request-headers'] ?? '*',
  )
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
  for (let i = 0; i < text.length; i += 8) {
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 8) } }] })}\n\n`,
    )
    await new Promise((r) => setTimeout(r, 15))
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
  await mkdir('test-results/flow', { recursive: true })
  const hideDevtools = () =>
    page.addStyleTag({ content: '#__vue-devtools-container__{display:none!important}' })

  // 首次进页面会触发依赖预构建整页重载，先预热
  await page.goto(`${origin}chat`)
  await page.waitForTimeout(1500)
  await page.goto(`${origin}chat`)
  await hideDevtools()

  // ── 种数据：mock 服务、好感度数值字段、世界书条目、带流程的角色 ──
  const seeded = await page.evaluate(async (base) => {
    const { useSettingsStore } = await import('/src/stores/settings.ts')
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const { useWorldsStore } = await import('/src/stores/worlds.ts')
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const { defaultSettings } = await import('/src/types/settings.ts')
    const s = useSettingsStore()
    if (!s.loaded) await s.load()
    await s.saveModelService(
      {
        id: 'mock',
        name: 'mock',
        provider: {
          ...defaultSettings().provider,
          baseUrl: base,
          model: 'mock',
          secretRef: 'mock',
          stream: true,
        },
      },
      'sk-test',
    )
    await s.selectModelService('mock')
    s.settings.chat.streamFlushMs = 20
    s.settings.status.fields.push({
      key: '好感度',
      scope: 'char',
      kind: 'number',
      enabled: true,
      min: 0,
      max: 100,
    })
    s.touch()

    const worlds = useWorldsStore()
    if (!worlds.loaded) await worlds.load()
    const book = await worlds.create('流程测试书')
    const entry = await worlds.addEntry(book.id)
    entry.key = ['从未出现的关键词']
    entry.comment = '灯塔的秘密'
    entry.content = '灯塔地下室藏着一封旧信。'
    book.entries[String(entry.uid)] = entry
    await worlds.save(book)

    const chars = useCharactersStore()
    if (!chars.loaded) await chars.load()
    const c = await chars.create('艾莉')
    c.data.first_mes = '*艾莉擦着杯子。* 欢迎。'
    c.worldBookIds = [book.id]
    c.data.extensions.np = {
      ...(c.data.extensions.np ?? {}),
      flow: {
        rules: [
          {
            id: 'r1',
            name: '好感突破',
            enabled: true,
            trigger: { kind: 'afterReply' },
            match: 'all',
            conditions: [
              {
                id: 'c1',
                source: 'person',
                who: '{{char}}',
                key: '好感度',
                op: 'gte',
                value: '60',
              },
            ],
            mode: 'once',
            actions: [
              { id: 'a1', kind: 'say', text: '{{user}}，谢谢你一直陪着我。' },
              { id: 'a2', kind: 'guide', text: '{{char}}想起了往事', turns: 2 },
              { id: 'a3', kind: 'setVar', key: '关系', value: '朋友' },
              { id: 'a4', kind: 'activateLore', book: book.id, uid: entry.uid, turns: 1 },
              { id: 'a5', kind: 'image' },
            ],
          },
        ],
        stages: [
          {
            id: 's1',
            name: '相识',
            guide: '{{char}}还很拘谨',
            transitions: [
              {
                id: 't1',
                to: 's2',
                match: 'all',
                conditions: [
                  {
                    id: 'c2',
                    source: 'person',
                    who: '{{char}}',
                    key: '好感度',
                    op: 'gte',
                    value: '60',
                  },
                ],
              },
            ],
          },
          { id: 's2', name: '熟悉', guide: '{{char}}开始主动分享', transitions: [] },
        ],
      },
    }
    await chars.save(c)
    const meta = await useChatsStore().createSolo(c.id, '流程测试')
    return { chatId: meta.id, charId: c.id }
  }, mockBase)
  // 设置是防抖落盘的：等它写完再整页跳转
  await page.waitForTimeout(800)

  // ── 节点流程图：角色卡「流程」页签 ──
  await page.goto(`${origin}characters/${seeded.charId}`)
  await hideDevtools()
  await page.getByRole('button', { name: '流程', exact: true }).click()
  // 2 个阶段 + 1 条规则 + 5 个动作；连线 = 1 条阶段出口 + 5 条动作链
  await expect(page.locator('.vue-flow__node')).toHaveCount(8)
  await expect(page.locator('.fe')).toHaveCount(6)
  await expect(page.locator('.fe__dot animateMotion')).toHaveCount(6)
  assert.equal(
    await page
      .locator('.fe__flow')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    'fe-flow',
    '连线有流动动画',
  )
  await page.locator('.fn--rule').click()
  await expect(page.locator('.fi-kind').first()).toHaveText('规则')
  await page.locator('.fe-label').first().click()
  await expect(page.locator('.fi-kind').first()).toHaveText('阶段出口')
  await page.screenshot({ path: 'test-results/flow/graph-editor.png' })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.equal(
    await page
      .locator('.fe__flow')
      .first()
      .evaluate((el) => getComputedStyle(el).animationName),
    'none',
    '减少动态效果时停掉连线动画',
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  await page.goto(`${origin}chat/${seeded.chatId}`)
  await hideDevtools()

  const composer = page.locator('.composer textarea')
  const store = (fn, arg) =>
    page.evaluate(
      async ([src, a]) => {
        const { useChatsStore } = await import('/src/stores/chats.ts')
        const { useGenerationStore } = await import('/src/stores/generation.ts')
        const { useImageJobStore } = await import('/src/stores/imageJob.ts')
        const f = new Function('ctx', 'arg', `return (${src})(ctx, arg)`)
        return f({ chats: useChatsStore(), gen: useGenerationStore(), img: useImageJobStore() }, a)
      },
      [fn.toString(), arg],
    )
  const idle = () => expect.poll(() => store(({ gen }) => gen.busy), { timeout: 15000 }).toBe(false)
  const reqText = (i) => requests[i].messages.map((m) => m.content).join('\n')
  async function send(text) {
    const reqBefore = requests.length
    const msgBefore = await store(({ chats }) => chats.messages.length)
    await composer.fill(text)
    // 发送后有 850ms 纸飞机动画，期间输入框不接受再次发送；mock 回复比动画还快，要等按钮恢复
    await expect(page.locator('.send-button')).toBeEnabled({ timeout: 5000 })
    await composer.press('Enter')
    // 不靠采样 busy=true：mock 回复很快，可能在两次轮询之间就结束了
    try {
      await expect.poll(() => requests.length, { timeout: 10000 }).toBeGreaterThan(reqBefore)
    } catch (e) {
      const diag = await store(({ chats, gen }) => ({
        busy: gen.busy,
        count: chats.messages.length,
        current: chats.current?.id,
        last: chats.messages.at(-1)?.mes,
      }))
      const toasts = await page
        .locator('.cbx-toast, [role="alert"]')
        .allInnerTexts()
        .catch(() => [])
      console.error('发送后 mock 没收到请求', { msgBefore, diag, toasts, errors })
      await page.screenshot({ path: 'test-results/flow/send-failed.png' })
      throw e
    }
    await idle()
    try {
      await expect
        .poll(() => store(({ chats }) => chats.messages.length))
        .toBeGreaterThan(msgBefore)
    } catch (e) {
      const diag = await store(({ chats, gen }) => ({
        busy: gen.busy,
        current: chats.current?.id,
        kind: chats.current?.kind,
        msgs: chats.messages.map((m) => `${m.is_user ? 'U' : 'A'}:${m.name}:${m.mes.slice(0, 40)}`),
      }))
      const last = requests.at(-1)
      console.error('请求已发出但消息数没变', {
        msgBefore,
        diag,
        url: page.url(),
        reqCount: requests.length,
        lastReq: last && {
          stream: last.stream,
          tail: last.messages.slice(-2).map((m) => `${m.role}:${String(m.content).slice(0, 80)}`),
        },
        errors,
      })
      await page.screenshot({ path: 'test-results/flow/send-failed.png' })
      throw e
    }
  }
  const closeImage = () => store(({ img }) => img.finish())

  // ── 第 1 轮：好感度 40，规则不触发，注入初始阶段引导 ──
  await send('你好')
  assert.ok(
    reqText(requests.length - 1).includes('【当前阶段：相识】艾莉还很拘谨'),
    '初始阶段引导注入',
  )
  let msgs = await store(({ chats }) => chats.messages)
  assert.equal(msgs.at(-1).extra.status.data.people[0].fields['好感度'], '40')
  assert.ok(!msgs.at(-1).extra.flow?.log, '第 1 轮没有触发')

  // ── 第 2 轮：好感度 80，规则触发 + 阶段切换 ──
  await send('继续')
  msgs = await store(({ chats }) => chats.messages)
  const say = msgs.at(-1)
  const reply2 = msgs.at(-2)
  assert.ok(
    say.extra.flowSay && say.mes === '我，谢谢你一直陪着我。',
    `固定台词插在回复后：${say.mes}`,
  )
  assert.ok(reply2.extra.flow.log.includes('好感突破'), '日志记下规则')
  assert.ok(
    reply2.extra.flow.log.some((l) => l.includes('相识 → 熟悉')),
    '日志记下阶段切换',
  )
  assert.equal(reply2.extra.flow.stages[seeded.charId], 's2')
  const vars = await store(({ chats }) => chats.current.chat_metadata.variables)
  assert.equal(vars['关系'], '朋友', '设变量写进会话')
  await expect.poll(() => store(({ img }) => !!img.job)).toBe(true)
  await closeImage()

  // ── 重新生成：固定台词跟着删、规则重新触发一次，不重复 ──
  await store(({ gen }) => gen.regenerate())
  await idle()
  msgs = await store(({ chats }) => chats.messages)
  assert.equal(msgs.filter((m) => m.extra?.flowSay).length, 1, '重新生成后只有一条固定台词')
  assert.ok(msgs.at(-1).extra.flowSay, '固定台词仍在末尾')
  await expect.poll(() => store(({ img }) => !!img.job)).toBe(true)
  await closeImage()

  // ── 第 3 轮：注入新阶段引导 + 规则引导 + 激活的世界书；好感度 120 夹到 100 ──
  await send('然后呢')
  const r3 = reqText(requests.length - 1)
  assert.ok(r3.includes('【当前阶段：熟悉】艾莉开始主动分享'), '切换后的阶段引导')
  assert.ok(r3.includes('艾莉想起了往事'), '规则引导注入')
  assert.ok(r3.includes('灯塔地下室藏着一封旧信'), '流程激活的世界书条目注入')
  assert.ok(!r3.includes('还很拘谨'), '旧阶段引导不再注入')
  msgs = await store(({ chats }) => chats.messages)
  assert.equal(msgs.at(-1).extra.status.data.people[0].fields['好感度'], '100', '数值夹到上限')
  const r4Lore = await store(({ chats }) => chats.messages.at(-1).extra.flow.lore)
  assert.ok(!r4Lore, '世界书激活 1 轮后失效')

  // ── 「流程 · N」标记：点开明细（桌面） ──
  const badge = page.locator('button.flow-log').first()
  await expect(badge).toBeVisible()
  await badge.click()
  await expect(page.locator('.flow-detail').first()).toContainText('好感突破')
  await expect(page.locator('.flow-detail').first()).toContainText('相识 → 熟悉')
  await page.screenshot({ path: 'test-results/flow/desktop-badge.png' })
  await badge.click()
  await expect(page.locator('.flow-detail')).toHaveCount(0)

  // ── 手机宽度：同一个页面缩窄（IndexedDB 按上下文隔离，不能开新上下文） ──
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(400)
  const mBadge = page.locator('button.flow-log').first()
  await mBadge.scrollIntoViewIfNeeded()
  await mBadge.click()
  await expect(page.locator('.flow-detail').first()).toContainText('好感突破')
  const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  assert.equal(hscroll, false, '手机宽度不横向溢出')
  await page.screenshot({ path: 'test-results/flow/mobile-badge.png' })
  await page.setViewportSize({ width: 1440, height: 900 })

  // ── 演绎：规则静音小红；预览发言者与实际发言一致 ──
  const g = await page.evaluate(async () => {
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const { useGroupsStore } = await import('/src/stores/groups.ts')
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const chars = useCharactersStore()
    const a = await chars.create('阿蓝')
    const b = await chars.create('小红')
    const groups = useGroupsStore()
    if (!groups.loaded) await groups.load()
    const grp = await groups.create('流程群')
    grp.members = [a.id, b.id]
    grp.activation_strategy = 1 // 列表：所有未静音成员依次发言
    grp.flow = {
      rules: [
        {
          id: 'gm',
          name: '让小红安静',
          enabled: true,
          trigger: { kind: 'afterReply' },
          match: 'all',
          conditions: [],
          mode: 'once',
          actions: [{ id: 'm1', kind: 'mute', who: '小红' }],
        },
      ],
    }
    await groups.save(grp)
    const meta = await useChatsStore().createGroup(grp.id, '流程演绎')
    return { chatId: meta.id, blueId: a.id, redId: b.id }
  })
  await page.goto(`${origin}chat/${g.chatId}`)
  await hideDevtools()

  // 第 1 轮：发言者在规则触发前就选好了，两人都说；规则在阿蓝回复后静音小红
  await send('大家好')
  msgs = await store(({ chats }) => chats.messages)
  const ai1 = msgs.filter((m) => !m.is_user && !m.is_system)
  assert.deepEqual(
    ai1.map((m) => m.name),
    ['阿蓝', '小红'],
    `第 1 轮两人都说：${ai1.map((m) => m.name).join()}`,
  )
  const lastFlow = [...msgs].reverse().find((m) => m.extra?.flow)?.extra.flow
  assert.deepEqual(lastFlow?.muted, ['小红'], '运行态记下静音')

  // 预览默认发言者不应是被流程静音的小红
  const preview = await store(({ gen }) => gen.previewSpeakers())
  assert.notEqual(preview?.defaultId, g.redId, '预览发言者考虑了流程静音')

  // 第 2 轮：只有阿蓝发言
  const before = msgs.length
  await send('再来')
  msgs = await store(({ chats }) => chats.messages)
  const ai2 = msgs.slice(before).filter((m) => !m.is_user && !m.is_system)
  assert.deepEqual(
    ai2.map((m) => m.name),
    ['阿蓝'],
    `第 2 轮小红被静音：${ai2.map((m) => m.name).join()}`,
  )
  // 演绎设置本身没被改
  const disabled = await page.evaluate(async () => {
    const { useGroupsStore } = await import('/src/stores/groups.ts')
    return useGroupsStore().items.find((x) => x.name === '流程群')?.disabled_members
  })
  assert.deepEqual(disabled, [], '流程静音不改演绎设置')
  await page.screenshot({ path: 'test-results/flow/group-muted.png' })

  assert.deepEqual(errors, [], `页面报错：${errors.join(' | ')}`)
  console.log('✓ 流程控制端到端通过')
} finally {
  await browser?.close()
  await server.close()
  mock.close()
}
