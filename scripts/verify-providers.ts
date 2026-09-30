/**
 * 主流模型服务兼容层：预设识别 / 各家参数规则 / 400 自愈重试 的断言。
 * 全部离线：用桩 fetch 模拟服务端，不发真实请求。
 *
 * 跑法： npm run verify:providers
 */

import {
  PROVIDER_PRESETS,
  applyCompat,
  familyOf,
  normalizeModelId,
  paramsToHeal,
  presetForUrl,
} from '@/services/provider/compat'
import { chatOnce, streamChat } from '@/services/provider/openaiCompatible'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else failed++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const base = () => ({
  model: 'm',
  messages: [],
  stream: true,
  stream_options: { include_usage: true },
  max_tokens: 1024,
  temperature: 0.9,
  top_p: 0.95,
  frequency_penalty: 0.2,
  presence_penalty: 0.1,
  stop: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
})

// ── 1. 识别 ──
{
  check('DeepSeek', familyOf('https://api.deepseek.com/v1') === 'deepseek')
  check(
    'Kimi 国内/海外',
    familyOf('https://api.moonshot.cn/v1') === 'moonshot' &&
      familyOf('https://api.moonshot.ai/v1') === 'moonshot',
  )
  check('Gemini', familyOf('https://generativelanguage.googleapis.com/v1beta/openai') === 'gemini')
  check('自建中转不套特例', familyOf('https://api.yoshub.com/v1') === 'other')
  check('Ollama', familyOf('http://127.0.0.1:11434/v1') === 'ollama')
  check('预设回显按域名', presetForUrl('https://api.moonshot.ai/v1')?.id === 'moonshot-intl')
  check(
    '每个预设都能被识别回自己',
    PROVIDER_PRESETS.every((p) => presetForUrl(p.baseUrl)?.id === p.id),
  )
  check(
    'Gemini 模型 id 去掉 models/ 前缀',
    normalizeModelId(
      'https://generativelanguage.googleapis.com/v1beta/openai',
      'models/gemini-2.5-flash',
    ) === 'gemini-2.5-flash',
  )
  check('别家模型 id 不动', normalizeModelId('https://api.deepseek.com', 'models/x') === 'models/x')
}

