/**
 * 清掉 transformers 模型缓存里「HTML 冒充模型文件」的毒条目。
 *
 * 为什么会有毒条目：transformers.js 写缓存**只看状态码**（hub.js 里
 * `response.status !== 200` 之外一律进 Cache Storage），**从不校验 content-type**。
 * 而 SPA 托管（vite dev / preview / Netlify…）对未知路径的回落是 **200 + index.html**，
 * 不是 404。所以只要下载源一时不通（最典型：同源代理 `/hf` 还没生效、改完
 * vite.config.ts 没重启 dev server），拿回来的 index.html 就会被当成权重写进缓存。
 *
 * 之后的致命之处在于**缓存命中会短路掉网络**：代理修好了也没用，每次加载都先
 * 命中那条 HTML，报错永远是 `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`，
 * 且完全看不出跟代理/下载源有关。历史上只能手动清整个 Cache Storage 才能恢复。
 *
 * 这里按 content-type 精确挑出这些条目删掉（缓存写入时 `new Headers(response.headers)`
 * 原样留了 content-type，所以判得准），**不碰正常的权重条目**——不会误删已下好的模型。
 *
 * 配套的另一半在 tfEnv.ts：那边包了 env.fetch，让 HTML 压根进不了缓存。
 * 这个模块负责**修好已经中毒的浏览器**。
 *
 * 纯 service：不 import vue/pinia。
 */

/** transformers.js 的 Cache Storage 名（其 env.cacheKey 默认值）。 */
const CACHE_NAME = 'transformers-cache'

/** 只认 HTML；权重是 octet-stream、json 是 text/plain 或 application/json，都不会误伤。 */
function isHtml(ct: string | null | undefined): boolean {
  return /^\s*text\/html/i.test(ct ?? '')
}

/**
 * 删除所有「内容是 HTML」的缓存条目，返回删掉的条数。
 *
 * 全程 try/catch 吞异常并返回 0：这是一条**自愈旁路**，缓存不可用（无痕模式、
 * 禁用站点数据）时它必须安静地什么都不做，绝不能把模型管理页自己搞挂。
 */
export async function purgeHtmlPoison(): Promise<number> {
  try {
    if (typeof caches === 'undefined') return 0
    if (!(await caches.has(CACHE_NAME))) return 0
    const cache = await caches.open(CACHE_NAME)
    const keys = await cache.keys()
    let removed = 0
    for (const req of keys) {
      // 只读 header 不读 body：条目可能是上百 MB 的权重，碰 body 会白白解压一遍
      const res = await cache.match(req)
      if (!isHtml(res?.headers.get('content-type'))) continue
      if (await cache.delete(req)) removed++
    }
    return removed
  } catch {
    return 0
  }
}
