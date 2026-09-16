/**
 * 图像生成 API 客户端（yoshub / new-api 网关，OpenAI 兼容）。
 *
 * 实测事实，每一条都影响这里的实现：
 *
 * - 端点是 `POST {base}/v1/images/generations`（**不是** chat/completions，
 *   该站是纯图像中转，8 个模型全是图像模型）。
 * - `POST {base}/v1/images/edits` 存在且接受 `image[]` 多张参考图 —— 风格一致性
 *   靠参考图结构性锁定，不靠文字提示词碰运气。
 * - ⚠️ **未知参数被静默忽略并直接进入生成（照样计费）**。服务端不会帮你挡错字，
 *   所以这里必须自己做参数白名单。
 * - ⚠️ **`size` 不校验**，会向下吸附到 32 的倍数（999x999 → 992x992），而且照样计费。
 *   所以发出去前查白名单，收回来后验 IHDR。
 * - 输出 PNG 是 colortype 2（RGB，**无 alpha**）—— 洋红抠像是必须的，不是可选。
 * - `n` 最大 8（服务端会以 422 硬拦）。
 * - 单次生成 >25 秒；约 30% 的连接会以 UND_ERR_CONNECT_TIMEOUT 失败，
 *   **这类失败不计费**，重试即可。Node fetch 的 10s 连接超时不可配
 *   （undici 不是可 import 的包），所以只能靠重试而不是调参。
 */

import { Buffer } from 'node:buffer'

/** 服务端接受的参数白名单。⚠️ 白名单外的键一律丢弃 —— 服务端不会拦，只会照单计费 */
const ALLOWED_PARAMS = new Set(['model', 'prompt', 'size', 'n', 'quality', 'response_format'])

/** 已知可用的尺寸。flare 约 1MP，更大的要 2K 变体（而该变体实测 503 无通道） */
export const SIZE_WHITELIST = new Set([
  '1024x1024',
  '1408x704',
  '704x1408',
  '1216x832',
  '832x1216',
])

export const LIMITS = {
  requestTimeoutMs: 240_000,
  retries: 6,
  backoffMs: [1000, 2000, 5000, 10_000, 20_000, 30_000],
}

/** 抛出时带上「这次失败是否已经计费」，调用方据此决定重试还是止损 */
export class ImageApiError extends Error {
  constructor(message, { billed = false, retryable = false, status = 0, code = '' } = {}) {
    super(message)
    this.name = 'ImageApiError'
    this.billed = billed
    this.retryable = retryable
    this.status = status
    this.code = code
  }
}

/** 解析 PNG 的 IHDR。返回 null 表示这根本不是 PNG */
export function readPngHeader(buf) {
  if (buf.length < 33) return null
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) return null
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return null
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    // 2 = RGB 无 alpha（本 API 的实测输出）；6 = RGBA
    colorType: buf[25],
  }
}

function classify(status, body) {
  const code = body?.error?.code ?? ''
  const message = body?.error?.message ?? ''
  // 网关/上游临时不可用 —— 免费，值得重试
  if (status === 429 || status === 503) return { retryable: true, billed: false }
  if (/no available|upstream|temporarily/i.test(message)) return { retryable: true, billed: false }
  // 请求本身是坏的 —— 免费，但重试多少次都一样，直接止损
  if (status === 400 || status === 422) return { retryable: false, billed: false }
  if (code === 'convert_request_failed') return { retryable: false, billed: false }
  if (status >= 500) return { retryable: true, billed: false }
  return { retryable: false, billed: false }
}

/**
 * 账单查询。⚠️ 返回的是**分**，不是元。
 *
 * ⚠️ 必须自带重试：约 30% 的连接会以 UND_ERR_CONNECT_TIMEOUT 失败，
 * 而这个函数跑在生成**之前** —— 不重试的话，一次连接抖动就会让整轮
 * 生成还没开始就退出（实测踩过）。这类失败不计费，重试是免费的。
 */
export async function getUsageCents({ apiKey, baseUrl }) {
  let lastErr
  for (let attempt = 0; attempt <= 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000 * attempt))
    try {
      const res = await fetch(`${baseUrl}/v1/dashboard/billing/usage`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) {
        throw new ImageApiError(`billing 查询失败 HTTP ${res.status}`, { status: res.status })
      }
      const body = await res.json()
      return Number(body.total_usage ?? 0)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr ?? new ImageApiError('billing 查询重试耗尽')
}

