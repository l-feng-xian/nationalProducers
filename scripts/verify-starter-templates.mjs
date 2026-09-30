import assert from 'node:assert/strict'
import { chromium, expect } from '@playwright/test'
import { createServer } from 'vite'
import { pickOption } from './lib/cbx-select.mjs'

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(server.resolvedUrls.local[0])
  await page.waitForFunction(() => document.querySelector('.app-sidebar, nav, main') !== null)
  const inspect = () => page.evaluate(async () => {
    const open = indexedDB.open('np-chat')
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const tx = db.transaction(['characters', 'groups', 'worldbooks', 'settings', 'blobs', 'starter_template_images'])
    const read = (store) => new Promise((resolve, reject) => {
      const req = tx.objectStore(store).getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const [characters, groups, books, settings, blobs, starterTemplateImages] = await Promise.all(['characters', 'groups', 'worldbooks', 'settings', 'blobs', 'starter_template_images'].map(read))
    db.close()
    return { characters, groups, books, settings, blobCount: blobs.length, starterTemplateImageCount: starterTemplateImages.length, starterTemplateMimes: starterTemplateImages.map((image) => image.mime) }
  })
  await page.waitForFunction(async () => {
    const open = indexedDB.open('np-chat')
    const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result) })
    const tx = db.transaction('settings')
    const req = tx.objectStore('settings').get('app')
    const settings = await new Promise((resolve) => { req.onsuccess = () => resolve(req.result) })
    db.close()
    return settings?.starterTemplatesVersion === 1
  })
  await expect.poll(async () => (await inspect()).starterTemplateImageCount, { timeout: 60000 }).toBe(12)
  let data = await inspect()
  assert.equal(data.characters.length, 9)
  assert.equal(data.groups.length, 3)
  assert.equal(data.starterTemplateImageCount, 12)
  assert.ok(data.starterTemplateMimes.every((mime) => mime.startsWith('image/') && mime !== 'image/svg+xml'))

  const charId = data.characters[0].id
  const groupId = data.groups[0].id
  const otherBook = data.books.find((book) => book.id !== data.characters[0].worldBookId).id
  await page.goto(`${server.resolvedUrls.local[0]}characters/${charId}`)
  await page.getByRole('button', { name: '高级', exact: true }).click()
  await pickOption(page.locator('main'), '主世界书', { value: '' })
  await expect.poll(async () => (await inspect()).characters.find((char) => char.id === charId)?.worldBookId).toBe('')
  await pickOption(page.locator('main'), '主世界书', { value: otherBook })
  await expect.poll(async () => (await inspect()).characters.find((char) => char.id === charId)?.worldBookId).toBe(otherBook)
  await page.goto(`${server.resolvedUrls.local[0]}groups/${groupId}`)
  await page.getByRole('button', { name: '发言策略', exact: true }).click()
  await pickOption(page.locator('main'), '主世界书', { value: '' })
  await expect.poll(async () => (await inspect()).groups.find((group) => group.id === groupId)?.worldBookId).toBe('')
  await pickOption(page.locator('main'), '主世界书', { value: otherBook })
  await expect.poll(async () => (await inspect()).groups.find((group) => group.id === groupId)?.worldBookId).toBe(otherBook)

  assert.equal(data.books.length, 3)
  assert.equal(data.settings[0].starterTemplatesVersion, 1)
  for (const group of data.groups) {
    assert.equal(group.members.length, 3)
    assert.ok(group.relations.length >= 6)
    assert.equal(group.flow.stages.length, 3)
    assert.ok(data.books.some((b) => b.id === group.worldBookId && Object.keys(b.entries).length >= 4))
    assert.ok(group.persona.description)
  }
  await page.reload()
  data = await inspect()
  assert.equal(data.characters.length, 9)
  assert.equal(data.groups.length, 3)

  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=='
  let imageRequests = 0
  let editedCharId = ''
  await page.route('https://starter-images.example.test/**', async (route) => {
    imageRequests++
    if (!editedCharId) {
      const prompt = route.request().postDataJSON().prompt
      const target = data.characters.find((char) => prompt.includes(char.data.name))
      assert.ok(target, 'first cover request should identify a starter character')
      editedCharId = target.id
      await page.evaluate(async (id) => {
        const open = indexedDB.open('np-chat')
        const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result) })
        const tx = db.transaction('characters', 'readwrite')
        const store = tx.objectStore('characters')
        const get = store.get(id)
        const char = await new Promise((resolve) => { get.onsuccess = () => resolve(get.result) })
        char.data.description += ' 用户编辑'
        char.updatedAt += 100000
        store.put(char)
        await new Promise((resolve) => { tx.oncomplete = resolve })
        db.close()
      }, editedCharId)
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png }] }) })
  })
  await page.evaluate(async () => {
    const open = indexedDB.open('np-chat')
    const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result) })
    const tx = db.transaction('settings', 'readwrite')
    const store = tx.objectStore('settings')
    const get = store.get('app')
    const settings = await new Promise((resolve) => { get.onsuccess = () => resolve(get.result) })
    const service = {
      id: 'starter-test', name: 'Starter test', backend: 'openai', baseUrl: 'https://starter-images.example.test/v1',
      model: 'mock-image', secretRef: 'starter-test', proxyPrefix: '', size: '1024x1024', quality: '', responseFormat: 'b64_json',
      referenceMode: '', clipName: '', vaeName: '', negativePrompt: '', steps: 12, cfg: 1, sampler: 'euler', scheduler: 'simple', resolution: 1024, denoise: 1,
    }
    settings.imageModelServices = [service]
    settings.activeImageModelServiceId = service.id
    store.put(settings)
    await new Promise((resolve) => { tx.oncomplete = resolve })
    db.close()
  })
  await page.reload()
  await expect.poll(() => imageRequests, { timeout: 60000 }).toBeGreaterThan(0)
  await expect.poll(async () => (await inspect()).blobCount, { timeout: 60000 }).toBe(12)
  data = await inspect()
  assert.equal(data.starterTemplateImageCount, 12)
  const edited = data.characters.find((char) => char.id === editedCharId)
  assert.ok(edited?.data.description.endsWith('用户编辑'))
  assert.ok(edited.avatarBlobId)
  assert.ok(imageRequests > 0)
  await page.reload()
  await expect.poll(async () => (await inspect()).blobCount, { timeout: 60000 }).toBe(12)
  assert.equal((await inspect()).starterTemplateImageCount, 12)
  assert.ok(imageRequests > 0)
  const restoredId = data.characters.find((char) => char.id !== editedCharId).id
  await page.evaluate(async (id) => {
    const open = indexedDB.open('np-chat')
    const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result) })
    const tx = db.transaction(['characters', 'settings'], 'readwrite')
    const chars = tx.objectStore('characters')
    const char = await new Promise((resolve) => { const req = chars.get(id); req.onsuccess = () => resolve(req.result) })
    char.avatarBlobId = undefined
    char.updatedAt = char.createdAt
    chars.put(char)
    const store = tx.objectStore('settings')
    const settings = await new Promise((resolve) => { const req = store.get('app'); req.onsuccess = () => resolve(req.result) })
    settings.activeImageModelServiceId = ''
    store.put(settings)
    await new Promise((resolve) => { tx.oncomplete = resolve })
    db.close()
  }, restoredId)
  await page.reload()
  await expect.poll(async () => (await inspect()).characters.find((char) => char.id === restoredId)?.avatarBlobId).toBeTruthy()
  assert.ok(imageRequests > 0)

  await page.evaluate(async (id) => {
    const open = indexedDB.open('np-chat')
    const db = await new Promise((resolve) => { open.onsuccess = () => resolve(open.result) })
    const tx = db.transaction('groups', 'readwrite')
    tx.objectStore('groups').delete(id)
    await new Promise((resolve) => { tx.oncomplete = resolve })
    db.close()
  }, groupId)
  await page.reload()
  await expect.poll(async () => (await inspect()).groups.some((group) => group.id === groupId)).toBe(false)
  assert.equal((await inspect()).groups.length, 2)
  assert.deepEqual(errors, [])
  console.log('✓ 三套模板、世界书、关系、流程、12 张模板封面持久化与离线恢复通过')
} finally {
  await browser?.close()
  await server.close()
}
