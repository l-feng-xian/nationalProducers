/**
 * 代理地址解析。
 *
 * 浏览器直连大多数 AI 接口会碰 CORS（OpenAI 官方、Ollama 默认都拒绝）。
 * 策略：
 *   - proxyPrefix 为空 → 直连 baseUrl（DeepSeek、硅基流动等允许跨域的服务可用）
 *   - proxyPrefix 非空 → 用它替换掉 baseUrl 的 origin
 *     开发期填 `/llm` 走 vite.config.ts 的 server.proxy；
 *     生产期填自备反向代理地址。
 *
 * ⚠️ 原生壳（Tauri）里不受这套约束：请求由 `send()` 交给 Rust 发出，没有 CORS 问题，
 * `proxyPrefix` 留空即可直连。
 */

import { isTauri } from '../platform/env'

export function resolveUrl(baseUrl: string, path: string, proxyPrefix?: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  if (!proxyPrefix) return `${base}${p}`

  const prefix = proxyPrefix.replace(/\/+$/, '')
  try {
    const u = new URL(base)
    // 保留 baseUrl 的 pathname（例如 /v1），只把 origin 换成代理前缀
    return `${prefix}${u.pathname.replace(/\/+$/, '')}${p}`
  } catch {
    // baseUrl 本身就是相对路径
    return `${prefix}${base}${p}`
  }
}

export function buildHeaders(
  apiKey: string,
  extra?: Record<string, string>,
): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
  return { ...h, ...(extra ?? {}) }
}

/**
 * 全项目唯一的出网口。**所有打到第三方接口的请求都必须走这里**，不要再散写 fetch。
 *
 * 为什么要这一层：打包成原生壳之后 webview 跑在 Tauri 自定义协议上，直连
 * AI 接口会被 CORS 拦死 —— 而这些请求带 `Content-Type: application/json` +
 * `Authorization`，**一律触发预检**，没有"简单请求"可以侥幸绕过。Tauri 下改用
 * plugin-http：请求实际由 Rust 的 reqwest 发出，根本不经过 webview 的同源策略。
 *
 * 顺带的两个好处：
 *  - 不再需要用户自备反向代理（`proxyPrefix` 在原生壳里依然可用，但不再是必需品）；
 *  - reqwest 走原生 socket，不受安卓 `network_security_config` 约束，
 *    所以局域网里 `http://192.168.x.x:11434` 这类明文端点照样连得上。
 *
 * 返回的是标准 `Response`，`.body` 是可读流 —— 下游的 `parseSSE` 与
 * `toProviderError` 一个字都不用改。
 */
export async function send(spec: RequestInit & { url: string }): Promise<Response> {
  const { url, ...init } = spec
  if (!isTauri) return fetch(url, init)
  // 动态 import：Web 构建里这个插件不该被打进包
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  return tauriFetch(url, init)
}
