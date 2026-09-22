/**
 * OpenAI 兼容客户端。可对接 OpenAI / DeepSeek / 硅基流动 / OneAPI / Ollama 等
 * 一切实现了 `/chat/completions` 的服务。
 */

import { buildHeaders, resolveUrl, send } from './http'
import { parseSSE, toProviderError } from './stream'
import { armStall, type StallGuard } from './timeout'
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

/** 流式：相邻两个字节之间的最长空窗。沿用 depth/generate.ts 的 STALL_MS 量级 */
const STREAM_IDLE_MS = 90_000
/**
 * 流式：第一个字节之前的宽限，**刻意比 IDLE 宽得多**。
 *
 * ⚠️ 代理是本项目的一等公民（见 http.ts 的 proxyPrefix）。而 nginx 默认
 * `proxy_buffering on` 会把整条 SSE 缓冲到结束才吐 —— 在客户端看来「第一个
 * 字节」和「最后一个字节」是同一刻。按 90 秒判死会把这类部署下**全部**正常
 * 生成误杀，还报「超时」，排查方向完全错。
 */
const STREAM_FIRST_MS = 5 * 60_000
/** 非流式：没有任何进展信号，这里的停滞守卫退化成硬截止线 */
const ONCE_TIMEOUT_MS = 5 * 60_000
/** 拉模型列表：一次元数据 GET，对齐 vector/manager.ts 的 CHECK_TIMEOUT */
const MODELS_TIMEOUT_MS = 30_000

/**
 * abort 有两种来源，而 DOMException 里没有任何线索能区分它们
 * （fetch 与 reader.read() 抛的都是同一个 AbortError）。唯一权威是守卫那面旗。
 */
function wrapAbortable(e: unknown, guard: StallGuard, ms: number): ProviderError {
  if (guard.stalled) {
    return new ProviderError(
      'timeout',
      `生成超时：已有 ${Math.round(ms / 1000)} 秒没有收到新内容，请检查网络或模型服务`,
    )
  }
  return wrapFetchError(e)
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
    `无法连接到接口：${msg}。若是浏览器跨域限制，请在模型管理中编辑服务的代理地址。`,
  )
}

/** 流式聊天补全 */
export async function* streamChat(
  cfg: ProviderConfig,
  req: ChatCompletionRequest,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const url = resolveUrl(cfg.baseUrl, '/chat/completions', cfg.proxyPrefix)
  const guard = armStall({
    idleMs: STREAM_IDLE_MS,
    firstMs: STREAM_FIRST_MS,
    ...(signal ? { signal } : {}),
  })
  try {
    let res: Response
    try {
      res = await send({
        url,
        method: 'POST',
        headers: buildHeaders(cfg.apiKey ?? '', cfg.headers),
        body: bodyOf({ ...req, stream: true }),
        signal: guard.signal,
      })
    } catch (e) {
      throw wrapAbortable(e, guard, STREAM_FIRST_MS)
    }
    if (!res.ok) throw await toProviderError(res)
    // 响应头到了就是进展，从这里起换成 idle 档
    guard.kick()
    // ⚠️ 读流也必须包起来。中断绝大多数发生在**这里**而不是上面的 fetch：
    // 头一到就开始出字，用户看着字往外蹦才会去按「停止」，此时 abort 是从
    // reader.read() 抛出裸 DOMException。不翻译的话 generation 那边
    // `err.kind === 'aborted'` 为 false，主动中断会被当成生成失败 ——
    // 弹一条英文 DOMException 红字，还告诉用户「模型服务不可用」。
    try {
      yield* parseSSE(res, guard.kick)
    } catch (e) {
      throw wrapAbortable(e, guard, STREAM_IDLE_MS)
    }
  } finally {
    // 生成器可能被消费方提前 return/break 掐断，没有这个 finally 就漏一个定时器
    guard.dispose()
  }
}

/**
 * 非流式聊天补全。
 *
 * @param timeoutMs 硬截止线。非流式**没有任何进展信号**（要么没响应、要么
 *   一次性拿到全文），所以停滞守卫在这里退化成总时限，不做续期。
 *   默认 5 分钟：最慢的调用方是会话记忆提炼（maxTokens 1536 + 思维链），
 *   按 5 tok/s 算也要 ~300 秒才算正常。
 */
