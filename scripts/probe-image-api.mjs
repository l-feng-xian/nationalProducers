/**
 * 真机探测文生图服务的参考图请求格式（OpenAI multipart vs xAI JSON image_urls）。
 *
 * 用法（凭据从环境变量读取，不写死在仓库里）：
 *   IMAGE_API_BASE=https://api.yoshub.com/v1 \
 *   IMAGE_API_KEY=sk-... \
 *   IMAGE_MODEL=grok-imagine-image-2.0 \
 *   node scripts/probe-image-api.mjs
 *
 * 依次执行：
 *   1. GET  /models                 —— 确认密钥与模型名
 *   2. POST /images/generations     —— 纯文生图基线（JSON）
 *   3. POST /images/edits (multipart) —— 复现当前客户端的参考图请求
 *   4. POST /images/edits (JSON)    —— 验证 xAI 风格 image_urls 是否可用
 */
const base = (process.env.IMAGE_API_BASE ?? '').replace(/\/+$/, '')
const key = process.env.IMAGE_API_KEY ?? ''
const model = process.env.IMAGE_MODEL ?? ''
if (!base || !key || !model) {
  console.error('请设置 IMAGE_API_BASE / IMAGE_API_KEY / IMAGE_MODEL 环境变量')
  process.exit(1)
}

const auth = { Authorization: `Bearer ${key}` }
/** 1x1 红色 PNG，作为最小参考图。 */
const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='

function brief(text, limit = 400) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  return s.length > limit ? `${s.slice(0, limit)}…` : s
}

async function show(label, path, init) {
  const started = Date.now()
  let res
  try {
    res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(180_000), ...init })
  } catch (error) {
    console.log(`\n[${label}] ${path}\n  ✗ 网络错误: ${error.name}: ${brief(error.message)}`)
    return null
  }
  const text = await res.text()
  console.log(
    `\n[${label}] ${path}\n  HTTP ${res.status} ${res.statusText} · ${Date.now() - started}ms · content-type=${res.headers.get('content-type') ?? '?'}`,
  )
  console.log(`  body: ${brief(text)}`)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 原样展示即可 */
  }
  return { res, json }
}

console.log(`探测目标: ${base} · 模型: ${model}`)

// 1. 模型列表
const models = await show('模型列表', '/models', { headers: auth })
if (models?.json) {
  const ids = (models.json.data ?? []).map((m) => m.id)
  const hit = ids.filter((id) => /imagine|grok|image/i.test(id))
  console.log(`  模型总数 ${ids.length}，与 grok/imagine/image 相关: ${hit.join(', ') || '（无）'}`)
  console.log(`  精确匹配 ${model}: ${ids.includes(model) ? '存在' : '不存在'}`)
}

// 2. 纯文生图基线
await show('纯文生图', '/images/generations', {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, prompt: 'a tiny red square on white background', n: 1 }),
})

// 3. multipart（当前客户端的参考图请求，预期失败）
{
  const form = new FormData()
  form.append('model', model)
  form.append('prompt', 'keep the reference image as-is')
  form.append('n', '1')
  form.append(
    'image',
    new Blob([Buffer.from(tinyPngBase64, 'base64')], { type: 'image/png' }),
    'reference-1.png',
  )
  await show('参考图 multipart（OpenAI 格式）', '/images/edits', {
    method: 'POST',
    headers: auth,
    body: form,
  })
}

// 4. JSON image_urls（xAI 格式，data URI）
await show('参考图 JSON image_urls（xAI 格式）', '/images/edits', {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model,
    prompt: 'keep the reference image as-is',
    n: 1,
    image_urls: [`data:image/png;base64,${tinyPngBase64}`],
  }),
})
