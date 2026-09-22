import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

/**
 * LLM 输出是不可信 HTML 源，必须过 DOMPurify —— 不要手搓 sanitizer。
 * html:false 已经关掉了原始 HTML，DOMPurify 是第二道防线。
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

/**
 * 渲染结果缓存。
 *
 * 没有它有两处都很贵：
 *  1. 流式期间每次刷新（默认 100ms）都拿**全量累积文本**重跑一遍 markdown-it +
 *     DOMPurify，单条消息累计是 O(n²)；
 *  2. 虚拟滚动之后，每次滚入都要把整条消息重新解析+消毒一次，而这发生在
 *     **滚动关键路径**上 —— 不缓存的话长会话快速滚动会比不虚拟化还卡。
 *
 * 用插入序 Map 当 LRU：命中就删了再塞回去，挤出时取 `keys().next()`（最老的那个）。
 *
 * 按**原文**做键，不按消息 id：函数只拿得到 src，而「同样的文本必然同样的结果」是
 * 这里唯一不会出错的等价关系。代价是流式期间每次刷新都是一个新前缀、进而是一次
 * miss（那一次本来也省不掉），会往缓存里塞几十条前缀——靠 LRU 挤掉，不会无限涨。
 */
const CACHE_MAX = 300
const cache = new Map<string, string>()

export function renderMarkdown(src: string): string {
  if (!src) return ''
  const hit = cache.get(src)
  if (hit !== undefined) {
    // 提到最新：Map 保持插入序，删了再塞就是「最近使用」
    cache.delete(src)
    cache.set(src, hit)
    return hit
  }
  const html = DOMPurify.sanitize(md.render(src), { USE_PROFILES: { html: true } })
  cache.set(src, html)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  return html
}

export function useMarkdown() {
  return { renderMarkdown }
}
