/**
 * 模型下载的「代发」通道：Worker 里的 transformers.js 把请求交给主线程，由主线程走 `send()` 发出。
 *
 * ## 为什么需要（安卓 App 里嵌入 / 深度模型下不动的根因）
 * hf-mirror 对浏览器请求有两道墙，开发期靠 vite 的 `/hf` 同源代理绕过（见 downloadHost.ts），
 * 而打包后没有这个代理，WebView 从 `http://tauri.localhost` 直连镜像：
 *  1. **防盗链**：浏览器请求必带外站 `Referer`，镜像对它回「未授权访问」的 HTML 页，**状态码 200**
 *     （实测：只有 Referer 触发，Origin / UA 不触发）—— tfEnv 的 guardHtml 拦下后报「返回了 HTML」；
 *  2. **CORS**：镜像的 `Access-Control-Allow-Origin` 写死为 `https://hf-mirror.com`，
 *     跨源读取响应直接被 WebView 拦掉。
 * 原生壳里 `send()` 走 plugin-http（Rust reqwest）：没有同源策略、默认不带 Referer，两道墙都不存在，
 * 权重文件 302 到 xethub CDN 的跳转也由 reqwest 跟完。
 *
 * ## 为什么要绕主线程
 * 下载发生在 Worker 里（transformers 只在 Worker 里跑），而 plugin-http 靠
 * `window.__TAURI_INTERNALS__` 调 Rust —— **Worker 里没有这个全局**，直接用不了。
 * 所以 Worker 只负责把请求描述发过来；主线程发请求，把 `Response.body`（ReadableStream）
 * **转移**回 Worker（可转移流，Chrome 87+），权重边下边流过去，不在主线程攒一整块几十 MB。
 *
 * ## 用法
 * 主线程：建 Worker 后立刻 `attachFetchRelay(worker)`（Web 端是空操作）。
 * Worker：tfEnv 在模块加载时收下通道，有通道就把 `env.fetch` 换成 `relayFetch`。
 * 通道用独立的 MessageChannel，不混进各 Worker 自己的消息协议。
 */

import { isTauri } from '../platform/env'
import { send } from '../provider/http'

/** 主线程 → Worker：递交通道端口的那条消息 */
export const RELAY_HANDSHAKE = '__fetchRelay'

export interface RelayRequest {
  id: number
  url: string
  method: string
  headers: Record<string, string>
}

export type RelayReply =
  | {
      id: number
      ok: true
      status: number
      statusText: string
      headers: [string, string][]
      /** 优先转移流；旧 WebView 不支持可转移流时退化为整块 */
      body?: ReadableStream<Uint8Array> | null
      buf?: ArrayBuffer
    }
  | { id: number; ok: false; message: string }

/** 主线程：给 Worker 接上代发通道。只在原生壳里生效（浏览器里 fetch 本来就能用 / 走 vite 代理） */
export function attachFetchRelay(worker: Worker): void {
  if (!isTauri) return
  const ch = new MessageChannel()
  const port = ch.port1
  port.onmessage = async (ev: MessageEvent<RelayRequest>) => {
    const { id, url, method, headers } = ev.data
    try {
      const res = await send({ url, method, headers })
      const head = {
        id,
        ok: true as const,
        status: res.status,
        statusText: res.statusText,
        headers: [...res.headers.entries()],
      }
      if (res.body) {
        try {
          port.postMessage({ ...head, body: res.body } satisfies RelayReply, [res.body])
          return
        } catch {
          // 流不可转移（DataCloneError）：postMessage 在发出前同步抛错，流未被消费，下面整块读
        }
      }
      const buf = await res.arrayBuffer()
      port.postMessage({ ...head, buf } satisfies RelayReply, [buf])
    } catch (e) {
      port.postMessage({
        id,
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      } satisfies RelayReply)
    }
  }
  worker.postMessage({ type: RELAY_HANDSHAKE, port: ch.port2 }, [ch.port2])
}