// ── 2. 各家静态规则 ──
{
  const kimi = applyCompat(
    { ...base(), model: 'kimi-k2.6' },
    { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2.6', stream: true },
  )
  check(
    'Kimi K2.6：不传 temperature/top_p/惩罚项',
    !('temperature' in kimi) &&
      !('top_p' in kimi) &&
      !('frequency_penalty' in kimi) &&
      !('presence_penalty' in kimi),
  )
  const kimiOld = applyCompat(
    { ...base() },
    { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', stream: true },
  )
  check('Kimi 旧型号：温度照常传', kimiOld['temperature'] === 0.9)
  const k3 = applyCompat(
    { ...base() },
    { baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', stream: true },
  )
  check('Kimi K3：同样不传温度', !('temperature' in k3))

  const gem = applyCompat(
    { ...base() },
    {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-flash-latest',
      stream: true,
    },
  )
  check(
    'Gemini：stop 截到 5 个（保留前面的）',
    Array.isArray(gem['stop']) && (gem['stop'] as string[]).join('') === 'abcde',
  )
  check('Gemini：去掉惩罚项、保留温度', !('frequency_penalty' in gem) && gem['temperature'] === 0.9)

  const o = applyCompat(
    { ...base() },
    { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', stream: true },
  )
  check(
    'OpenAI 推理型号：去温度、max_completion_tokens',
    !('temperature' in o) && o['max_completion_tokens'] === 1024 && !('max_tokens' in o),
  )
  check('OpenAI：stop 截到 4 个', (o['stop'] as string[]).length === 4)
  const o4 = applyCompat(
    { ...base() },
    { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1', stream: true },
  )
  check(
    'OpenAI 普通型号：温度与 max_tokens 照常',
    o4['temperature'] === 0.9 && o4['max_tokens'] === 1024,
  )

  const ds = applyCompat(
    { ...base() },
    {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-flash',
      stream: true,
      thinking: 'off',
    },
  )
  check(
    'DeepSeek 关思考：thinking.type=disabled',
    JSON.stringify(ds['thinking']) === '{"type":"disabled"}',
  )
  check('DeepSeek：stop 不截（上限宽）', (ds['stop'] as string[]).length === 7)
  const dsAuto = applyCompat(
    { ...base() },
    { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', stream: true },
  )
  check('思考=默认：不加任何开关', !('thinking' in dsAuto))

  const qwen = applyCompat(
    { ...base(), stream: false },
    {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3-32b',
      stream: false,
    },
  )
  check('通义非流式：自动 enable_thinking=false', qwen['enable_thinking'] === false)
  const qwenOn = applyCompat(
    { ...base() },
    {
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      stream: true,
      thinking: 'on',
    },
  )
  check('通义开思考：enable_thinking=true', qwenOn['enable_thinking'] === true)

  const gemOff = applyCompat(
    { ...base() },
    {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      model: 'gemini-flash-latest',
      stream: true,
      thinking: 'off',
    },
  )
  check('Gemini 关思考：reasoning_effort=none', gemOff['reasoning_effort'] === 'none')

  const other = applyCompat(
    { ...base() },
    { baseUrl: 'https://my-relay.example/v1', model: 'x', stream: true, thinking: 'off' },
  )
  check(
    '未知服务：原样发送，不加思考参数',
    other['temperature'] === 0.9 &&
      !('thinking' in other) &&
      (other['stop'] as string[]).length === 7,
  )
}

// ── 3. 自愈参数推断 ──
{
  const b = base()
  check(
    '点名 temperature',
    paramsToHeal(
      '{"error":{"message":"invalid temperature: only 1 is allowed for this model"}}',
      b,
    ).join() === 'temperature',
  )
  check(
    '点名 stop 上限',
    paramsToHeal('the number of stop_sequences must not exceed 5', b).join() === 'stop',
  )
  check(
    'Unsupported parameter: max_tokens → 换字段',
    paramsToHeal(
      "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.",
      b,
    ).join() === 'max_tokens',
  )
  check('没点名 → 怀疑 stream_options', paramsToHeal('Bad Request', b).join() === 'stream_options')
  check(
    '没点名且没有 stream_options → 放弃',
    paramsToHeal('Bad Request', { model: 'm' }).length === 0,
  )
  check(
    '点名但请求里没有这个参数 → 不算',
    paramsToHeal('invalid temperature', { model: 'm' }).length === 0,
  )
}

// ── 4. 端到端自愈：桩 fetch ──
type Handler = (body: Record<string, unknown>) => Response
const calls: Record<string, unknown>[] = []
function stub(h: Handler) {
  calls.length = 0
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push(body)
    return h(body)
  }) as typeof fetch
}
const ok = (content: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }),
    { status: 200 },
  )
const bad = (msg: string) =>
  new Response(JSON.stringify({ error: { message: msg } }), { status: 400 })

{
  // 一个「只认温度 1」的中转（识别不出是 Kimi，只能靠自愈）
  stub((b) =>
    'temperature' in b ? bad('invalid temperature: only 1 is allowed for this model') : ok('好'),
  )
  const cfg = { baseUrl: 'https://relay-a.example/v1' }
  const out = await chatOnce(cfg, {
    model: 'kimi-k2.6',
    messages: [],
    stream: false,
    temperature: 0.3,
    maxTokens: 64,
  })
  check(
    '自愈：去掉温度后成功',
    out === '好' && calls.length === 2 && !('temperature' in (calls[1] ?? {})),
  )
  await chatOnce(cfg, { model: 'kimi-k2.6', messages: [], stream: false, temperature: 0.3 })
  check(
    '自愈：第二次直接不带温度（记住了）',
    calls.length === 3 && !('temperature' in (calls[2] ?? {})),
  )
  await chatOnce(cfg, {
    model: 'other-model',
    messages: [],
    stream: false,
    temperature: 0.3,
  }).catch(() => '')
  check('自愈：按模型分开记，别的模型照常带温度', 'temperature' in (calls[3] ?? {}))
}
{
  // 模型名错了：400 且没点名任何参数 → 不应无限重试，也不应冤枉 stream_options
  stub(() => bad('Model Not Exist'))
  const cfg = { baseUrl: 'https://relay-b.example/v1' }
  let err = ''
  try {
    for await (const _ of streamChat(cfg, { model: 'nope', messages: [], stream: true })) void _
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  check(
    '错误的模型名：重试一次后报原始错误',
    calls.length === 2 && err.includes('Model Not Exist'),
    `calls=${calls.length} err=${err}`,
  )
  stub(() => bad('Model Not Exist'))
  try {
    for await (const _ of streamChat(cfg, { model: 'nope', messages: [], stream: true })) void _
  } catch {
    /* 预期失败 */
  }
  check('没冤枉 stream_options：下次仍然带上', 'stream_options' in (calls[0] ?? {}))
}
{
  // 非 400（鉴权失败）不重试
  stub(() => new Response('{"error":{"message":"bad key"}}', { status: 401 }))
  await chatOnce(
    { baseUrl: 'https://relay-c.example/v1' },
    { model: 'x', messages: [], stream: false, temperature: 1 },
  ).catch(() => '')
  check('401 不重试', calls.length === 1)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
