/** 独立浏览器上下文与模拟接口，覆盖旧配置迁移、密钥隔离和服务切换。 */
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
  const requests = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('https://*.example.test/**', async (route) => {
    const request = route.request()
    requests.push({
      url: request.url(),
      auth: request.headers().authorization,
      body: request.postDataJSON(),
    })
    if (request.url() === 'https://alpha.example.test/models') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>API portal</title>',
      })
      return
    }
    await route.fulfill({
      json: request.url().endsWith('/models')
        ? { data: [{ id: 'alpha-chat' }, { id: 'alpha-reasoner' }] }
        : { choices: [{ message: { content: '连接成功' } }] },
    })
  })

  await page.goto(`${origin}models`)
  await expect(page.getByText('暂无模型服务', { exact: true })).toBeVisible()
  const cards = page.locator('.service-card')
  const editor = page.getByRole('dialog')

  await page.getByRole('button', { name: '添加服务', exact: true }).click()
  await editor.getByLabel('服务名称', { exact: true }).fill('Alpha 服务')
  await editor.getByLabel('接口地址（baseURL）', { exact: true }).fill('https://alpha.example.test')
  await editor.getByLabel('API Key', { exact: true }).fill('test-alpha-secret')
  await editor.getByLabel('模型', { exact: true }).fill('unlisted-model')
  await editor.getByRole('button', { name: '拉取模型列表', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'alpha-chat', exact: true })).toBeVisible()
  await expect(editor.getByLabel('接口地址（baseURL）', { exact: true })).toHaveValue(
    'https://alpha.example.test/v1',
  )
  await expect(editor.getByRole('status')).toContainText('接口地址已补全 /v1')
  await editor.getByRole('button', { name: 'alpha-chat', exact: true }).click()
  await editor.getByRole('button', { name: '选择模型', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'alpha-reasoner', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'alpha-chat', exact: true }).click()
  await editor.getByRole('button', { name: '测试连接', exact: true }).click()
  await expect(editor.getByRole('status')).toContainText('连接成功')
  assert.equal(requests.at(-1).auth, 'Bearer test-alpha-secret')
  assert.equal(requests.at(-1).url, 'https://alpha.example.test/v1/chat/completions')
  assert.equal(requests.at(-1).body.model, 'alpha-chat')
  await editor.getByText('流式输出', { exact: true }).click()
  await expect(editor.getByLabel('流式输出', { exact: true })).not.toBeChecked()
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(cards).toHaveCount(1)
  await expect(page.getByRole('radio', { name: '使用 Alpha 服务', exact: true })).toBeChecked()

  await page.getByRole('button', { name: '编辑 Alpha 服务', exact: true }).click()
  await expect(editor.getByLabel('接口地址（baseURL）', { exact: true })).toHaveValue(
    'https://alpha.example.test/v1',
  )
  await expect(editor.getByLabel('API Key', { exact: true })).toHaveValue('test-alpha-secret')
  await editor.getByRole('button', { name: '选择模型', exact: true }).click()
  await expect(editor.getByRole('button', { name: 'alpha-reasoner', exact: true })).toBeVisible()
  await editor.getByRole('button', { name: 'alpha-chat', exact: true }).click()
  await editor.getByLabel('API Key', { exact: true }).fill('discard-this-secret')
  await editor.getByLabel('服务名称', { exact: true }).fill('不要保存')
  await editor.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(cards.first()).toContainText('Alpha 服务')

  await page.getByRole('button', { name: '添加服务', exact: true }).click()
  await editor.getByLabel('服务名称', { exact: true }).fill('Beta 服务')
  await editor
    .getByLabel('接口地址（baseURL）', { exact: true })
    .fill('https://beta.example.test/v1')
  await editor.getByLabel('API Key', { exact: true }).fill('test-beta-secret')
  await editor.getByLabel('模型', { exact: true }).fill('beta-chat')
  await editor.getByLabel('温度', { exact: true }).fill('0.3')
  await editor.getByLabel('上下文窗口', { exact: true }).fill('32768')
  await editor.getByText('流式输出', { exact: true }).click()
  await expect(editor.getByLabel('流式输出', { exact: true })).not.toBeChecked()
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(cards).toHaveCount(2)
  await expect(page.getByRole('radio', { name: '使用 Alpha 服务', exact: true })).toBeChecked()
  await page.getByRole('radio', { name: '使用 Beta 服务', exact: true }).check()

  await page.reload()
  await expect(page.getByRole('radio', { name: '使用 Beta 服务', exact: true })).toBeChecked()
  assert.deepEqual(
    await page.evaluate(async () => {
      const { useSettingsStore } = await import('/src/stores/settings.ts')
      const store = useSettingsStore()
      const beta = store.settings.modelServices.find((item) => item.name === 'Beta 服务')
      const alpha = store.settings.modelServices.find((item) => item.name === 'Alpha 服务')
      const { buildBackup } = await import('/src/services/io/backup.ts')
      const backup = await buildBackup()
      return {
        active: store.settings.provider.model,
        temperature: store.settings.provider.temperature,
        contextWindow: store.settings.provider.contextWindow,
        alphaKey: await store.getApiKey(alpha.provider.secretRef),
        betaKey: await store.getApiKey(beta.provider.secretRef),
        uniqueRefs: alpha.provider.secretRef !== beta.provider.secretRef,
        exportsKey:
          JSON.stringify(backup).includes('test-alpha-secret') ||
          JSON.stringify(backup).includes('test-beta-secret'),
      }
    }),
    {
      active: 'beta-chat',
      temperature: 0.3,
      contextWindow: 32768,
      alphaKey: 'test-alpha-secret',
      betaKey: 'test-beta-secret',
      uniqueRefs: true,
      exportsKey: false,
    },
  )

  // 编辑未启用服务不会替换当前服务；真正聊天应使用所选服务的地址、模型和密钥。
  await page.getByRole('button', { name: '编辑 Alpha 服务', exact: true }).click()
  await editor.getByLabel('温度', { exact: true }).fill('0.8')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(page.getByRole('radio', { name: '使用 Beta 服务', exact: true })).toBeChecked()
  await page.evaluate(async () => {
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const { useGenerationStore } = await import('/src/stores/generation.ts')
    const chats = useChatsStore()
    const chat = await chats.createSolo(undefined, '服务切换验证')
    await chats.open(chat.id)
    await useGenerationStore().send()
  })
  assert.equal(requests.at(-1).url, 'https://beta.example.test/v1/chat/completions')
  assert.equal(requests.at(-1).auth, 'Bearer test-beta-secret')
  assert.equal(requests.at(-1).body.model, 'beta-chat')
  assert.equal(requests.at(-1).body.temperature, 0.3)

  await page.setViewportSize({ width: 375, height: 812 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.getByRole('button', { name: '编辑 Beta 服务', exact: true }).click()
  await expect(editor.getByLabel('API Key', { exact: true })).toHaveValue('test-beta-secret')
  assert.equal(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await editor.getByLabel('API Key', { exact: true }).fill('')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)
  assert.equal(
    await page.evaluate(async () => {
      const { useSettingsStore } = await import('/src/stores/settings.ts')
      return useSettingsStore().getApiKey()
    }),
    '',
  )

  await page.getByRole('button', { name: '删除 Beta 服务', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(cards).toHaveCount(2)
  await page.getByRole('button', { name: '删除 Beta 服务', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除服务', exact: true }).click()
  await expect(cards).toHaveCount(1)
  await expect(page.getByRole('radio', { name: '使用 Alpha 服务', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '删除 Alpha 服务', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除服务', exact: true }).click()
  await expect(page.getByText('暂无模型服务', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText('暂无模型服务', { exact: true })).toBeVisible()
  assert.deepEqual(
    await page.evaluate(async () => {
      const { useSettingsStore } = await import('/src/stores/settings.ts')
      const { getDb } = await import('/src/db/schema.ts')
      const db = await getDb()
      return { configured: useSettingsStore().isConfigured, secrets: await db.count('secrets') }
    }),
    { configured: false, secrets: 0 },
  )

  // 以旧版本记录模拟升级：服务、请求参数和原密钥引用均须保留。
  await page.evaluate(async () => {
    const { defaultSettings } = await import('/src/types/settings.ts')
    const { getDb } = await import('/src/db/schema.ts')
    const db = await getDb()
    const legacy = defaultSettings()
    delete legacy.modelServices
    delete legacy.activeModelServiceId
    legacy.provider = {
      ...legacy.provider,
      baseUrl: 'https://legacy.example.test/v1',
      model: 'legacy-chat',
      temperature: 0.7,
      extraHeaders: { 'X-Test': 'kept' },
    }
    await db.put('settings', legacy)
    await db.put('secrets', { ref: 'default', value: 'test-legacy-secret' })
  })
  await page.reload()
  await expect(cards).toHaveCount(1)
  await expect(cards.first()).toContainText('legacy-chat')
  await page.getByRole('button', { name: '编辑 默认服务', exact: true }).click()
  await expect(editor.getByLabel('API Key', { exact: true })).toHaveValue('test-legacy-secret')
  await expect(editor.getByLabel('温度', { exact: true })).toHaveValue('0.7')
  await editor.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await page.goto(`${origin}settings`)
  await expect(page.getByRole('heading', { name: '提示词与插入深度', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '模型服务', exact: true })).toHaveCount(0)

  // 导入不完整备份时逐项修复，而不是让某张卡片导致整页白屏。
  assert.deepEqual(
    await page.evaluate(async () => {
      const { getDb } = await import('/src/db/schema.ts')
      const { load } = await import('/src/db/repositories/settings.ts')
      const db = await getDb()
      const raw = await db.get('settings', 'app')
      raw.modelServices = [
        null,
        { id: 'damaged', name: null, provider: { stop: null, extraHeaders: null } },
        { id: 'damaged' },
      ]
      raw.activeModelServiceId = 'missing'
      // chat 内混入类型错误的值（如手改备份）时按默认形状修复。
      raw.chat = { sendOnEnter: false, streamFlushMs: 'bogus', messageFontSize: null }
      await db.put('settings', raw)
      const normalized = await load()
      return {
        count: normalized.modelServices.length,
        active: normalized.activeModelServiceId,
        stop: normalized.provider.stop,
        headers: normalized.provider.extraHeaders,
        secretRef: normalized.provider.secretRef,
        chat: normalized.chat,
      }
    }),
    {
      count: 1,
      active: 'damaged',
      stop: [],
      headers: {},
      secretRef: 'model-service:damaged',
      chat: { streamFlushMs: 100, sendOnEnter: false, showTokens: false, messageFontSize: 16 },
    },
  )
  // 覆盖裸域名探测、已有自定义路径以及服务失败，确保只修正证据支持的地址。
  const discoveryRequests = []
  let replies = []
  await page.route('https://discovery.example.test/**', async (route) => {
    discoveryRequests.push(route.request().url())
    await route.fulfill(
      replies.shift() ?? { status: 500, json: { error: { message: 'Unexpected retry' } } },
    )
  })
  for (const scenario of [
    {
      path: '',
      replies: [{ status: 404, json: {} }, { json: { data: [{ id: 'found' }] } }],
      paths: ['/models', '/v1/models'],
      expected: { models: [{ id: 'found' }], baseUrl: 'https://discovery.example.test/v1' },
    },
    {
      path: '',
      replies: [{ json: { data: [null, { id: 'direct' }, { id: 'direct' }, { id: '' }, {}] } }],
      paths: ['/models'],
      expected: { models: [{ id: 'direct' }], baseUrl: 'https://discovery.example.test' },
    },
    {
      path: '',
      replies: [{ status: 401, json: { error: { message: 'Invalid key' } } }],
      paths: ['/models'],
      kind: 'auth',
    },
    {
      path: '/v1',
      replies: [{ contentType: 'text/html', body: '<!doctype html><title>Wrong route</title>' }],
      paths: ['/v1/models'],
      kind: 'parse',
      message: '返回了网页',
    },
    {
      path: '/custom/api',
      replies: [{ json: { data: [] } }],
      paths: ['/custom/api/models'],
      expected: { models: [], baseUrl: 'https://discovery.example.test/custom/api' },
    },
    {
      path: '/v1',
      replies: [{ json: { data: {} } }],
      paths: ['/v1/models'],
      kind: 'parse',
      message: 'data 数组',
    },
  ]) {
    replies = [...scenario.replies]
    discoveryRequests.length = 0
    const result = await page.evaluate(async (path) => {
      const { listModels } = await import('/src/services/provider/openaiCompatible.ts')
      try {
        return await listModels({
          baseUrl: `https://discovery.example.test${path}`,
          apiKey: 'test-discovery',
        })
      } catch (error) {
        return { kind: error.kind, message: error.message }
      }
    }, scenario.path)
    assert.deepEqual(
      discoveryRequests,
      scenario.paths.map((path) => `https://discovery.example.test${path}`),
    )
    if (scenario.expected) assert.deepEqual(result, scenario.expected)
    else {
      assert.equal(result.kind, scenario.kind)
      if (scenario.message) assert.ok(result.message.includes(scenario.message))
    }
  }
  console.log('✓ 模型列表：自动补全并保存 /v1、保留自定义路径、鉴权失败与无效响应分类')
  assert.deepEqual(errors, [])
  console.log(
    '✓ 模型服务：增删改切换、刷新持久化、密钥隔离、聊天请求、旧配置迁移、备份修复与手机布局检查通过',
  )
} finally {
  await browser?.close()
  await server.close()
}
