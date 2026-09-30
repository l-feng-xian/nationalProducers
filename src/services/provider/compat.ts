/**
 * 主流模型服务的预设与兼容层。
 *
 * 这些服务都实现了 OpenAI `/chat/completions`，但「兼容」不等于「完全一样」，
 * 同一份请求体在不同家会因为某个参数直接 400。已知的坑（2026-09 核实）：
 *  - Kimi K2.5 及以后（K2.6 / K2.7 / K3）：temperature / top_p / 惩罚项是**固定值**，
 *    传了任何值都报 `invalid temperature: only 1 is allowed` → 必须不传；
 *  - Gemini：stop 最多 5 个；多数型号不认 frequency/presence_penalty；
 *  - OpenAI：stop 最多 4 个；推理型号（o 系列、gpt-5）不认 temperature/top_p，
 *    且要用 max_completion_tokens 代替 max_tokens；
 *  - DeepSeek V4：旧名 deepseek-chat / deepseek-reasoner 已于 2026-07 下线；
 *    默认开思考，关掉用 `thinking: { type: 'disabled' }`；
 *  - 通义千问（DashScope）：Qwen3 非流式调用必须显式 `enable_thinking: false`。
 *
 * 静态规则只覆盖已知情况。另有一层**自愈**：服务端 400/422 且错误信息点名了某个参数时，
 * 去掉它重试，并按「服务地址 × 模型」记住（进程内），见 openaiCompatible.ts 的 postChat。
 *
 * 纯 TS，不 import vue/pinia。
 */

import type { ProviderConfig, ThinkingMode } from '@/types/provider'

export type ProviderFamily =
  | 'deepseek'
  | 'moonshot'
  | 'gemini'
  | 'openai'
  | 'anthropic'
  | 'dashscope'
  | 'zhipu'
  | 'ark'
  | 'siliconflow'
  | 'openrouter'
  | 'ollama'
  | 'other'

export interface ProviderPreset {
  id: string
  label: string
  family: ProviderFamily
  baseUrl: string
  /** 推荐的默认模型；空 = 型号更新太快或需在控制台开通，请用「拉取模型列表」选 */
  model: string
  contextWindow: number
  /** 在哪里申请 API Key */
  keyUrl?: string
  /** 本地服务不需要 Key */
  noKey?: boolean
  note?: string
}

/**
 * 上下文窗口统一给 64k：这些模型大多支持 128k~1M，但窗口越大、每轮带的历史越多、
 * 每轮花的钱越多。需要更长记忆可以在编辑器里自己调大。
 */
