/** 使用模拟文生图接口验证配置、封面、配图与本地数据完整性，不调用付费服务。 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { pickOption } from './lib/cbx-select.mjs'

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
  let mode = 'base64'
  let releaseResponse
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${origin}characters`)
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 384
    canvas.height = 576
    const ctx = canvas.getContext('2d')
    const gradient = ctx.createLinearGradient(0, 0, 384, 576)
    gradient.addColorStop(0, '#172b4d')
    gradient.addColorStop(1, '#7186a3')
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, 384, 576)
    ctx.fillStyle = '#fce4a4'
    ctx.beginPath()
    ctx.arc(290, 100, 36, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#13263d'
    ctx.fillRect(40, 280, 304, 296)
    ctx.fillStyle = '#e9bb72'
    for (let i = 0; i < 3; i++) ctx.fillRect(72 + i * 86, 325, 46, 100)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.route('https://*.example.test/**', async (route) => {
    const request = route.request()
    const headers = request.headers()
    const images = []
    let body
    if (headers['content-type']?.startsWith('multipart/form-data')) {
      const form = await new Request(request.url(), {
        method: 'POST',
        headers,
        body: request.postDataBuffer(),
      }).formData()
      body = {}
      for (const [key, value] of form) {
        if (typeof value === 'string') body[key] = value
        else
          images.push({
            field: key,
            name: value.name,
            type: value.type,
            base64: Buffer.from(await value.arrayBuffer()).toString('base64'),
          })
      }
    } else body = request.postDataJSON()
    requests.push({ url: request.url(), headers, body, images })
    if (request.url() === 'https://image-proxy.example.test/models') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>API portal</title>',
      })
      return
    }
    if (request.url().endsWith('/models')) {
      await route.fulfill({ json: { data: [{ id: 'portrait-image' }, { id: 'scene-image' }] } })
      return
    }
    if (request.url().includes('cdn.example.test')) {
      await route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') })
      return
    }
    const responseMode = mode
    // fallback 模式：multipart 参考图请求被 415 拒绝（xAI 网关行为），JSON image_urls 成功。
    if (
      responseMode === 'fallback' &&
      request.url().endsWith('/images/edits') &&
      headers['content-type']?.startsWith('multipart/form-data')
    ) {
      await route.fulfill({
        status: 415,
        json: { error: { message: 'xAI upstream returned status 415' } },
      })
      return
    }
    if (responseMode === 'hold')
      await new Promise((resolve) => {
        releaseResponse = resolve
      })
    try {
      await route.fulfill(
        responseMode === 'unsupported'
          ? { status: 404, json: { error: { message: 'Image edits unavailable' } } }
          : responseMode === 'error'
            ? { status: 401, json: { error: { message: 'invalid key' } } }
            : responseMode === 'empty'
              ? { json: { data: [] } }
              : responseMode === 'invalid'
                ? { json: { data: [{ b64_json: btoa('<html>not an image</html>') }] } }
                : {
                    json: {
                      data: [
                        responseMode === 'url'
                          ? { url: 'https://cdn.example.test/generated.png' }
                          : { b64_json: png },
                      ],
                    },
                  },
      )
    } catch (error) {
      if (responseMode !== 'hold') throw error
    }
  })

  await page.getByRole('button', { name: '新建角色', exact: true }).click()
  await page.waitForURL(/\/characters\/[^/]+$/)
  const characterId = page.url().split('/').at(-1)
  const characterUrl = page.url()
  await page.getByLabel('角色名', { exact: true }).fill('时雨')
  await page
    .getByLabel('角色简介', { exact: true })
    .fill('经营深夜书店的年轻魔女，银色长发，穿着蓝色长裙。')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '生成封面', exact: true }).click()
  let dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('link', { name: '模型管理添加文生图配置' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '生成图片', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()

  await page.goto(`${origin}models`)
  async function addConfig(name, model, key, size, format) {
    await page.getByRole('button', { name: '添加文生图配置', exact: true }).click()
    const editor = page.getByRole('dialog')
    await editor.getByLabel('配置名称', { exact: true }).fill(name)
    await editor
      .getByLabel('接口地址（baseURL）', { exact: true })
      .fill('https://images.example.test')
    await editor.getByLabel('API Key', { exact: true }).fill(key)
    await editor
      .getByLabel('代理地址（可选）', { exact: true })
      .fill('https://image-proxy.example.test')
    await editor.getByLabel('文生图模型', { exact: true }).fill(model)
    await editor.getByRole('button', { name: '拉取模型列表', exact: true }).click()
    await expect(editor.getByRole('status')).toContainText('已拉取 2 个模型')
    await expect(editor.getByLabel('接口地址（baseURL）', { exact: true })).toHaveValue(
      'https://images.example.test/v1',
    )
    await expect(editor.getByRole('status')).toContainText('接口地址已补全 /v1')
    await editor.getByLabel('默认尺寸', { exact: true }).fill(size)
    await pickOption(editor, '返回格式', { value: format })
    await editor.getByRole('button', { name: '保存', exact: true }).click()
    await expect(editor).toHaveCount(0)
  }
  await addConfig('封面插画', 'portrait-image', 'test-portrait-key', '1024x1536', 'b64_json')
  await addConfig('场景插画', 'scene-image', 'test-scene-key', '1536x1024', 'url')
  await expect(page.locator('.image-service-card')).toHaveCount(2)
  await page.getByRole('radio', { name: '默认使用 场景插画', exact: true }).check()
  await page.reload()
  await expect(page.getByRole('radio', { name: '默认使用 场景插画', exact: true })).toBeChecked()
  await page.getByRole('button', { name: '编辑 封面插画', exact: true }).click()
  await expect(page.getByRole('dialog').getByLabel('API Key', { exact: true })).toHaveValue(
    'test-portrait-key',
  )
  await page.getByRole('dialog').getByLabel('配置名称', { exact: true }).fill('取消的改名')
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('.image-service-card').first()).toContainText('封面插画')
  console.log('✓ 多配置创建、切换、密钥与取消编辑')

  await page.goto(characterUrl)
  await page.getByRole('button', { name: '生成封面', exact: true }).click()
  dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('画面描述', { exact: true })).toHaveValue(/银色长发/)
  await pickOption(dialog, '文生图配置', { label: '封面插画 · portrait-image' })
  for (const [failure, text] of [
    ['error', '鉴权失败'],
    ['empty', '没有返回图片'],
    ['invalid', '不是支持的图片'],
  ]) {
    mode = failure
    await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText(text)
    await expect(dialog.getByRole('img')).toHaveCount(0)
  }
  mode = 'hold'
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect.poll(() => !!releaseResponse).toBe(true)
  await dialog.getByRole('button', { name: '取消生成', exact: true }).click()
  releaseResponse()
  await expect(dialog.getByRole('status')).toContainText('已取消生成')
  await expect(dialog.getByRole('img')).toHaveCount(0)
  mode = 'base64'
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '生成图片预览' })).toBeVisible()
  const coverRequest = requests.at(-1)
  assert.equal(coverRequest.url, 'https://image-proxy.example.test/v1/images/generations')
  assert.equal(coverRequest.headers.authorization, 'Bearer test-portrait-key')
  assert.equal(coverRequest.body.model, 'portrait-image')
  assert.equal(coverRequest.body.size, '1024x1536')
  assert.equal(coverRequest.body.response_format, 'b64_json')
  assert.equal(coverRequest.images.length, 0)
  await mkdir('output/image-generation', { recursive: true })
  await page.screenshot({ path: 'output/image-generation/cover-preview.png' })
  await dialog.getByRole('button', { name: '设为角色封面', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.frame img')).toBeVisible()
  assert.equal(await page.locator('.frame img').evaluate((img) => img.naturalWidth), 384)
  console.log('✓ 角色封面、错误响应、取消生成与刷新恢复')

  const chatId = await page.evaluate(async (id) => {
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const store = useChatsStore()
    const meta = await store.createSolo(id, '雨夜书店')
    await store.open(meta.id)
    await store.appendUser('旧场景：午后，我们在海边散步。')
    await store.appendUser('雨夜，我推开书店的门，她递来一杯热茶。')
    return meta.id
  }, characterId)
  await page.goto(`${origin}chat/${chatId}`)
  await expect(page.locator('.stream .row')).toHaveCount(2)
  const originalCount = await page.locator('.stream .row').count()

  // 消息字号滑块：设置页调整后气泡字号即时变化，整页刷新后保持（touch 落盘防抖 400ms，
  // 应用内路由是 SPA 导航不受影响；这里的 page.goto 是整页刷新，需先等防抖落盘）。
  {
    const bubble = () => page.locator('.stream .row .cbx-bubble').first()
    assert.equal(await bubble().evaluate((el) => getComputedStyle(el).fontSize), '16px')
    await page.goto(`${origin}settings`)
    await page.getByLabel('消息字体大小', { exact: true }).evaluate((el) => {
      el.value = '20'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await expect(page.getByText('消息字体大小 · 20px')).toBeVisible()
    await page.waitForTimeout(600) // 等 touch() 的防抖落盘完成
    await page.goto(`${origin}chat/${chatId}`)
    await expect(page.locator('.stream .row')).toHaveCount(2)
    assert.equal(await bubble().evaluate((el) => getComputedStyle(el).fontSize), '20px')
    await page.reload()
    await expect(page.locator('.stream .row')).toHaveCount(2)
    assert.equal(await bubble().evaluate((el) => getComputedStyle(el).fontSize), '20px')
    // 还原默认，不影响后续场景。
    await page.goto(`${origin}settings`)
    await page.getByLabel('消息字体大小', { exact: true }).evaluate((el) => {
      el.value = '16'
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(600)
    await page.goto(`${origin}chat/${chatId}`)
    await expect(page.locator('.stream .row')).toHaveCount(2)
    assert.equal(await bubble().evaluate((el) => getComputedStyle(el).fontSize), '16px')
  }
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('画面描述', { exact: true })).toHaveValue(/热茶/)
  // 图生图会把角色外貌写进提示词（与参考图双重锚定人物，防服饰漂移）——应包含外貌设定。
  await expect(dialog.getByLabel('画面描述', { exact: true })).toHaveValue(/银色长发/)
  // 对话配图只取「当前这一句」，不应带入更早的历史消息（旧场景 / 海边）。
  await expect(dialog.getByLabel('画面描述', { exact: true })).not.toHaveValue(/海边|旧场景/)
  await expect(dialog.getByRole('img', { name: '时雨的参考图' })).toBeVisible()
  const beforeUnsupported = requests.length
  mode = 'unsupported'
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('支持参考图生成')
  // multipart 被 404 拒绝后，自动改用 JSON image_urls 重试一次，两次都失败才报错。
  assert.equal(requests.length, beforeUnsupported + 2)
  assert.equal(requests.at(-2).url, 'https://image-proxy.example.test/v1/images/edits')
  assert.equal(requests.at(-2).images.length, 1)
  assert.equal(requests.at(-1).url, 'https://image-proxy.example.test/v1/images/edits')
  assert.match(requests.at(-1).headers['content-type'], /^application\/json/)
  assert.deepEqual(requests.at(-1).body.image_urls, [`data:image/png;base64,${png}`])
  await expect(dialog.getByRole('img', { name: '生成图片预览' })).toHaveCount(0)

  // multipart 被 415 拒绝时自动降级为 JSON image_urls，并成功出图。
  const beforeFallback = requests.length
  mode = 'fallback'
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '生成图片预览' })).toBeVisible()
  assert.equal(requests.length, beforeFallback + 2) // multipart 被拒 + JSON 降级成功
  assert.match(requests.at(-2).headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.equal(requests.at(-2).images.length, 1)
  assert.match(requests.at(-1).headers['content-type'], /^application\/json/)
  assert.equal(requests.at(-1).body.model, 'scene-image')
  assert.match(requests.at(-1).body.prompt, /参考图 1 是「时雨」的形象/)
  assert.deepEqual(requests.at(-1).body.image_urls, [`data:image/png;base64,${png}`])
  // 用户显式配置的返回格式优先于降级默认值。
  assert.equal(requests.at(-1).body.response_format, 'url')
  assert.equal(requests.at(-1).headers.authorization, 'Bearer test-scene-key')

  // 成功后回写格式缓存；刷新页面（防抖落盘 → IndexedDB → 重新加载）后缓存仍在，
  // 重新生成命中缓存，只发一次 JSON 请求，不再白跑 multipart。
  assert.equal(
    await page.evaluate(async () => {
      const { useSettingsStore } = await import('/src/stores/settings.ts')
      const settings = useSettingsStore()
      return settings.settings.imageModelServices.find((s) => s.model === 'scene-image')
        .referenceMode
    }),
    'json',
  )
  await page.reload()
  await expect(page.locator('.stream .row')).toHaveCount(2)
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  dialog = page.getByRole('dialog')
  const beforeCached = requests.length
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect.poll(() => requests.length - beforeCached).toBe(1)
  assert.match(requests.at(-1).headers['content-type'], /^application\/json/)
  assert.equal(requests.at(-1).body.model, 'scene-image')
  assert.deepEqual(requests.at(-1).body.image_urls, [`data:image/png;base64,${png}`])

  // 返回格式未配置时，JSON 降级请求默认 response_format=b64_json，避免境外 CDN 直连失败。
  const beforeDefault = requests.length
  await page.evaluate(async (b64) => {
    const { generateImage } = await import('/src/services/image/generate.ts')
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    try {
      await generateImage({
        service: {
          id: 'direct',
          name: '直连降级',
          baseUrl: 'https://images.example.test',
          model: 'scene-image',
          secretRef: 'image-service:direct',
          proxyPrefix: 'https://image-proxy.example.test',
          size: '',
          quality: '',
          responseFormat: '',
        },
        apiKey: 'direct-key',
        prompt: '直连降级测试',
        references: [{ name: '时雨', blob }],
        signal: new AbortController().signal,
      })
    } catch {
      // 只关心发出的请求形状，失败与否不影响断言。
    }
  }, png)
  assert.equal(requests.length, beforeDefault + 2)
  assert.match(requests.at(-1).headers['content-type'], /^application\/json/)
  assert.equal(requests.at(-1).body.response_format, 'b64_json')
  assert.equal(requests.at(-1).body.image_urls.length, 1)
  assert.equal(requests.at(-1).headers.authorization, 'Bearer direct-key')
  mode = 'url'
  // 重置格式缓存，验证未缓存时的自动探测路径（multipart 直连成功）。
  await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/stores/settings.ts')
    const service = useSettingsStore().settings.imageModelServices.find(
      (s) => s.model === 'scene-image',
    )
    service.referenceMode = ''
  })
  // 上一场景已成功出图，按钮文案变为「重新生成图片」，旧预览在重新生成期间保持可见，
  // 因此用请求计数等待本次生成真正完成。
  const beforeUrl = requests.length
  await dialog.getByRole('button', { name: '重新生成图片', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '生成图片预览' })).toBeVisible()
  await expect.poll(() => requests.length - beforeUrl).toBe(2)
  const urlRequest = requests[beforeUrl]
  const cdnRequest = requests[beforeUrl + 1]
  assert.equal(urlRequest.url, 'https://image-proxy.example.test/v1/images/edits')
  assert.equal(urlRequest.body.model, 'scene-image')
  assert.match(urlRequest.body.prompt, /参考图 1 是「时雨」的形象/)
  assert.match(urlRequest.body.prompt, /热茶/)
  assert.match(urlRequest.body.prompt, /银色长发/) // 外貌锚点写进提示词
  assert.doesNotMatch(urlRequest.body.prompt, /海边|旧场景/) // 只取当前这一句，不带历史
  assert.match(urlRequest.headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.deepEqual(urlRequest.images, [
    { field: 'image', name: 'reference-1.png', type: 'image/png', base64: png },
  ])
  assert.equal(urlRequest.headers.authorization, 'Bearer test-scene-key')
  assert.equal(cdnRequest.headers.authorization, undefined)
  // multipart 直连成功同样回写缓存，供后续生成直接使用。
  assert.equal(
    await page.evaluate(async () => {
      const { useSettingsStore } = await import('/src/stores/settings.ts')
      return useSettingsStore().settings.imageModelServices.find((s) => s.model === 'scene-image')
        .referenceMode
    }),
    'multipart',
  )
  await dialog.getByRole('button', { name: '保存到对话', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('img', { name: '根据对话生成的配图' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('img', { name: '根据对话生成的配图' })).toBeVisible()
  assert.equal(await page.locator('.stream .row').count(), originalCount)

  // 在配置里固定参考图格式后，不再发送 multipart 探测请求。
  await page.goto(`${origin}models`)
  await page.getByRole('button', { name: '编辑 场景插画', exact: true }).click()
  const editorDialog = page.getByRole('dialog')
  await pickOption(editorDialog, '参考图格式', { value: 'json' })
  await editorDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(editorDialog).toHaveCount(0)
  await page.goto(`${origin}chat/${chatId}`)
  mode = 'fallback' // 若仍发出 multipart 会收到 415 并产生第二个请求，使下面的断言失败
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  dialog = page.getByRole('dialog')
  const beforePinned = requests.length
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect.poll(() => requests.length - beforePinned).toBe(1)
  assert.match(requests.at(-1).headers['content-type'], /^application\/json/)
  assert.deepEqual(requests.at(-1).body.image_urls, [`data:image/png;base64,${png}`])
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()

  // 点某条消息时，画面内容只取该条消息（不带前文和后续消息）；角色外貌会作为锚点写进提示词。
  await page.getByRole('button', { name: '根据此处对话生成配图', exact: true }).first().click()
  dialog = page.getByRole('dialog')
  await expect(dialog.getByLabel('画面描述', { exact: true })).toHaveValue(/海边/)
  await expect(dialog.getByLabel('画面描述', { exact: true })).toHaveValue(/银色长发/) // 外貌锚点
  await expect(dialog.getByLabel('画面描述', { exact: true })).not.toHaveValue(/热茶/) // 不带其它消息
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()

  // 手机上的消息操作、弹窗和图片均保持在视口内。
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('button', { name: '根据此处对话生成配图', exact: true }).last().click()
  dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  assert.ok(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth))
  await page.screenshot({ path: 'output/image-generation/mobile-dialog.png' })
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()
  await page.screenshot({ path: 'output/image-generation/mobile-chat.png' })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))

  // 分支共用图片仍可达；整库/仅聊天备份包含配图，且没有服务密钥。
  const data = await page.evaluate(
    async ({ chatId, characterId }) => {
      const { useChatsStore } = await import('/src/stores/chats.ts')
      const { useSettingsStore } = await import('/src/stores/settings.ts')
      const { buildBackup, applyBackup } = await import('/src/services/io/backup.ts')
      const { blobsRepo, messagesRepo } = await import('/src/db/repositories/index.ts')
      const { getDb } = await import('/src/db/schema.ts')
      const store = useChatsStore()
      const db = await getDb()
      const row = store.messages.at(-1)
      const imageId = row.images[0].blobId
      const branch = await store.branchFrom(row.id)
      await store.removeChat(chatId)
      await blobsRepo.gc()
      const backup = await buildBackup()
      const chatOnly = await buildBackup({
        characters: false,
        groups: false,
        gameworlds: false,
        worldbooks: false,
        settings: false,
      })
      const noChat = await buildBackup({ chats: false })
      const before = await db.count('blobs')
      let deletedError = ''
      try {
        await messagesRepo.attachImage(chatId, row.id, {
          blob: new Blob(['test']),
          prompt: 'x',
          model: 'x',
          serviceName: 'x',
        })
      } catch (error) {
        deletedError = error.message
      }
      const after = await db.count('blobs')
      const imageSurvived = !!(await blobsRepo.get(imageId))
      // 接收方只勾选聊天时，图片仍需恢复。
      await db.delete('blobs', imageId)
      const restored = await applyBackup(chatOnly, {
        chats: true,
        characters: false,
        groups: false,
        gameworlds: false,
        worldbooks: false,
        settings: false,
      })
      const restoredImage = !!(await blobsRepo.get(imageId))
      const branchMessages = await messagesRepo.all(branch.id)
      const settings = useSettingsStore()
      const active = settings.settings.imageModelServices.find(
        (s) => s.id === settings.settings.activeImageModelServiceId,
      )
      const backupString = JSON.stringify(backup)
      const activeKey = await settings.getApiKey(active.secretRef)
      await settings.removeImageModelService(active.id)
      return {
        branchId: branch.id,
        imageSurvived,
        restoredImage,
        restoredBlobs: restored.blobs,
        characterCover: !!(await db.get('characters', characterId)).avatarBlobId,
        backupHasImage: backup.blobs.some((b) => b.id === imageId),
        chatOnlyHasImage: chatOnly.blobs.some((b) => b.id === imageId),
        noChatHasImage: noChat.blobs.some((b) => b.id === imageId),
        secretsLeaked:
          backupString.includes('test-portrait-key') || backupString.includes('test-scene-key'),
        branchHasImage: branchMessages.some((m) => m.images?.some((i) => i.blobId === imageId)),
        deletedError,
        before,
        after,
        activeKey,
        deletedKey: await settings.getApiKey(active.secretRef),
        nextActive: settings.activeImageService?.name,
        chatModelCount: settings.settings.modelServices.length,
      }
    },
    { chatId, characterId },
  )
  assert.equal(data.imageSurvived, true)
  assert.equal(data.restoredImage, true)
  assert.equal(data.restoredBlobs, 1)
  assert.equal(data.characterCover, true)
  assert.equal(data.backupHasImage, true)
  assert.equal(data.chatOnlyHasImage, true)
  assert.equal(data.noChatHasImage, false)
  assert.equal(data.secretsLeaked, false)
  assert.equal(data.branchHasImage, true)
  assert.match(data.deletedError, /原消息已删除/)
  assert.equal(data.before, data.after)
  assert.equal(data.activeKey, 'test-scene-key')
  assert.equal(data.deletedKey, '')
  assert.equal(data.nextActive, '封面插画')
  assert.equal(data.chatModelCount, 0)

  // 切换路由取消请求，不将迟到的结果写进其他对话。
  await page.goto(`${origin}chat/${data.branchId}`)
  mode = 'hold'
  releaseResponse = undefined
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '生成图片', exact: true }).click()
  await expect.poll(() => !!releaseResponse).toBe(true)
  await page.evaluate(async () => {
    const { default: router } = await import('/src/router/index.ts')
    await router.push('/models')
  })
  releaseResponse()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.image-service-card')).toHaveCount(1)

  // 旧设置与畸形配置补齐，重新加载不破坏聊天服务。
  const migration = await page.evaluate(async () => {
    const { getDb } = await import('/src/db/schema.ts')
    const { load } = await import('/src/db/repositories/settings.ts')
    const db = await getDb()
    const original = await db.get('settings', 'app')
    const legacy = { ...original }
    delete legacy.imageModelServices
    delete legacy.activeImageModelServiceId
    await db.put('settings', legacy)
    const loaded = await load()
    await db.put('settings', {
      ...original,
      imageModelServices: [
        null,
        {},
        { id: 'old', name: null, responseFormat: 'bogus', size: null },
        { id: 'old' },
      ],
      activeImageModelServiceId: 'missing',
    })
    const repaired = await load()
    await db.put('settings', original)
    return {
      legacyCount: loaded.imageModelServices.length,
      legacyActive: loaded.activeImageModelServiceId,
      count: repaired.imageModelServices.length,
      active: repaired.activeImageModelServiceId,
      format: repaired.imageModelServices[0].responseFormat,
      size: repaired.imageModelServices[0].size,
    }
  })
  assert.deepEqual(migration, {
    legacyCount: 0,
    legacyActive: '',
    count: 1,
    active: 'old',
    format: '',
    size: '',
  })

  // 演绎配图只带这一幕出场的人：发言者（参考图 1）+ 这句话点名的成员；未出场的成员不带。
  // 参考图按这个顺序上传，编号与人物一一对应。
  const groupData = await page.evaluate(async (id) => {
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const { useGroupsStore } = await import('/src/stores/groups.ts')
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const { blobsRepo } = await import('/src/db/repositories/index.ts')
    const chars = useCharactersStore()
    const groups = useGroupsStore()
    const chats = useChatsStore()
    const second = await chars.create('望月')
    second.data.description = '沉默寡言的青年剑客，黑色短发，赤红色瞳孔'
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 48
    canvas.getContext('2d').fillRect(0, 0, 32, 48)
    const url = canvas.toDataURL('image/png')
    const blob = await (await fetch(url)).blob()
    second.avatarBlobId = await blobsRepo.put(blob)
    await chars.save(second)
    // 路人有封面但这句话没提到他 —— 不应出现在参考图里
    const third = await chars.create('路人')
    third.avatarBlobId = await blobsRepo.put(blob)
    await chars.save(third)
    const group = await groups.create('双人书店')
    group.members = [second.id, id, third.id]
    await groups.save(group)
    const meta = await chats.createGroup(group.id, group.name)
    await chats.open(meta.id)
    const row = await chats.appendAi('时雨', id)
    chats.patchLocal(row.id, { mes: '时雨向望月递过一本旧书。' })
    await chats.persist(row.id)
    return {
      chatId: meta.id,
      secondId: second.id,
      secondBlobId: second.avatarBlobId,
      secondBase64: url.split(',')[1],
    }
  }, characterId)
  await page.goto(`${origin}chat/${groupData.chatId}`)
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('img', { name: '望月的参考图' })).toBeVisible()
  await expect(dialog.getByRole('img', { name: '时雨的参考图' })).toBeVisible()
  await expect(dialog.getByRole('img', { name: '路人的参考图' })).toHaveCount(0)
  mode = 'base64'
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '生成图片预览' })).toBeVisible()
  // 发言者在前（时雨=参考图1），被点名的望月=参考图2；外貌逐一锚定到对应编号，未出场的路人不出现。
  assert.match(
    requests.at(-1).body.prompt,
    /参考图 1 是「时雨」的形象[\s\S]*银色长发[\s\S]*参考图 2 是「望月」的形象[\s\S]*黑色短发/,
  )
  assert.doesNotMatch(requests.at(-1).body.prompt, /路人/)
  assert.match(requests.at(-1).body.prompt, /递过一本旧书/) // 画面内容取自当前这一句
  assert.deepEqual(requests.at(-1).images, [
    { field: 'image[]', name: 'reference-1.png', type: 'image/png', base64: png },
    {
      field: 'image[]',
      name: 'reference-2.png',
      type: 'image/png',
      base64: groupData.secondBase64,
    },
  ])
  await page.screenshot({ path: 'output/image-generation/reference-preview.png' })
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()

  // 封面记录存在但图片文件缺失时，不允许悄悄降级为纯文生图。
  await page.evaluate(async (blobId) => {
    const { blobsRepo } = await import('/src/db/repositories/index.ts')
    await blobsRepo.remove(blobId)
  }, groupData.secondBlobId)
  const beforeMissing = requests.length
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '生成图片', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('无法读取「望月」的角色封面')
  assert.equal(requests.length, beforeMissing)
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()
  await page.evaluate(async (id) => {
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const chars = useCharactersStore()
    const char = chars.byId(id)
    delete char.avatarBlobId
    await chars.save(char)
  }, groupData.secondId)
  // 被点名的配角没有封面：直接不带他，不阻塞发言者的配图
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  await expect(dialog.getByRole('img', { name: '时雨的参考图' })).toBeVisible()
  await expect(dialog.getByRole('img', { name: '望月的参考图' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: '生成图片', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()
  // 发言者自己没有封面：必须拦下，不许悄悄降级成纯文生图
  await page.evaluate(async (id) => {
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const chars = useCharactersStore()
    const char = chars.byId(id)
    delete char.avatarBlobId
    await chars.save(char)
  }, characterId)
  await page.getByRole('button', { name: '生成对话配图', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('请先为「时雨」设置角色封面')
  await expect(dialog.getByRole('button', { name: '生成图片', exact: true })).toBeDisabled()
  assert.equal(requests.length, beforeMissing)
  assert.deepEqual(errors, [])
  console.log(
    '✓ 图片生成：当前消息与角色参考图、多角色文件顺序、缺图/不支持时不降级、封面保存、配图持久化、取消、手机布局、备份与旧配置兼容',
  )
} finally {
  await browser?.close()
  await server.close()
}
