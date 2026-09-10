/**
 * 代理地址解析。
 *
 * 浏览器直连大多数 AI 接口会碰 CORS（OpenAI 官方、Ollama 默认都拒绝）。
 * 策略：
 *   - proxyPrefix 为空 → 直连 baseUrl（DeepSeek、硅基流动等允许跨域的服务可用）
 *   - proxyPrefix 非空 → 用它替换掉 baseUrl 的 origin
 *     开发期填 `/llm` 走 vite.config.ts 的 server.proxy；
 *     生产期填自备反向代理地址。
 */

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