const CTX = 65536

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek 深度求索',
    family: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    contextWindow: CTX,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '默认开启思考；角色扮演建议把「思考模式」设为关闭，出字更快、更省钱。旧模型名 deepseek-chat / deepseek-reasoner 已下线。',
  },
  {
    id: 'moonshot-cn',
    label: 'Kimi 月之暗面（国内）',
    family: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    contextWindow: CTX,
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: 'K2.5 及以后的型号温度等采样参数是固定的，这里设置的温度会被自动忽略。',
  },
  {
    id: 'moonshot-intl',
    label: 'Kimi Moonshot（海外）',
    family: 'moonshot',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.6',
    contextWindow: CTX,
    keyUrl: 'https://platform.kimi.ai/console/api-keys',
    note: 'K2.5 及以后的型号温度等采样参数是固定的，这里设置的温度会被自动忽略。',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    family: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-flash-latest',
    contextWindow: CTX,
    keyUrl: 'https://aistudio.google.com/apikey',
    note: '国内网络通常需要代理。停止词最多 5 个，演绎时超出的会被自动截掉。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    family: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    contextWindow: CTX,
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '推理型号（o 系列 / gpt-5）不支持温度，会自动省略。',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude（OpenAI 兼容）',
    family: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: '',
    contextWindow: CTX,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: '走 Claude 官方的 OpenAI 兼容接口；国内网络通常需要代理。',
  },
  {
    id: 'dashscope',
    label: '通义千问（阿里云百炼）',
    family: 'dashscope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    contextWindow: CTX,
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    family: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: '',
    contextWindow: CTX,
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'ark',
    label: '豆包（火山方舟）',
    family: 'ark',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: '',
    contextWindow: CTX,
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    note: '模型需先在方舟控制台开通，模型名填控制台里的模型 ID 或推理接入点 ID。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    family: 'siliconflow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: '',
    contextWindow: CTX,
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    family: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    contextWindow: CTX,
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  {
    id: 'ollama',
    label: 'Ollama（本地）',
    family: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: '',
    contextWindow: 16384,
    noKey: true,
    note: '本地运行，不需要 API Key。上下文窗口请按你在 Ollama 里设置的 num_ctx 填写。',
  },
]

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 按接口地址识别服务商。自建中转、别的域名一律 other：不套任何特例 */
export function familyOf(baseUrl: string): ProviderFamily {
  const h = hostOf(baseUrl)
  if (!h) return 'other'
  const is = (d: string) => h === d || h.endsWith(`.${d}`)
  if (is('deepseek.com')) return 'deepseek'
  if (is('moonshot.cn') || is('moonshot.ai')) return 'moonshot'
  if (h === 'generativelanguage.googleapis.com') return 'gemini'
  if (h === 'api.openai.com') return 'openai'
  if (h === 'api.anthropic.com') return 'anthropic'
  if (is('dashscope.aliyuncs.com')) return 'dashscope'
  if (is('bigmodel.cn')) return 'zhipu'
  if (is('volces.com')) return 'ark'
  if (is('siliconflow.cn') || is('siliconflow.com')) return 'siliconflow'
  if (is('openrouter.ai')) return 'openrouter'
  if ((h === '127.0.0.1' || h === 'localhost') && baseUrl.includes(':11434')) return 'ollama'
  return 'other'
}

/** 当前地址对应的预设（编辑器回显用）。同一家有多个地址时按域名精确匹配 */
export function presetForUrl(baseUrl: string): ProviderPreset | undefined {
  const h = hostOf(baseUrl)
  if (!h) return undefined
  return (
    PROVIDER_PRESETS.find((p) => hostOf(p.baseUrl) === h) ??
    PROVIDER_PRESETS.find((p) => p.family !== 'other' && p.family === familyOf(baseUrl))
  )
}

/** 哪些服务商支持「思考模式」开关（其余家只能用默认行为） */
export function supportsThinkingToggle(family: ProviderFamily): boolean {
  return ['deepseek', 'moonshot', 'gemini', 'openai', 'dashscope', 'zhipu', 'ark'].includes(family)
}

const SAMPLING = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']

function isOpenAIReasoning(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model)
}

/** Kimi K2.5+ / K3：采样参数固定，传了就 400 */
function isKimiFixedSampling(model: string): boolean {
  return /^kimi-k(3|2\.([5-9]|\d{2,}))/i.test(model)
}

/**
 * 在已组好的 OpenAI 格式请求体上套用服务商规则：删掉不认的参数、截短 stop、
 * 换 max_tokens 字段名、加思考开关。`learned` 是自愈学到的要删的参数。
 * 就地修改并返回同一个对象。
 */