export async function chatOnce(
  cfg: ProviderConfig,
  req: ChatCompletionRequest,
  signal?: AbortSignal,
  timeoutMs = ONCE_TIMEOUT_MS,
): Promise<string> {
  const url = resolveUrl(cfg.baseUrl, '/chat/completions', cfg.proxyPrefix)
  const guard = armStall({ idleMs: timeoutMs, ...(signal ? { signal } : {}) })
  try {
    let res: Response
    try {
      res = await send({
        url,
        method: 'POST',
        headers: buildHeaders(cfg.apiKey ?? '', cfg.headers),
        body: bodyOf({ ...req, stream: false }),
        signal: guard.signal,
      })
    } catch (e) {
      throw wrapAbortable(e, guard, timeoutMs)
    }
    if (!res.ok) throw await toProviderError(res)
    // 同 streamChat：读 body 期间中断，抛的也是裸 DOMException。
    // 这里**刻意不 kick**：拿到响应头就续期的话最坏情况翻倍成 10 分钟，
    // 而我们要消灭的正是「有界但极长」的假死
    let j: { choices?: { message?: { content?: string } }[] }
    try {
      j = (await res.json()) as typeof j
    } catch (e) {
      throw wrapAbortable(e, guard, timeoutMs)
    }
    return j.choices?.[0]?.message?.content ?? ''
  } finally {
    guard.dispose()
  }
}

/** 返回可用的接口根地址，供编辑器保存，后续生成请求也使用同一路径。 */
export async function listModels(
  cfg: ProviderConfig,
  signal?: AbortSignal,
): Promise<{ models: ModelInfo[]; baseUrl: string }> {
  const baseUrl = cfg.baseUrl.trim().replace(/\/+$/, '')
  // 传输层统一提供超时保护，也支持调用方取消。
  const guard = armStall({ idleMs: MODELS_TIMEOUT_MS, ...(signal ? { signal } : {}) })
  try {
    try {
      const models = await fetchModels(resolveUrl(baseUrl, '/models', cfg.proxyPrefix), cfg, guard)
      return { models, baseUrl }
    } catch (error) {
      // 只对裸域名尝试 /v1；显式配置的路径、鉴权失败和网络错误不做猜测。
      const parsed = new URL(baseUrl)
      const canRetry =
        !guard.signal.aborted &&
        parsed.pathname === '/' &&
        !parsed.search &&
        !parsed.hash &&
        error instanceof ProviderError &&
        (error.kind === 'parse' || error.status === 404 || error.status === 405)
      if (!canRetry) throw error
      const versioned = `${baseUrl}/v1`
      const models = await fetchModels(
        resolveUrl(versioned, '/models', cfg.proxyPrefix),
        cfg,
        guard,
      )
      return { models, baseUrl: versioned }
    }
  } finally {
    guard.dispose()
  }
}

async function fetchModels(
  url: string,
  cfg: ProviderConfig,
  guard: StallGuard,
): Promise<ModelInfo[]> {
  let res: Response
  try {
    res = await send({
      url,
      method: 'GET',
      headers: buildHeaders(cfg.apiKey ?? '', cfg.headers),
      signal: guard.signal,
    })
  } catch (e) {
    throw wrapAbortable(e, guard, MODELS_TIMEOUT_MS)
  }
  if (!res.ok) throw await toProviderError(res)
  let raw: string
  try {
    raw = await res.text()
  } catch (e) {
    throw wrapAbortable(e, guard, MODELS_TIMEOUT_MS)
  }
  let j: { data?: unknown; error?: { message?: string } } | null
  try {
    j = JSON.parse(raw) as typeof j
  } catch {
    throw new ProviderError(
      'parse',
      raw.trimStart().startsWith('<')
        ? '模型列表接口返回了网页，请检查接口地址是否缺少 /v1'
        : '模型列表接口返回了无效 JSON，请检查接口地址',
    )
  }
  if (j?.error) throw new ProviderError('server', j.error.message || '模型列表接口返回错误')
  if (!Array.isArray(j?.data)) {
    throw new ProviderError('parse', '接口未返回模型列表（data 数组），请检查接口地址')
  }
  const ids = j.data
    .map((m: unknown) => (m && typeof m === 'object' && 'id' in m ? m.id : undefined))
    .filter((id): id is string => typeof id === 'string' && !!id.trim())
  return [...new Set(ids)].sort().map((id) => ({ id }))
}
