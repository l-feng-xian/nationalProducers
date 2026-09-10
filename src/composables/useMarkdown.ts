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

export function renderMarkdown(src: string): string {
  if (!src) return ''
  return DOMPurify.sanitize(md.render(src), { USE_PROFILES: { html: true } })
}

export function useMarkdown() {
  return { renderMarkdown }
}
