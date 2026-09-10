/**
 * 宏引擎 —— 递归下降、内层优先。
 *
 * 相比 SillyTavern 的两套实现，这里刻意都不照搬：
 *  - legacy 的「有序正则数组」靠排序实现嵌套，是个陷阱（顺序稍错语义就变）；
 *  - 新引擎的 chevrotain 解析器有 150KB，本项目用不上那么多语法。
 *
 * 本实现约 120 行，语义要点：
 *  1. 扫到 `{{` 时配对 `}}`（跟踪嵌套），**先递归求值内层**，再把结果交给 handler；
 *  2. 未知宏原样保留（fail-open），handler 抛错也原样保留 —— 坏卡片绝不能中断生成；
 *  3. handler 的返回值**绝不再被扫描**，否则 {{setvar::a::{{getvar::a}}}} 会自我喂养成死循环；
 *  4. `findClosing` 找不到配对时原样输出剩余文本并跳出，不能死等。
 */

import { MACROS, type MacroCallCtx } from './registry'
import type { MacroEnv } from './env'

export function evaluateMacros(input: string, env: MacroEnv): string {
  if (!input) return ''
  const pre = preProcess(input)
  const walked = walk(pre, env, 0)
  return postProcess(walked)
}

/** 卡片字段专用：带递归护栏，并去掉 \r */
export function baseChatReplace(value: string, env: MacroEnv): string {
  if (!value) return ''
  return evaluateMacros(value, { ...env, replaceCharacterCard: false }).replace(/\r/g, '')
}

/** 老式尖括号标记与老式时区语法，兼容社区老角色卡 */
function preProcess(text: string): string {
  return text
    .replace(/\{\{time_(UTC[+-]\d+)\}\}/gi, (_m, off: string) => `{{time::${off}}}`)
    .replace(/<USER>/gi, '{{user}}')
    .replace(/<BOT>/gi, '{{char}}')
    .replace(/<CHAR>/gi, '{{char}}')
    .replace(/<GROUP>/gi, '{{group}}')
    .replace(/<CHARIFNOTGROUP>/gi, '{{group}}')
}

function postProcess(text: string): string {
  return (
    text
      // \{ -> {   \} -> }
      .replace(/\\([{}])/g, '$1')
      // {{trim}} 连同前后换行一起吃掉（handler 返回的是这个字面标记）
      .replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '')
  )
}

function walk(text: string, env: MacroEnv, baseOffset: number): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === undefined) break
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === '{' || next === '}') {
        out += ch + next
        i += 2
        continue
      }
      out += ch
      i++
      continue
    }
    if (ch === '{' && text[i + 1] === '{') {
      const end = findClosing(text, i)
      if (end === -1) {
        // 未闭合，原样输出剩余文本并跳出
        out += text.slice(i)
        break
      }
      const inner = text.slice(i + 2, end)
      // 内层优先
      const resolvedInner = walk(inner, env, baseOffset + i + 2)
      out += applyMacro(resolvedInner, env, baseOffset + i)
      i = end + 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 返回配对 `}}` 的第一个 `}` 的下标，找不到返回 -1 */
function findClosing(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++
      i++
      continue
    }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth--
      i++
      if (depth === 0) return i - 1
    }
  }
  return -1
}

const IDENT_RE = /^[A-Za-z][\w-]*$/

function splitMacro(inner: string): { name: string; args: string[] } | null {
  const trimmed = inner.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return { name: '//', args: [trimmed.slice(2)] }

  const dd = trimmed.indexOf('::')
  let head: string
  let rest: string
  if (dd !== -1) {
    head = trimmed.slice(0, dd)
    rest = trimmed.slice(dd + 2)
  } else {
    // 兼容老写法 {{random:a,b}} / {{datetimeformat YYYY-MM-DD}}
    const m = trimmed.match(/^([A-Za-z][\w-]*)[\s:]([\s\S]*)$/)
    if (m && m[1] !== undefined && m[2] !== undefined) {
      head = m[1]
      rest = m[2]
    } else {
      head = trimmed
      rest = ''
    }
  }
  head = head.trim()
  if (!IDENT_RE.test(head)) return null
  return { name: head, args: rest === '' ? [] : rest.split('::') }
}

function applyMacro(inner: string, env: MacroEnv, offset: number): string {
  const parts = splitMacro(inner)
  if (!parts) return `{{${inner}}}`
  const def = MACROS.get(parts.name.toLowerCase())
  // 未知宏原样保留（内层已展开）
  if (!def) return `{{${inner}}}`
  const ctx: MacroCallCtx = { args: parts.args, env, offset, raw: inner }
  try {
    return normalize(def(ctx))
  } catch (e) {
    console.warn('[macro] handler 执行失败:', inner, e)
    return `{{${inner}}}`
  }
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