export function applyCompat(
  body: Record<string, unknown>,
  ctx: { baseUrl: string; model: string; stream: boolean; thinking?: ProviderConfig['thinking'] },
  learned?: ReadonlySet<string>,
): Record<string, unknown> {
  const family = familyOf(ctx.baseUrl)
  const drop = new Set<string>(learned ?? [])
  let maxStop: number | undefined

  switch (family) {
    case 'moonshot':
      if (isKimiFixedSampling(ctx.model)) SAMPLING.forEach((k) => drop.add(k))
      break
    case 'gemini':
      maxStop = 5
      drop.add('frequency_penalty')
      drop.add('presence_penalty')
      break
    case 'openai':
      maxStop = 4
      if (isOpenAIReasoning(ctx.model)) {
        SAMPLING.forEach((k) => drop.add(k))
        if (body['max_tokens'] != null && !drop.has('max_completion_tokens')) {
          body['max_completion_tokens'] = body['max_tokens']
          delete body['max_tokens']
        }
      }
      break
  }

  // ── 思考开关 ──
  const t = ctx.thinking
  switch (family) {
    case 'deepseek':
    case 'moonshot':
    case 'zhipu':
    case 'ark':
      if (t) body['thinking'] = { type: t === 'on' ? 'enabled' : 'disabled' }
      break
    case 'dashscope':
      if (t) body['enable_thinking'] = t === 'on'
      // Qwen3 非流式不显式关闭会直接报错（思考只允许在流式下输出）
      else if (!ctx.stream) body['enable_thinking'] = false
      break
    case 'gemini':
      if (t) body['reasoning_effort'] = t === 'on' ? 'high' : 'none'
      break
    case 'openai':
      if (t && isOpenAIReasoning(ctx.model))
        body['reasoning_effort'] = t === 'on' ? 'high' : 'minimal'
      break
  }

  // 学到的「max_tokens 不认」→ 换成 max_completion_tokens
  if (drop.has('max_tokens') && body['max_tokens'] != null) {
    body['max_completion_tokens'] = body['max_tokens']
  }
  for (const k of drop) delete body[k]

  // 截短 stop：调用方把用户自己配的停止词放在前面，演绎自动加的在后面，所以截尾
  const stop = body['stop']
  if (maxStop != null && Array.isArray(stop) && stop.length > maxStop) {
    body['stop'] = stop.slice(0, maxStop)
  }
  if (Array.isArray(body['stop']) && !(body['stop'] as unknown[]).length) delete body['stop']
  return body
}

/** 自愈能处理的参数；错误信息里出现这些名字才会去掉重试 */
const HEALABLE: { key: string; match: RegExp }[] = [
  { key: 'stream_options', match: /stream_options|include_usage/ },
  { key: 'prompt_cache_key', match: /prompt_cache_key/ },
  { key: 'temperature', match: /temperature/ },
  { key: 'top_p', match: /top_p|topp/ },
  { key: 'frequency_penalty', match: /frequency_penalty|frequencypenalty/ },
  { key: 'presence_penalty', match: /presence_penalty|presencepenalty/ },
  { key: 'stop', match: /\bstop\b|stop_sequences|stopsequences/ },
  { key: 'thinking', match: /thinking/ },
  { key: 'enable_thinking', match: /enable_thinking/ },
  { key: 'reasoning_effort', match: /reasoning_effort|reasoning effort/ },
  { key: 'max_tokens', match: /max_completion_tokens/ },
]

/**
 * 从 400/422 的错误信息里推断该去掉哪些参数。只返回**请求体里确实有**的那些。
 *
 * 什么都没点名、但带了 `stream_options` 时，把它当作嫌疑人：少数老网关对未知参数
 * 一律回一句不带参数名的 400，而 stream_options 是我们唯一主动加的「非必需」参数。
 */
export function paramsToHeal(detail: string, body: Record<string, unknown>): string[] {
  const d = detail.toLowerCase()
  const hits = HEALABLE.filter((h) => h.match.test(d) && body[h.key] !== undefined).map(
    (h) => h.key,
  )
  // `enable_thinking` 的报错里也有 thinking 字样，别误伤不存在的 thinking 字段（上面已按 body 过滤）
  if (!hits.length && body['stream_options'] !== undefined) return ['stream_options']
  return [...new Set(hits)]
}

/** 模型列表的 id 规范化：Gemini 兼容层返回 `models/gemini-…`，去掉前缀才能直接用 */
export function normalizeModelId(baseUrl: string, id: string): string {
  return familyOf(baseUrl) === 'gemini' ? id.replace(/^models\//, '') : id
}
