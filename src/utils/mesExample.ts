/**
 * 对话示例（mes_example）的**可视化编辑**支持：`<START>` 分块 ⇄ 结构化轮次。
 *
 * 目的：用户不必手写 `<START>` 与 `{{user}}:` 前缀。
 * 无法解析成轮次的块（比如自由散文）降级为 raw，原样保留、不丢内容。
 */

export interface ExampleTurn {
  who: 'user' | 'char'
  text: string
}

export interface ExampleBlock {
  /** 结构化轮次；raw 非空时忽略 */
  turns: ExampleTurn[]
  /** 无法解析时的原文兜底 */
  raw?: string
}

const USER_TOKEN = '{{user}}'
const CHAR_TOKEN = '{{char}}'

/** mes_example 原文 → 块数组 */
export function parseExampleBlocks(src: string): ExampleBlock[] {
  if (!src || !src.trim()) return []
  let s = src
  if (!/^\s*<START>/i.test(s)) s = `<START>\n${s.trim()}`
  const rawBlocks = s
    .split(/<START>/gi)
    .slice(1)
    .map((b) => b.trim())
    .filter((b) => b !== '')

  return rawBlocks.map((block) => {
    const turns: ExampleTurn[] = []
    let ok = true
    let cur: ExampleTurn | null = null

    for (const line of block.split('\n')) {
      const u = matchPrefix(line, USER_TOKEN)
      const c = matchPrefix(line, CHAR_TOKEN)
      if (u !== null) {
        if (cur) turns.push(cur)
        cur = { who: 'user', text: u }
      } else if (c !== null) {
        if (cur) turns.push(cur)
        cur = { who: 'char', text: c }
      } else if (cur) {
        // 续行
        cur.text += `\n${line}`
      } else if (line.trim()) {
        // 首行就不是已知前缀 → 整块降级
        ok = false
        break
      }
    }
    if (cur) turns.push(cur)
    if (!ok || !turns.length) return { turns: [], raw: block }
    return { turns: turns.map((t) => ({ ...t, text: t.text.trim() })) }
  })
}

function matchPrefix(line: string, token: string): string | null {
  const re = new RegExp(`^\\s*${token.replace(/[{}]/g, '\\$&')}\\s*:\\s*`, 'i')
  const m = line.match(re)
  return m ? line.slice(m[0].length) : null
}

/** 块数组 → mes_example 原文 */
export function serializeExampleBlocks(blocks: ExampleBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.raw !== undefined && b.raw.trim()) {
      parts.push(`<START>\n${b.raw.trim()}`)
      continue
    }
    const lines = b.turns
      .filter((t) => t.text.trim())
      .map((t) => `${t.who === 'user' ? USER_TOKEN : CHAR_TOKEN}: ${t.text.trim()}`)
    if (lines.length) parts.push(`<START>\n${lines.join('\n')}`)
  }
  return parts.join('\n')
}

export function emptyExampleBlock(): ExampleBlock {
  return {
    turns: [
      { who: 'user', text: '' },
      { who: 'char', text: '' },
    ],
  }
}
