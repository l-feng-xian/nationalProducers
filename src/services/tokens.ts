/**
 * 启发式 token 估算，不引 tokenizer 依赖。
 * CJK 字符 ≈ 1 token/字；其余 ≈ 1 token/4 字符。
 *
 * 复用自 sillyTavernTauri/src/services/tokens.ts。
 * 精度与真 tokenizer 差 10-30%，用于预算/截断决策足够；
 * 若将来要更精确，只需替换 TokenCounter 的实现，调用方不变。
 */

/** 平假名/片假名、CJK 扩展A、CJK 统一、CJK 兼容、半角片假名、谚文 */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ가-힯]/g

export type TokenCounter = (text: string) => number

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  const rest = text.length - cjk
  return Math.ceil(cjk + rest / 4)
}

export function estimateMessagesTokens(parts: { content: string }[], perMessage = 0): number {
  return parts.reduce((sum, p) => sum + estimateTokens(p.content) + perMessage, 0)
}

export function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
