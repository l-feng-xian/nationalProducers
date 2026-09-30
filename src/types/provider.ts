/**
 * OpenAI 兼容 provider 的传输层类型。
 */

export type Role = 'system' | 'user' | 'assistant'

/** name 用于对话示例：example_user / example_assistant */
export interface ChatMessageParam {
  role: Role
  content: string
  name?: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessageParam[]
  stream: boolean
  maxTokens?: number
  temperature?: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  stop?: string[]
  /**
   * 前缀缓存路由键（OpenAI `prompt_cache_key`）。同一会话传同一个值，让请求落到
   * 已缓存该前缀的机器上。只对官方 OpenAI 发出，见 openaiCompatible.ts 的 bodyOf。
   */
  cacheKey?: string
}

/**
 * 一次调用的 token 用量。各家字段名不同，在 stream.ts 的 normalizeUsage 里统一：
 *  - OpenAI 及多数兼容接口：`usage.prompt_tokens_details.cached_tokens`
 *  - DeepSeek：`usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *  - Moonshot 等：`usage.cached_tokens`
 * `cached` 为 undefined 表示服务端没报，不等于 0（0 = 报了但没命中）。
 */
export interface Usage {
  prompt: number
  completion: number
  cached?: number
}

/** 思考模式：auto = 不传任何开关，用服务商默认行为 */
export type ThinkingMode = 'auto' | 'on' | 'off'

export interface ProviderConfig {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  /** 非空时替换 baseUrl 的 origin，用于绕过 CORS */
  proxyPrefix?: string
  /**
   * 显式开 / 关思考。缺省 = 不传（服务商默认）。
   * 不同家的参数名不同，由 services/provider/compat.ts 翻译。
   */
  thinking?: 'on' | 'off'
}

/** 服务配置里的思考模式 → ProviderConfig 字段（auto 不产生字段） */
export function thinkingField(mode: ThinkingMode | undefined): Pick<ProviderConfig, 'thinking'> {
  return mode === 'on' || mode === 'off' ? { thinking: mode } : {}
}

export interface StreamChunk {
  delta: string
  reasoningDelta?: string
  finishReason?: string
  /** 流末尾的用量块（需请求 `stream_options.include_usage`），通常与空 choices 一起到 */
  usage?: Usage
}

export interface ModelInfo {
  id: string
  contextLength?: number
}

export type ProviderErrorKind =
  | 'network'
  | 'cors'
  | 'auth'
  | 'rate_limit'
  | 'bad_request'
  | 'server'
  | 'aborted'
  /** 长时间没有任何响应，被停滞守卫掐掉。与 aborted 的区别是**用户没按停止** */
  | 'timeout'
  | 'parse'
  | 'unknown'

export class ProviderError extends Error {
  kind: ProviderErrorKind
  status?: number
  detail?: string

  constructor(kind: ProviderErrorKind, message: string, status?: number, detail?: string) {
    super(message)
    this.name = 'ProviderError'
    this.kind = kind
    this.status = status
    this.detail = detail
  }
}
