/**
 * OpenAI 兼容客户端。可对接 OpenAI / DeepSeek / 硅基流动 / OneAPI / Ollama 等
 * 一切实现了 `/chat/completions` 的服务。
 */

import { buildHeaders, resolveUrl } from './http'
import { parseSSE, toProviderError } from './stream'
import {
  ProviderError,
  type ChatCompletionRequest,
  type ModelInfo,
  type ProviderConfig,
  type StreamChunk,
} from '@/types/provider'

function bodyOf(req: ChatCompletionRequest): string {
  const b: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
    stream: req.stream,
  }
  if (req.maxTokens != null) b['max_tokens'] = req.maxTokens
  if (req.temperature != null) b['temperature'] = req.temperature
  if (req.topP != null) b['top_p'] = req.topP
  if (req.frequencyPenalty != null) b['frequency_penalty'] = req.frequencyPenalty
  if (req.presencePenalty != null) b['presence_penalty'] = req.presencePenalty
  if (req.stop?.length) b['stop'] = req.stop
  return JSON.stringify(b)
}

/** 把 fetch 层的异常翻译成可读错误。浏览器把 CORS 失败也报成 TypeError */
function wrapFetchError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e
  if (e instanceof DOMException && e.name === 'AbortError') {
    return new ProviderError('aborted', '已中断')
  }
  const msg = e instanceof Error ? e.message : String(e)
  return new ProviderError(
    'cors',
    `无法连接到接口：${msg}。若是浏览器跨域限制，请在设置里填写代理地址。`,
  )
}

/** 流式聊天补全 */
export async function* streamChat(
  cfg: ProviderConfig,
  req: ChatCompletionRequest,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const url = resolveUrl(cfg.baseUrl, '/chat/completions', cfg.proxyPrefix)
  let res: Response
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: buildHeaders(cfg.apiKey ?? '', cfg.headers),
      body: bodyOf({ ...req, stream: true }),
    }
    if (signal) init.signal = signal
    res = await fetch(url, init)
  } catch (e) {
    throw wrapFetchError(e)
  }
  if (!res.ok) throw await toProviderError(res)
  yield* parseSSE(res)
}

/** 非流式聊天补全 */
export async function chatOnce(
  cfg: ProviderConfig,
  req: ChatCompletionRequest,
  signal?: AbortSignal,
): Promise<string> {
  const url = resolveUrl(cfg.baseUrl, '/chat/completions', cfg.proxyPrefix)
  let res: Response
  try {
    const init: RequestInit = {
      method: 'POST',
      headers: buildHeaders(cfg.apiKey ?? '', cfg.headers),
      body: bodyOf({ ...req, stream: false }),
    }
    if (signal) init.signal = signal
    res = await fetch(url, init)
  } catch (e) {
    throw wrapFetchError(e)
  }
  if (!res.ok) throw await toProviderError(res)
  const j = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  return j.choices?.[0]?.message?.content ?? ''
}

/** 拉取模型列表，用于设置页下拉 */
export async function listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<ModelInfo[]> {
  const url = resolveUrl(cfg.baseUrl, '/models', cfg.proxyPrefix)
  let res: Response
  try {
    const init: RequestInit = {
      method: 'GET',
      headers: buildHeaders(cfg.apiKey ?? '', cfg.headers),
    }
    if (signal) init.signal = signal
    res = await fetch(url, init)
  } catch (e) {
    throw wrapFetchError(e)
  }
  if (!res.ok) throw await toProviderError(res)
  const j = (await res.json()) as { data?: { id?: string }[] }
  return (j.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string')
    .sort()
    .map((id) => ({ id }))
}
