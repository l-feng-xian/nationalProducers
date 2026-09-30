/**
 * SSE 解析。手写而非用 EventSource —— EventSource 不支持 POST 与自定义头。
 *
 * 关键点：跨 chunk 的半行必须缓冲。网络包边界会把 `data: {"cho` 和 `ices":...}`
 * 切成两次 read，不缓冲就会 JSON.parse 失败并丢字。
 */

import { ProviderError, type StreamChunk, type Usage } from '@/types/provider'

interface DeltaShape {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null }
    message?: { content?: string | null }
    finish_reason?: string | null
  }[]
  usage?: unknown
  error?: { message?: string; type?: string }
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

/**
 * 把各家的 usage 字段统一成 `Usage`。不是对象或连 prompt_tokens 都没有时返回 undefined。
 * 字段对照见 types/provider.ts 的 `Usage` 注释。
 */
export function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const u = raw as Record<string, unknown>
  const prompt = num(u['prompt_tokens'])
  if (prompt === undefined) return undefined
  const details = u['prompt_tokens_details']
  const cached =
    num(u['prompt_cache_hit_tokens']) ??
    (details && typeof details === 'object'
      ? num((details as Record<string, unknown>)['cached_tokens'])
      : undefined) ??
    num(u['cached_tokens'])
  return {
    prompt,
    completion: num(u['completion_tokens']) ?? 0,
    ...(cached !== undefined ? { cached } : {}),
  }
}

/**
 * 把 Response 的 SSE 流解析成一系列 StreamChunk。
 *
 * @param onBytes 每读到一批**字节**就回调一次，用于给停滞守卫续期。
 *   ⚠️ 必须按字节而不是按 yield 出去的 chunk 算「有进展」：很多网关用 SSE
 *   注释（`: ping`）做保活，那种行在下面被 `startsWith(':')` 跳过、一个 chunk
 *   都不 yield；按 chunk 判活的话，一条只发心跳的**健康**连接会被当成卡死掐掉。
 */
export async function* parseSSE(res: Response, onBytes?: () => void): AsyncGenerator<StreamChunk> {
  const body = res.body
  if (!body) throw new ProviderError('parse', '响应没有 body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onBytes?.()
      buf += decoder.decode(value, { stream: true })

      // SSE 事件以空行分隔；保留最后一段不完整的
      let idx: number
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '')
        buf = buf.slice(idx + 1)
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return

        let json: DeltaShape
        try {
          json = JSON.parse(data) as DeltaShape
        } catch {
          continue // 半行或心跳，跳过
        }
        if (json.error) {
          throw new ProviderError('server', json.error.message ?? '服务端返回错误')
        }
        // 用量块：OpenAI 在 choices 为空的最后一帧里给；有的实现夹在最后一个内容帧里。
        // 两种都单独 yield 一个空 delta 的 chunk，消费方只需看 chunk.usage
        const usage = normalizeUsage(json.usage)
        if (usage) yield { delta: '', usage }
        const choice = json.choices?.[0]
        if (!choice) continue
        const delta = choice.delta?.content ?? choice.message?.content ?? ''
        const reasoning = choice.delta?.reasoning_content ?? ''
        const finish = choice.finish_reason ?? undefined
        if (delta || reasoning || finish) {
          const chunk: StreamChunk = { delta: delta ?? '' }
          if (reasoning) chunk.reasoningDelta = reasoning
          if (finish) chunk.finishReason = finish
          yield chunk
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 已释放
    }
  }
}

/** 把 HTTP 状态码归类成可读错误 */
export async function toProviderError(res: Response): Promise<ProviderError> {
  let detail = ''
  try {
    detail = await res.text()
  } catch {
    detail = ''
  }
  let msg = detail
  try {
    const j = JSON.parse(detail) as { error?: { message?: string } }
    if (j.error?.message) msg = j.error.message
  } catch {
    // 非 JSON，用原文
  }
  const short = msg.slice(0, 400)
  if (res.status === 401 || res.status === 403) {
    return new ProviderError('auth', `鉴权失败（${res.status}）：请检查 API Key`, res.status, short)
  }
  if (res.status === 429) {
    return new ProviderError('rate_limit', '请求过于频繁或额度不足（429）', res.status, short)
  }
  if (res.status === 400 || res.status === 404 || res.status === 422) {
    return new ProviderError(
      'bad_request',
      `请求被拒绝（${res.status}）：${short || '请检查模型名与 baseURL'}`,
      res.status,
      short,
    )
  }
  if (res.status >= 500) {
    return new ProviderError('server', `服务端错误（${res.status}）`, res.status, short)
  }
  return new ProviderError('unknown', `请求失败（${res.status}）`, res.status, short)
}