async function postOnce({ apiKey, baseUrl, params, refs }) {
  const useEdits = refs && refs.length > 0
  const url = `${baseUrl}/v1/images/${useEdits ? 'edits' : 'generations'}`

  const clean = {}
  for (const [k, v] of Object.entries(params)) {
    if (ALLOWED_PARAMS.has(k) && v !== undefined && v !== null) clean[k] = v
  }

  const headers = { Authorization: `Bearer ${apiKey}` }
  let body

  if (useEdits) {
    const form = new FormData()
    for (const [k, v] of Object.entries(clean)) form.append(k, String(v))
    for (const ref of refs) {
      // 字段名用 `image[]`：实测数组式与重复式都能解析，数组式更明确
      form.append('image[]', new Blob([ref.bytes], { type: 'image/png' }), ref.name)
    }
    body = form
    // ⚠️ 不要手工设 Content-Type —— boundary 必须由 FormData 自己生成
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(clean)
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(LIMITS.requestTimeoutMs),
  })

  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }

  if (!res.ok) {
    const { retryable, billed } = classify(res.status, json)
    throw new ImageApiError(json?.error?.message ?? `HTTP ${res.status}: ${text.slice(0, 200)}`, {
      status: res.status,
      code: json?.error?.code ?? '',
      retryable,
      billed,
    })
  }

  const items = json?.data
  if (!Array.isArray(items) || items.length === 0) {
    // ⚠️ 200 但没有图 —— 这次**已经计费**了
    throw new ImageApiError('返回 200 但 data 为空', { billed: true, retryable: false })
  }

  return { json, items }
}

/**
 * 生成图像。成功时返回 { images: [{bytes, header}], revisedPrompt, attempts }。
 *
 * refs 非空则自动走 /v1/images/edits（带参考图），否则走 /v1/images/generations。
 */
export async function generateImage({ apiKey, baseUrl, model, prompt, size, n = 1, refs = [] }) {
  if (!SIZE_WHITELIST.has(size)) {
    throw new ImageApiError(
      `size "${size}" 不在白名单里。服务端不校验 size，会照单计费后返回吸附到 32 倍数的图 —— 这里主动拦下。\n` +
        `允许：${[...SIZE_WHITELIST].join(', ')}`,
      { retryable: false },
    )
  }
  if (!Number.isInteger(n) || n < 1 || n > 8) {
    throw new ImageApiError(`n 必须是 1..8 的整数，收到 ${n}`, { retryable: false })
  }

  const [wantW, wantH] = size.split('x').map(Number)
  let lastErr

  for (let attempt = 0; attempt <= LIMITS.retries; attempt++) {
    if (attempt > 0) {
      const wait = LIMITS.backoffMs[Math.min(attempt - 1, LIMITS.backoffMs.length - 1)]
      await new Promise((r) => setTimeout(r, wait))
    }
    try {
      const { json, items } = await postOnce({
        apiKey,
        baseUrl,
        params: { model, prompt, size, n },
        refs,
      })

      const images = items.map((it) => {
        const b64 = it.b64_json
        if (!b64) throw new ImageApiError('返回项里没有 b64_json', { billed: true })
        const bytes = Buffer.from(b64, 'base64')
        const header = readPngHeader(bytes)
        if (!header) throw new ImageApiError('返回的不是合法 PNG', { billed: true })
        return { bytes, header }
      })

      // ⚠️ 尺寸不符不重试：服务端不校验 size，重试只会再烧一次钱得到同样的结果
      const bad = images.find((im) => im.header.width !== wantW || im.header.height !== wantH)
      if (bad) {
        throw new ImageApiError(
          `请求 ${size} 但返回 ${bad.header.width}x${bad.header.height}（服务端把尺寸吸附到了 32 的倍数）`,
          { billed: true, retryable: false },
        )
      }

      return {
        images,
        revisedPrompt: items[0]?.revised_prompt ?? '',
        attempts: attempt + 1,
        raw: json,
      }
    } catch (err) {
      lastErr = err
      // 连接层失败（实测约 30% 概率）—— 免费，直接重试
      const cause = err?.cause?.code ?? ''
      const isConnect =
        cause.startsWith('UND_ERR') ||
        cause === 'ENOTFOUND' ||
        cause === 'ECONNRESET' ||
        err?.name === 'TimeoutError' ||
        /fetch failed/i.test(err?.message ?? '')
      if (isConnect) continue
      if (err instanceof ImageApiError && err.retryable) continue
      throw err
    }
  }
  throw lastErr ?? new ImageApiError('重试耗尽')
}
