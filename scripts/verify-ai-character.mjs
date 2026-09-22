/** 使用独立浏览器与模拟接口验证 AI 创建角色，不调用真实付费服务。 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'

const generated = {
  name: '时雨',
  description: '经营深夜书店的年轻魔女，收藏着城市中被遗忘的故事。',
  personality: '表面冷淡，观察细致；会把关心藏进递给常客的一杯热茶里。',
  scenario: '雨夜，{{user}}推开旧街尽头仍亮着灯的书店。',
  first_mes: '*她合上书，抬眼看向门口。* 这么晚了，来躲雨，还是来找一个故事？',
  alternate_greetings: ['*她把一杯热茶放到空座前。* 你上次要的书到了。'],
  mes_example:
    '<START>\n{{user}}: 你为什么只在晚上开店？\n{{char}}: 白天的故事太吵，夜里才听得清。\n<START>\n{{user}}: 你是在担心我吗？\n{{char}}: *她别开目光。* 我只是怕你把书淋湿。',
}
const wrappedReply =
  '<think>设计角色 {内部思考}</think>\n```json\n' +
  JSON.stringify({
    id: 'must-not-replace-id',
    data: {
      ...generated,
      extensions: { depth_prompt: { prompt: 'must-not-replace-prompt' } },
      system_prompt: 'must-not-replace-system',
    },
  }) +
  '\n```'
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
  const requests = []
  let response = wrappedReply
  let httpStatus = 200
  let hold = false
  let releaseResponse
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://character-proxy.example.test/v1/chat/completions', async (route) => {
    const body = response
    const code = httpStatus
    requests.push({ headers: route.request().headers(), body: route.request().postDataJSON() })
    if (hold)
      await new Promise((resolve) => {
        releaseResponse = resolve
      })
    try {
      await route.fulfill({
        status: code,
        json:
          code === 200
            ? { choices: [{ message: { content: body } }] }
            : { error: { message: '测试接口拒绝了密钥' } },
      })
    } catch (error) {
      // 请求被用户取消或页面离开后，浏览器可能已经关闭这条路由。
      if (!hold) throw error
    }
  })

  await page.goto(`${origin}characters`)
  await page.getByRole('button', { name: '新建角色', exact: true }).click()
  await page.getByRole('button', { name: 'AI 创建角色', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'AI 创建角色', exact: true })
  const description = dialog.getByLabel('描述你想创建的角色', { exact: true })
  await description.fill('经营深夜书店的年轻魔女，冷淡但关心常客。')
  await expect(dialog.getByRole('link', { name: '配置模型服务', exact: true })).toHaveAttribute(
    'href',
    '/models',
  )
  await expect(dialog.getByRole('button', { name: '生成并填入', exact: true })).toBeDisabled()
  assert.equal(requests.length, 0)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  const characterId = page.url().split('/').at(-1)
  // 配置两个服务，只允许当前服务通过指定代理请求；保留角色原有高级设置。
  await page.evaluate(async (id) => {
    const { useSettingsStore } = await import('/src/stores/settings.ts')
    const { defaultSettings } = await import('/src/types/settings.ts')
    const { getDb } = await import('/src/db/schema.ts')
    const store = useSettingsStore()
    await store.saveModelService(
      {
        id: 'unused',
        name: '未选中的服务',
        provider: {
          ...defaultSettings().provider,
          baseUrl: 'https://unused.example.test/v1',
          model: 'unused',
          secretRef: 'unused',
        },
      },
      'test-unused-secret',
    )
    await store.saveModelService(
      {
        id: 'writer',
        name: '角色创作服务',
        provider: {
          ...defaultSettings().provider,
          baseUrl: 'https://writer.example.test/v1',
          model: 'writer-chat',
          secretRef: 'writer',
          proxyPrefix: 'https://character-proxy.example.test',
          temperature: 0.6,
          extraHeaders: { 'X-Character-Test': 'kept' },
        },
      },
      'test-writer-secret',
    )
    await store.selectModelService('writer')
    const db = await getDb()
    const character = await db.get('characters', id)
    character.data.system_prompt = '保留我的高级提示词'
    character.data.creator_notes = '保留我的备注'
    character.data.extensions.depth_prompt.prompt = '保留我的深度提示词'
    character.worldBookIds = ['test-world-book']
    await db.put('characters', character)
  }, characterId)
  await page.reload()
  const name = page.getByLabel('角色名', { exact: true })
  await name.fill('原来的名字')
  await page.getByLabel('角色简介', { exact: true }).fill('原来未保存的简介')
  await page.getByRole('button', { name: 'AI 创建角色', exact: true }).click()
  await expect(dialog.getByText('角色创作服务 · writer-chat', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '生成并填入', exact: true })).toBeDisabled()
  await description.fill('经营深夜书店的年轻魔女，冷淡但关心常客。')
  await dialog.getByRole('button', { name: '生成并填入', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(name).toHaveValue(generated.name)
  await expect(page.getByLabel('角色简介', { exact: true })).toHaveValue(generated.description)
  await expect(page.getByLabel('性格', { exact: true })).toHaveValue(generated.personality)
  await expect(page.getByLabel('场景', { exact: true })).toHaveValue(generated.scenario)
  assert.equal(requests[0].headers.authorization, 'Bearer test-writer-secret')
  assert.equal(requests[0].headers['x-character-test'], 'kept')
  assert.equal(requests[0].body.model, 'writer-chat')
  assert.equal(requests[0].body.temperature, 0.6)
  assert.equal(requests[0].body.stream, false)
  assert.ok(requests[0].body.max_tokens >= 2048)
  assert.equal(requests[0].body.messages[1].content, '经营深夜书店的年轻魔女，冷淡但关心常客。')

  await page.getByRole('button', { name: /^开场白/ }).click()
  await expect(page.locator('section.pane:visible textarea').first()).toHaveValue(
    generated.first_mes,
  )
  await expect(page.locator('section.pane:visible textarea').nth(1)).toHaveValue(
    generated.alternate_greetings[0],
  )
  await page.getByRole('button', { name: '对话示例', exact: true }).click()
  await expect(page.getByText('第 2 组', { exact: true })).toBeVisible()
  await expect(page.locator('section.pane:visible textarea').first()).toHaveValue(
    '你为什么只在晚上开店？',
  )

  // 填入时不自动落盘，撤销应恢复生成前的未保存编辑。
  assert.equal(
    await page.evaluate(async (id) => {
      const { getDb } = await import('/src/db/schema.ts')
      return (await (await getDb()).get('characters', id)).data.name
    }, characterId),
    '新角色',
  )
  await page.getByRole('button', { name: '撤销 AI 填入', exact: true }).click()
  await page.getByRole('button', { name: '基本', exact: true }).click()
  await expect(name).toHaveValue('原来的名字')
  await expect(page.getByLabel('角色简介', { exact: true })).toHaveValue('原来未保存的简介')

  await page.getByRole('button', { name: 'AI 创建角色', exact: true }).click()
  await expect(description).toHaveValue('经营深夜书店的年轻魔女，冷淡但关心常客。')
  // 错误响应保留当前草稿，可以在同一窗口重试。
  response = JSON.stringify({ name: '只有名字' })
  await dialog.getByRole('button', { name: '生成并填入', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('角色简介缺失')
  await expect(name).toHaveValue('原来的名字')
  response = '{"name":"未闭合'
  await dialog.getByRole('button', { name: '生成并填入', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('不完整或格式错误')
  httpStatus = 401
  await dialog.getByRole('button', { name: '生成并填入', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await expect(name).toHaveValue('原来的名字')

  httpStatus = 200
  response = wrappedReply
  hold = true
  const countBeforeCancel = requests.length
  await dialog.getByRole('button', { name: '生成并填入', exact: true }).click()
  await expect.poll(() => requests.length).toBe(countBeforeCancel + 1)
  await expect(dialog.getByRole('button', { name: '生成中…', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '取消生成', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('已取消生成')
  releaseResponse()
  await expect(name).toHaveValue('原来的名字')
  hold = false

  await dialog.getByRole('button', { name: '生成并填入', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(name).toHaveValue('时雨')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByText('已保存', { exact: true })).toBeVisible()
  const saved = await page.evaluate(async (id) => {
    const { getDb } = await import('/src/db/schema.ts')
    return (await getDb()).get('characters', id)
  }, characterId)
  assert.equal(saved.id, characterId)
  assert.deepEqual(saved.worldBookIds, ['test-world-book'])
  assert.equal(saved.data.system_prompt, '保留我的高级提示词')
  assert.equal(saved.data.creator_notes, '保留我的备注')
  assert.equal(saved.data.extensions.depth_prompt.prompt, '保留我的深度提示词')
  for (const key of Object.keys(generated)) assert.deepEqual(saved.data[key], generated[key])
  await page.reload()
  await expect(name).toHaveValue('时雨')

  // 手机弹窗不横向溢出，操作按钮可见；关闭窗口取消请求，迟到结果不会填入。
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: 'AI 创建角色', exact: true }).click()
  await description.fill('另一位角色')
  await expect(dialog.getByRole('button', { name: '生成并填入', exact: true })).toBeInViewport()
  assert.equal(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await mkdir('test-results', { recursive: true })
  await page.screenshot({ path: 'test-results/ai-character-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: 'test-results/ai-character-desktop.png' })
  hold = true
  response = JSON.stringify({ ...generated, name: '不应填入的角色' })
  const countBeforeClose = requests.length
  await dialog.getByRole('button', { name: '生成并填入', exact: true }).click()
  await expect.poll(() => requests.length).toBe(countBeforeClose + 1)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  releaseResponse()
  await expect(dialog).toHaveCount(0)
  await expect(name).toHaveValue('时雨')

  // 解析器拒绝错误类型和无法进入可视化编辑器的示例。
  assert.deepEqual(
    await page.evaluate(async (data) => {
      const { parseGeneratedCharacter } = await import('/src/services/character/generate.ts')
      const invalid = [
        '[]',
        '',
        '<think>尚未完成',
        JSON.stringify({ ...data, alternate_greetings: [42] }),
        JSON.stringify({ ...data, mes_example: '自由文本不是对话示例' }),
        JSON.stringify({ ...data, first_mes: null }),
      ]
      return invalid.map((raw) => {
        try {
          parseGeneratedCharacter(raw)
          return false
        } catch {
          return true
        }
      })
    }, generated),
    [true, true, true, true, true, true],
  )
  assert.deepEqual(errors, [])
  console.log(
    '✓ AI 创建角色：当前服务与代理、字段填入、开场白与示例、撤销、保存、取消、错误恢复和手机布局检查通过',
  )
} finally {
  await browser?.close()
  await server.close()
}
