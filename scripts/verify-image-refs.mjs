/**
 * 生图参考图选择 / 提示词 / 群聊封面 / 全站预览 —— 模拟接口，不调用付费服务。
 *
 * 跑法： npm run verify:image-refs   （截图输出到 test-results/image-refs/）
 *
 * 覆盖：
 *  - 参考图池 = 角色封面 + 群聊封面 + 本会话历史配图；默认只勾选出场角色；
 *  - 选中顺序 = multipart image[] 顺序；按后端限量（ComfyUI 3 张，切过去自动截断）；
 *  - 模板提示词带目标消息那一刻的角色状态（地点、衣着），未手改时随选择重建，手改后不覆盖；
 *  - 群聊封面：默认用全体成员封面作参考、横版 size、落库后群聊列表显示横幅；
 *  - 统一预览：聊天配图左右切换与计数、头像点开、列表「放大」按钮不跳转、返回键关闭。
 */
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  const errors = []
  const requests = []
  /** 下一次生图请求挂起，直到调用 release()；或直接失败 */
  let hold = null
  let failNext = false
  page.on('pageerror', (e) => errors.push(e.message))
  await mkdir('test-results/image-refs', { recursive: true })
  const hideDevtools = () =>
    page.addStyleTag({ content: '#__vue-devtools-container__{display:none!important}' })

  await page.goto(`${origin}chat`)
  await page.waitForTimeout(1500) // 首次访问可能触发依赖预构建整页重载
  await page.goto(`${origin}chat`)

  // 生成结果：一张纯色 PNG
  const resultPng = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 96
    c.height = 64
    const g = c.getContext('2d')
    g.fillStyle = '#3a7'
    g.fillRect(0, 0, 96, 64)
    return c.toDataURL('image/png').split(',')[1]
  })
  // 挂在 context 上：后面手机场景是同一 context 的另一个页面
  await ctx.route('https://img.example.test/**', async (route) => {
    const request = route.request()
    const headers = request.headers()
    const images = []
    let body = {}
    if (headers['content-type']?.startsWith('multipart/form-data')) {
      const form = await new Request(request.url(), {
        method: 'POST',
        headers,
        body: request.postDataBuffer(),
      }).formData()
      for (const [key, value] of form) {
        if (typeof value === 'string') body[key] = value
        else images.push({ field: key, name: value.name, size: value.size })
      }
    } else body = request.postDataJSON() ?? {}
    requests.push({ url: request.url(), body, images })
    if (hold) await hold.promise
    if (failNext) {
      failNext = false
      await route.fulfill({ status: 500, json: { error: { message: '上游繁忙' } } })
      return
    }
    await route.fulfill({ json: { data: [{ b64_json: resultPng }] } })
  })

  // ── 造数据：两种服务、三个角色（封面尺寸各不同，便于对照发送顺序）、1v1 会话带历史配图与状态 ──
  const seed = await page.evaluate(async () => {
    const { useSettingsStore } = await import('/src/stores/settings.ts')
    const { useCharactersStore } = await import('/src/stores/characters.ts')
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const { newImageModelService } = await import('/src/types/image.ts')
    const { blobsRepo } = await import('/src/db/repositories/index.ts')
    const png = async (w, h, color) => {
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')
      g.fillStyle = color
      g.fillRect(0, 0, w, h)
      return c.convertToBlob({ type: 'image/png' })
    }
    const s = useSettingsStore()
    if (!s.loaded) await s.load()
    const openai = {
      ...newImageModelService('mock-openai'),
      name: '模拟接口',
      baseUrl: 'https://img.example.test/v1',
      model: 'mock-image',
      size: '1024x1024',
    }
    const comfy = {
      ...newImageModelService('mock-comfy'),
      name: '本地 ComfyUI',
      backend: 'comfyui',
      baseUrl: 'http://127.0.0.1:8188',
      model: 'qwen.gguf',
    }
    await s.saveImageModelService(openai, 'sk-test')
    await s.saveImageModelService(comfy, '')
    await s.selectImageModelService('mock-openai')

    const chars = useCharactersStore()
    if (!chars.loaded) await chars.load()
    const mk = async (name, desc, w, color) => {
      const c = await chars.create(name)
      c.data.description = desc
      c.avatarBlobId = await blobsRepo.put(await png(w, w * 1.5, color))
      await chars.save(c)
      return c
    }
    const a = await mk('时雨', '银色长发的魔女', 60, '#a44')
    const b = await mk('望月', '黑色短发的剑士', 70, '#44a')
    const c = await mk('小红', '红发少女', 80, '#a4a')

    const chats = useChatsStore()
    const meta = await chats.createSolo(a.id, '参考图测试')
    await chats.open(meta.id)
    await chats.appendUser('我们去钟楼吧。')
    const r1 = await chats.appendAi('时雨', a.id)
    await chats.writeRow(meta.id, r1, { mes: '她披上斗篷，和我一起走上钟楼。' })
    const histBlob = await png(50, 50, '#0a0')
    await chats.attachImage(meta.id, r1.id, {
      blob: histBlob,
      prompt: 'p',
      model: 'm',
      serviceName: '模拟接口',
    })
    await chats.appendUser('风好大。')
    const r2 = await chats.appendAi('时雨', a.id)
    await chats.writeRow(meta.id, r2, { mes: '她按住被风吹起的斗篷，望向远处。' })
    await chats.attachImage(meta.id, r2.id, {
      blob: await png(55, 55, '#0aa'),
      prompt: 'p',
      model: 'm',
      serviceName: '模拟接口',
    })
    // 目标消息那一刻的角色状态：地点 + 衣着要进提示词
    await chats.setMessageStatus(r2.id, {
      data: {
        scene: { 地点: '钟楼顶', 天气: '大风' },
        people: [{ name: '时雨', fields: { 衣着: '红色斗篷', 心理状态: '平静' } }],
      },
      source: 'ai',
      updatedAt: Date.now(),
    })
    return { chatId: meta.id, ids: [a.id, b.id, c.id], histSize: histBlob.size }
  })

  // ── 1v1：默认只勾选角色封面；提示词带状态；加一张历史配图 → 编号与发送顺序 ──
  await page.goto(`${origin}chat/${seed.chatId}`)
  await hideDevtools()
  await page.getByRole('button', { name: '生成对话配图' }).click()
  const dialog = page.getByRole('dialog', { name: '生成对话配图' })
  await expect(dialog.locator('.ref-card')).toHaveCount(1)
  await expect(dialog.locator('.ref-count')).toHaveText('1 / 6')
  const promptBox = dialog.getByLabel('画面描述', { exact: true })
  const p1 = await promptBox.inputValue()
  assert.match(p1, /钟楼顶/, '状态里的地点进提示词')
  assert.match(p1, /红色斗篷/, '状态里的衣着进提示词')
  assert.match(p1, /表情[\s\S]*肢体动作[\s\S]*穿着/, '提示词着重表情 / 动作 / 穿着')

  await dialog.getByRole('button', { name: /添加 \/ 更换参考图/ }).click()
  await expect(dialog.locator('.ref-group__title')).toHaveText(['角色封面', '历史配图'])
  // 历史配图新的在前：第 4 条（最新）排第一
  const histCands = dialog.locator('.ref-group').filter({ hasText: '历史配图' }).locator('.ref-cand')
  await expect(histCands).toHaveCount(2)
  await expect(histCands.first()).toContainText('第 4 条')
  await dialog.getByRole('button', { name: '选择 第 2 条 · 时雨的配图' }).click()
  await expect(dialog.locator('.ref-card')).toHaveCount(2)
  const p2 = await promptBox.inputValue()
  assert.match(p2, /参考图 2 是此前的一幅画面（第 2 条 · 时雨的配图）/, '未手改：提示词随选择重建')

  // 手改后再改选择：不覆盖，给出提示
  await promptBox.fill(p2 + '\n（手动补充：远处有烟花）')
  await dialog.getByRole('button', { name: '选择 第 4 条 · 时雨的配图' }).click()
  await expect(dialog.getByText('参考图已变化')).toBeVisible()
  assert.match(await promptBox.inputValue(), /手动补充/, '手改过的提示词不被覆盖')
  // 调整顺序：把第 3 张挪到第 2 位
  await dialog.getByRole('button', { name: '把参考图 3 前移' }).click()
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/image-refs/picker-desktop.png' })

  await dialog.getByRole('button', { name: '生成图片' }).click()
  await expect(dialog.getByRole('button', { name: '放大查看生成结果' })).toBeVisible()
  const edit1 = requests.at(-1)
  assert.ok(edit1.url.endsWith('/images/edits'))
  assert.deepEqual(
    edit1.images.map((i) => i.name),
    ['reference-1.png', 'reference-2.png', 'reference-3.png'],
  )
  assert.equal(edit1.images[2].size, seed.histSize, '第 2 条的配图按新顺序排在第 3 位')
  // 生成结果点开是统一预览
  await dialog.getByRole('button', { name: '放大查看生成结果' }).click()
  const lightbox = page.locator('dialog.lightbox')
  await expect(lightbox).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
  await dialog.getByRole('button', { name: '保存到对话' }).click()
  await expect(dialog).toHaveCount(0)

  // ── 统一预览：聊天配图左右切换 + 计数；头像点开；返回键关闭 ──
  const imgs = page.locator('.message-image .frame')
  await expect(imgs).toHaveCount(3)
  await imgs.first().click()
  await expect(lightbox).toBeVisible()
  await expect(lightbox.locator('.lightbox__count')).toHaveText('1 / 3')
  await page.keyboard.press('ArrowRight')
  await expect(lightbox.locator('.lightbox__count')).toHaveText('2 / 3')
  await lightbox.getByRole('button', { name: '下一张' }).click()
  await expect(lightbox.locator('.lightbox__count')).toHaveText('3 / 3')
  await expect(lightbox.getByRole('button', { name: '下一张' })).toBeDisabled()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/image-refs/preview-multi.png' })
  const urlBefore = page.url()
  await page.goBack()
  await expect(lightbox).toHaveCount(0)
  assert.equal(page.url(), urlBefore, '返回键只关预览，不离开聊天页')
  await page.getByRole('button', { name: '预览时雨的图片' }).first().click()
  await expect(lightbox).toBeVisible()
  await expect(lightbox.locator('.lightbox__count')).toHaveCount(0)
  await page.keyboard.press('Escape')

  // ── 群聊：多图参考 + 群聊封面入池 + ComfyUI 限量截断 ──
  const groupId = await page.evaluate(async (ids) => {
    const { useGroupsStore } = await import('/src/stores/groups.ts')
    const groups = useGroupsStore()
    if (!groups.loaded) await groups.load()
    const g = await groups.create('钟楼三人组')
    g.members = ids
    await groups.save(g)
    return g.id
  }, seed.ids)

  await page.goto(`${origin}groups/${groupId}`)
  await hideDevtools()
  await page.getByRole('button', { name: '生成封面' }).click()
  const cover = page.getByRole('dialog', { name: '生成群聊封面' })
  await expect(cover.locator('.ref-card')).toHaveCount(3)
  assert.match(await cover.getByLabel('画面描述', { exact: true }).inputValue(), /横版合影/)
  await cover.getByRole('button', { name: '生成图片' }).click()
  await expect(cover.getByRole('button', { name: '放大查看生成结果' })).toBeVisible()
  const coverReq = requests.at(-1)
  assert.equal(coverReq.images.length, 3, '群聊封面带全体成员封面')
  assert.equal(coverReq.body.size, '1536x1024', '群聊封面是横版')
  await cover.getByRole('button', { name: '设为群聊封面' }).click()
  await expect(cover).toHaveCount(0)
  await expect(page.locator('.gcover__img')).toBeVisible()
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/image-refs/group-cover-edit.png' })
  const savedGroup = await page.evaluate(async (id) => {
    const { getDb } = await import('/src/db/schema.ts')
    return (await getDb()).get('groups', id)
  }, groupId)
  assert.ok(savedGroup.avatarBlobId, '群聊封面落库')

  // 群聊列表：横幅 + 放大按钮打开预览且不跳转
  await page.goto(`${origin}groups`)
  await hideDevtools()
  await expect(page.locator('.banner__img')).toBeVisible()
  await page.getByRole('button', { name: '放大查看「钟楼三人组」的封面' }).click()
  await expect(lightbox).toBeVisible()
  assert.ok(page.url().endsWith('/groups'), '放大按钮不跳转编辑页')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/image-refs/groups-banner.png' })
  // 角色列表的放大按钮同理
  await page.goto(`${origin}characters`)
  await hideDevtools()
  await page.getByRole('button', { name: '放大查看「时雨」的封面' }).click()
  await expect(lightbox).toBeVisible()
  assert.ok(page.url().endsWith('/characters'))
  await page.keyboard.press('Escape')

  // 群聊配图：候选含群聊封面；选 4 张后切到 ComfyUI → 截断到 3
  const gChat = await page.evaluate(async (id) => {
    const { useChatsStore } = await import('/src/stores/chats.ts')
    const chats = useChatsStore()
    const meta = await chats.createGroup(id, '群聊配图')
    await chats.open(meta.id)
    await chats.appendUser('望月和小红在钟楼上比剑。')
    return meta.id
  }, groupId)
  await page.goto(`${origin}chat/${gChat}`)
  await hideDevtools()
  await page.getByRole('button', { name: '生成对话配图' }).click()
  const gd = page.getByRole('dialog', { name: '生成对话配图' })
  // 用户的话点名了望月、小红 → 默认勾选这两位
  await expect(gd.locator('.ref-card')).toHaveCount(2)
  await gd.getByRole('button', { name: /添加 \/ 更换参考图/ }).click()
  await expect(gd.locator('.ref-group__title')).toHaveText(['角色封面', '群聊封面'])
  await gd.getByRole('button', { name: '选择 时雨的封面' }).click()
  await gd.getByRole('button', { name: '选择 群聊封面' }).click()
  await expect(gd.locator('.ref-card')).toHaveCount(4)
  await gd.getByLabel('文生图配置').selectOption({ label: '本地 ComfyUI · qwen.gguf' })
  await expect(gd.locator('.ref-card')).toHaveCount(3)
  await expect(gd.locator('.ref-count')).toHaveText('3 / 3')
  await expect(gd.getByText('当前配置最多使用 3 张参考图')).toBeVisible()
  // 满额时其余候选不可选
  await expect(gd.getByRole('button', { name: '选择 群聊封面' })).toBeDisabled()

  // 手机：选择器与预览不溢出
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    '手机上生图对话框无横向溢出',
  )
  await page.screenshot({ path: 'test-results/image-refs/picker-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 1000 })

  await gd.locator('footer').getByRole('button', { name: '关闭' }).click()
  await expect(gd).toHaveCount(0)

  // ── 最小化：生成期间收起，继续聊天 / 切会话；完成后自动保存 + 可点击提示定位到图片 ──
  await page.goto(`${origin}chat/${seed.chatId}`)
  await hideDevtools()
  // 前面已存进来一张，共 3 张；先等渲染出来再计数
  await expect(page.locator('.message-image')).toHaveCount(3)
  const imagesBefore = 3
  let release
  hold = { promise: new Promise((r) => (release = r)) }
  await page.getByRole('button', { name: '生成对话配图' }).click()
  const md = page.getByRole('dialog', { name: '生成对话配图' })
  await md.getByRole('button', { name: '生成图片' }).click()
  await md.getByRole('button', { name: '最小化' }).click()
  const pill = page.locator('.gen-pill')
  await expect(pill).toContainText('正在生成配图')
  await expect(page.locator('dialog.image-dialog[open]')).toHaveCount(0)
  // 页面可交互：输入框能输入
  await page.locator('.composer textarea').fill('继续聊天中……')
  await expect(page.locator('.composer textarea')).toHaveValue('继续聊天中……')
  await page.waitForTimeout(250)
  await page.screenshot({ path: 'test-results/image-refs/minimized.png' })
  // 切到别的会话：生成不中断，进度条还在
  // ⚠️ 必须站内路由跳转：page.goto 会整页重载，正在进行的生成随之作废
  await page.evaluate(
    (id) =>
      document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(`/chat/${id}`),
    gChat,
  )
  await expect(page).toHaveURL(new RegExp(`/chat/${gChat}$`))
  await expect(pill).toContainText('正在生成配图')
  release()
  hold = null
  const toastEl = page.locator('.toast--action').filter({ hasText: '配图已生成并保存到对话' })
  await expect(toastEl).toBeVisible()
  await expect(pill).toHaveCount(0)
  await toastEl.click()
  await expect(page).toHaveURL(new RegExp(`/chat/${seed.chatId}$`))
  await expect(page.locator('.message-image')).toHaveCount(imagesBefore + 1)
  const flashed = page.locator('.message-image--flash')
  await expect(flashed).toHaveCount(1)
  await expect(flashed).toBeInViewport()
  await page.waitForTimeout(300)
  await page.screenshot({ path: 'test-results/image-refs/reveal.png' })

  // 失败：最小化期间出错 → 可点击提示 → 点开展开对话框并显示错误
  failNext = true
  let releaseFail
  hold = { promise: new Promise((r) => (releaseFail = r)) }
  await page.getByRole('button', { name: '生成对话配图' }).click()
  await md.getByRole('button', { name: '生成图片' }).click()
  await md.getByRole('button', { name: '最小化' }).click()
  releaseFail()
  hold = null
  await expect(pill).toContainText('配图生成失败')
  await expect(pill).toHaveClass(/gen-pill--error/)
  await pill.getByRole('button', { name: '展开' }).click()
  await expect(md).toBeVisible()
  await expect(md.getByRole('alert')).toContainText('500')
  await md.locator('footer').getByRole('button', { name: '关闭' }).click()


  // ── 手机：最小化后返回手势离开聊天页，生成不中断；点「查看」回到原会话定位到图片 ──
  const phone = await ctx.newPage()
  phone.on('pageerror', (e) => errors.push(e.message))
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(`${origin}characters`)
  await phone.addStyleTag({ content: '#__vue-devtools-container__{display:none!important}' })
  await phone.waitForFunction(() => document.querySelector('#app')?.__vue_app__)
  const nav = (path) =>
    phone.evaluate(
      (to) => document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(to),
      path,
    )
  await nav(`/chat/${seed.chatId}`)
  await expect(phone.locator('.message-image')).toHaveCount(4)
  let releasePhone
  hold = { promise: new Promise((r) => (releasePhone = r)) }
  await phone.getByRole('button', { name: '生成对话配图' }).click()
  const pd = phone.getByRole('dialog', { name: '生成对话配图' })
  await pd.getByRole('button', { name: '生成图片' }).click()
  const minBtn = pd.getByRole('button', { name: '最小化' })
  await expect(minBtn).toBeInViewport()
  const mb = await minBtn.boundingBox()
  assert.ok(mb.height >= 44, `手机上最小化按钮触控区 ${mb.height}px`)
  await phone.waitForTimeout(250)
  await phone.screenshot({ path: 'test-results/image-refs/mobile-dialog-busy.png' })
  await minBtn.click()
  const ppill = phone.locator('.gen-pill')
  await expect(ppill).toBeVisible()
  await expect(ppill).toBeInViewport({ ratio: 1 })
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await phone.locator('.composer textarea').fill('手机上继续聊')
  await phone.waitForTimeout(250)
  await phone.screenshot({ path: 'test-results/image-refs/mobile-minimized.png' })
  // 离开聊天页（顶栏返回，等同返回手势）：聊天页卸载，但任务挂在应用层，进度条还在
  await phone.locator('.chat-topbar').getByRole('button', { name: '返回' }).click()
  await expect(phone).not.toHaveURL(/\/chat\//)
  await expect(phone.locator('.composer')).toHaveCount(0)
  await expect(ppill).toContainText('正在生成配图')
  releasePhone()
  hold = null
  const ptoast = phone.locator('.toast--action').filter({ hasText: '配图已生成并保存到对话' })
  await expect(ptoast).toBeVisible()
  await phone.waitForTimeout(250)
  await phone.screenshot({ path: 'test-results/image-refs/mobile-toast.png' })
  await ptoast.click()
  await expect(phone).toHaveURL(new RegExp(`/chat/${seed.chatId}$`))
  await expect(phone.locator('.message-image')).toHaveCount(5)
  const pflash = phone.locator('.message-image--flash')
  await expect(pflash).toHaveCount(1)
  await expect(pflash).toBeInViewport()
  await phone.waitForTimeout(400)
  await phone.screenshot({ path: 'test-results/image-refs/mobile-reveal.png' })
  await phone.close()

  assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
  console.log(`verify:image-refs 全部通过（${requests.length} 次生图请求）`)
} finally {
  await browser?.close()
  await server.close()
}
