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
}

export interface ProviderConfig {
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
  /** 非空时替换 baseUrl 的 origin，用于绕过 CORS */
  proxyPrefix?: string
}

export interface StreamChunk {
  delta: string
  reasoningDelta?: string
  finishReason?: string
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
