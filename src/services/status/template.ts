/**
 * 状态字段模板 → 注入给模型的那段话（当前状态 + 输出格式要求）。纯 service。
 */

import type { ChatMessage } from '@/types/chat'
import {
  fieldsFor,
  STATUS_SCOPE_LABEL,
  type CharacterStatusConfig,
  type MessageStatus,
  type StatusData,
  type StatusField,
  type StatusScope,
  type StatusSettings,
} from '@/types/status'
import { normalizeStatus } from './parse'

const SCOPES: StatusScope[] = ['scene', 'person', 'char', 'user']

/** 列表字段的条数上限，写进提示词；背包无限膨胀会让每轮固定开销越来越大 */
export const STATUS_LIST_MAX = 20

/**
 * 字段模板来自设置 / 角色卡 / 备份，coalesce 对数组只认「是数组」不管元素，
 * 所以这里逐项收敛：键为空、重名、scope/kind 非法的都丢掉。
 */
export function sanitizeFields(raw: unknown): StatusField[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: StatusField[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const f = r as Partial<StatusField>
    const key = typeof f.key === 'string' ? f.key.trim() : ''
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({
      key,
      scope: f.scope && SCOPES.includes(f.scope) ? f.scope : 'person',
      kind: f.kind === 'list' ? 'list' : 'text',
      ...(typeof f.hint === 'string' && f.hint.trim() ? { hint: f.hint.trim() } : {}),
      enabled: f.enabled !== false,
    })
  }
  return out
}

/**
 * 本轮生效的字段：覆盖配置（1v1 = 角色卡，群聊 = 群聊）有字段就用它的，否则全局。
 * 只返回启用的。
 */
export function resolveStatusFields(
  settings: StatusSettings,
  override?: CharacterStatusConfig | null,
): StatusField[] {
  const own = sanitizeFields(override?.fields)
  return (own.length ? own : sanitizeFields(settings.fields)).filter((f) => f.enabled)
}

/**
 * 覆盖配置上的初始状态（来自备份 / 手改，可能不合法）。
 *
 * ⚠️ 存的是内部形状 `{scene, people:[{name, fields}]}`，**不能**直接交给 normalizeStatus ——
 * 那是给模型输出（「场景 / 人物 / 名字」扁平形状）用的，会把 `fields` 当成一个字段名，
 * 整份初始状态变成一条「fields：{…}」的垃圾。先转回输出形状再走同一套收敛。
 */
export function configInitialStatus(cfg?: CharacterStatusConfig | null): StatusData | null {
  const raw = cfg?.initial as unknown
  if (!raw || typeof raw !== 'object') return null
  const r = raw as { scene?: unknown; people?: unknown }
  const internal =
    Array.isArray(r.people) &&
    r.people.every((p) => !!p && typeof p === 'object' && 'fields' in p && 'name' in p)
  if (internal) {
    const scene = r.scene && typeof r.scene === 'object' ? r.scene : {}
    return normalizeStatus(
      toOutputShape({ scene, people: r.people } as StatusData) as Record<string, unknown>,
    )
  }
  return normalizeStatus(raw as Record<string, unknown>)
}

/** 最新快照：倒序第一条带 status 的消息 */
export function latestStatus(
  messages: readonly ChatMessage[],
): { msg: ChatMessage; status: MessageStatus } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    const s = m.extra?.status
    if (s?.data) return { msg: m, status: s }
  }
  return null
}

/** 发给模型 / 原始 JSON 编辑用的形状：键用中文，人物是数组 */
export function toOutputShape(d: StatusData): Record<string, unknown> {
  return {
    场景: d.scene,
    人物: d.people.map((p) => ({ 名字: p.name, ...p.fields })),
  }
}

export function buildStatusBlock(opts: {
  fields: StatusField[]
  current: StatusData | null
  userName: string
  /** 角色名，发言者排第一（示例骨架取它） */
  charNames: string[]
  isGroup: boolean
  sub: (t: string) => string
}): string {
  const { fields, current, userName, charNames, sub } = opts
  if (!fields.length) return ''
  const scene = fields.filter((f) => f.scope === 'scene')
  const hasPerson = fields.some((f) => f.scope !== 'scene')

  // 示例骨架：让模型照着形状填，而不是只看文字描述。
  // 角色条目与用户条目各自只放自己适用的字段
  const blank = (f: StatusField) => (f.kind === 'list' ? ['…'] : '…')
  const entry = (name: string, isUser: boolean) => ({
    名字: name,
    ...Object.fromEntries(fieldsFor(fields, isUser).map((f) => [f.key, blank(f)])),
  })
  const sample = {
    场景: Object.fromEntries(scene.map((f) => [f.key, blank(f)])),
    人物: [...charNames.slice(0, 1).map((n) => entry(n, false)), entry(userName, true)],
  }
  const line = (f: StatusField) =>
    `  - ${f.key}${f.kind === 'list' ? `（字符串数组，最多 ${STATUS_LIST_MAX} 项）` : ''}${f.hint ? `：${sub(f.hint)}` : ''}`
  const group = (scope: StatusScope, title: string) => {
    const list = fields.filter((f) => f.scope === scope)
    return list.length ? [`- ${title}`, ...list.map(line)] : []
  }
  // 用户和每个角色都必须有一项：漏写虽然会被 completeStatus 沿用上一份兜住，
  // 但那样这个人这一轮的变化就丢了
  const required = [...charNames, userName]

  const parts = [
    '【角色状态】',
    current
      ? `当前状态（上一轮结束时的事实，续写时必须与之一致）：\n${JSON.stringify(toOutputShape(current))}`
      : '当前状态：尚无记录，请依据角色设定与开场情境推断。',
    '',
    '在回复正文写完之后，另起一行输出本轮结束时的最新状态，严格使用下面的格式（不要放进代码块）：',
    `<status>${JSON.stringify(sample)}</status>`,
    '字段说明：',
    ...group('scene', STATUS_SCOPE_LABEL.scene),
    ...(hasPerson
      ? [
          `- 人物：数组，用「名字」标明是谁。必须包含以下每个人各一项：${required.join('、')}` +
            (opts.isGroup ? '（不在当前场景的成员也要写，并在状态里注明其所在）' : ''),
          ...group('person', '所有人都有的字段').map((l) => `  ${l}`),
          ...group('char', `仅角色有的字段（${userName}不写）`).map((l) => `  ${l}`),
          ...group('user', `仅 ${userName} 有的字段`).map((l) => `  ${l}`),
        ]
      : []),
    '要求：每次输出完整快照而不是变化量；没有变化的字段原样照抄；只写剧情里已经确立的事实；' +
      '<status> 块只能出现在回复最末尾一次，正文里不要提到它。',
  ]
  return parts.join('\n')
}
