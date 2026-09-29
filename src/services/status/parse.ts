/**
 * 从 AI 回复里取出 `<status>{…}</status>` 状态块，并把它从正文里剥掉。
 *
 * 纯 service：不 import vue/pinia/provider，verify-status.ts 直接在 node 里跑断言。
 *
 * 模型输出很不守规矩，这里逐一兜住实测常见的几种：
 *  - 块里又裹一层 ```json 代码块；
 *  - 被 maxTokens 截断，只有开标签没有闭标签 → 正文照样剥干净，状态记为失败；
 *  - 没写标签，只在末尾甩一个 JSON 代码块 → 认得出「场景 / 人物」才当状态剥掉；
 *  - 人物写成 `{ "艾莉": {…} }` 的字典、键用英文、值是数字或物品字典、尾逗号。
 */

import type { StatusData, StatusPerson, StatusValue } from '@/types/status'

export interface ExtractResult {
  /** 剥掉状态块之后的正文 */
  body: string
  data: StatusData | null
  /** data 为 null 时的原因，给侧栏显示 */
  error?: string
}

const OPEN_RE = /<status\b[^>]*>/gi
const CLOSE_RE = /<\/status\s*>/i
const SCENE_KEYS = ['场景', 'scene']
const PEOPLE_KEYS = ['人物', 'people', 'characters', '角色']
const NAME_KEYS = ['名字', 'name', '姓名', '名称']

export function extractStatus(text: string): ExtractResult {
  let open: RegExpExecArray | null = null
  for (const m of text.matchAll(OPEN_RE)) open = m
  if (open) {
    // 取最后一块；前面万一还有别的完整块（模型写了两遍），一并剥掉
    const head = text.slice(0, open.index).replace(/<status\b[^>]*>[\s\S]*?<\/status\s*>/gi, '')
    const after = text.slice(open.index + open[0].length)
    const close = after.search(CLOSE_RE)
    if (close < 0) {
      // 截断：JSON 恰好完整时仍可用，否则整块丢弃，正文绝不能带着半截 JSON 落库
      const data = parseStatusJson(after)
      return data
        ? { body: head.trimEnd(), data }
        : { body: head.trimEnd(), data: null, error: '状态输出被截断（回复长度上限不够）' }
    }
    const inner = after.slice(0, close)
    const tail = after.slice(close).replace(CLOSE_RE, '')
    const body = [head.trimEnd(), tail.trim()].filter(Boolean).join('\n\n')
    const data = parseStatusJson(inner)
    return data ? { body, data } : { body, data: null, error: '状态不是合法 JSON' }
  }

  // 没写标签：只认末尾那个、且长得像状态的代码块
  const fence = /```(?:json)?\s*(\{[\s\S]*\})\s*```\s*$/i.exec(text)
  if (fence) {
    const data = parseStatusJson(fence[1]!, true)
    if (data) return { body: text.slice(0, fence.index).trimEnd(), data }
  }
  return { body: text, data: null, error: '本轮回复没有输出状态' }
}

/**
 * 流式期间给气泡看的正文：从 `<status` 起全部藏起来，
 * 连「刚吐出半个 `<sta`」这种也要藏，否则 JSON 会在气泡里闪一下再消失。
 */
export function stripStatusForStream(text: string): string {
  const i = text.search(/<status\b/i)
  if (i >= 0) return text.slice(0, i).trimEnd()
  const lt = text.lastIndexOf('<')
  if (lt >= 0 && '<status'.startsWith(text.slice(lt).toLowerCase())) return text.slice(0, lt)
  return text
}

/** strict：没有标签包着时要求必须带「场景/人物」键，免得把正文里正常的 JSON 当状态吃掉 */
export function parseStatusJson(raw: string, strict = false): StatusData | null {
  const obj = looseJson(raw)
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const rec = obj as Record<string, unknown>
  if (strict && !hasAny(rec, SCENE_KEYS) && !hasAny(rec, PEOPLE_KEYS)) return null
  return normalizeStatus(rec)
}

function looseJson(raw: string): unknown {
  const t = raw.replace(/```(?:json)?/gi, '')
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const body = t.slice(start, end + 1)
  for (const candidate of [body, body.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      return JSON.parse(candidate)
    } catch {
      // 换下一个候选
    }
  }
  return null
}

function hasAny(rec: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((k) => k in rec)
}
function pick(rec: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (k in rec) return rec[k]
  return undefined
}

/** 任意 JSON → StatusData；两边都空视为无效 */
export function normalizeStatus(rec: Record<string, unknown>): StatusData | null {
  const scene: Record<string, StatusValue> = {}
  const sceneRaw = pick(rec, SCENE_KEYS)
  if (sceneRaw && typeof sceneRaw === 'object' && !Array.isArray(sceneRaw)) {
    for (const [k, v] of Object.entries(sceneRaw)) setValue(scene, k, v)
  }
  // 模型把「时间 / 地点」直接写在顶层也收下，归到场景
  for (const [k, v] of Object.entries(rec)) {
    if (SCENE_KEYS.includes(k) || PEOPLE_KEYS.includes(k)) continue
    setValue(scene, k, v)
  }

  const people: StatusPerson[] = []
  const peopleRaw = pick(rec, PEOPLE_KEYS)
  const entries: [string | undefined, unknown][] = Array.isArray(peopleRaw)
    ? peopleRaw.map((p) => [undefined, p])
    : peopleRaw && typeof peopleRaw === 'object'
      ? Object.entries(peopleRaw)
      : []
  for (const [keyName, p] of entries) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue
    const pr = p as Record<string, unknown>
    const name = String(pick(pr, NAME_KEYS) ?? keyName ?? '').trim()
    if (!name || people.some((x) => x.name === name)) continue
    const fields: Record<string, StatusValue> = {}
    for (const [k, v] of Object.entries(pr)) {
      if (!NAME_KEYS.includes(k)) setValue(fields, k, v)
    }
    people.push({ name, fields })
  }

  if (!Object.keys(scene).length && !people.length) return null
  return { scene, people }
}

function setValue(into: Record<string, StatusValue>, key: string, v: unknown) {
  const k = key.trim()
  const val = toValue(v)
  if (k && val !== undefined) into[k] = val
}

function toValue(v: unknown): StatusValue | undefined {
  if (v == null) return undefined
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => (x && typeof x === 'object' ? itemText(x) : x == null ? '' : String(x).trim()))
      .filter(Boolean)
  }
  if (typeof v === 'object') {
    // 物品字典 {"苹果": 2} → 列表 ["苹果×2"]；其它嵌套对象压平成「键：值」
    return Object.entries(v as Record<string, unknown>).map(([k, x]) =>
      typeof x === 'number' ? `${k}×${x}` : x == null || x === '' ? k : `${k}：${plain(x)}`,
    )
  }
  return undefined
}

function itemText(x: object): string {
  const r = x as Record<string, unknown>
  const name = r['名称'] ?? r['name'] ?? r['物品']
  const count = r['数量'] ?? r['count']
  if (typeof name === 'string') return count != null ? `${name}×${plain(count)}` : name
  return plain(x)
}

function plain(x: unknown): string {
  return typeof x === 'string' ? x : JSON.stringify(x)
}

/** 值 → 单行文本（界面与 diff 用） */
export function valueText(v: StatusValue | undefined): string {
  if (v === undefined) return ''
  return Array.isArray(v) ? v.join('、') : v
}
