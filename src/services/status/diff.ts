/**
 * 相邻两份状态快照的差异：侧栏「历史」页签的逐轮变化、「当前」页签的变化圆点都用它。
 */

import type { StatusData, StatusValue } from '@/types/status'
import { valueText } from './parse'

export interface StatusChange {
  /** 空 = 场景字段 */
  person?: string
  key: string
  from: string
  to: string
  /** 任一侧是列表时按集合比：新增 / 移除的项 */
  added?: string[]
  removed?: string[]
}

export interface StatusDiff {
  changes: StatusChange[]
  joined: string[]
  left: string[]
}

export function diffStatus(prev: StatusData | null | undefined, next: StatusData): StatusDiff {
  const changes: StatusChange[] = []
  const joined: string[] = []
  const left: string[] = []
  if (!prev) return { changes, joined, left }

  compare(prev.scene, next.scene, undefined, changes)
  const before = new Map(prev.people.map((p) => [p.name, p]))
  for (const p of next.people) {
    const old = before.get(p.name)
    if (!old) joined.push(p.name)
    else compare(old.fields, p.fields, p.name, changes)
  }
  const now = new Set(next.people.map((p) => p.name))
  for (const p of prev.people) if (!now.has(p.name)) left.push(p.name)
  return { changes, joined, left }
}

function compare(
  a: Record<string, StatusValue>,
  b: Record<string, StatusValue>,
  person: string | undefined,
  out: StatusChange[],
) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    const from = valueText(x)
    const to = valueText(y)
    if (from === to) continue
    const change: StatusChange = { key, from, to, ...(person ? { person } : {}) }
    if (Array.isArray(x) || Array.isArray(y)) {
      const xs = asList(x)
      const ys = asList(y)
      change.added = ys.filter((i) => !xs.includes(i))
      change.removed = xs.filter((i) => !ys.includes(i))
      // 只是换了顺序：不算变化
      if (!change.added.length && !change.removed.length) continue
    }
    out.push(change)
  }
}

function asList(v: StatusValue | undefined): string[] {
  if (v === undefined || v === '') return []
  return Array.isArray(v) ? v : [v]
}

/** 「当前」页签给变化字段打点：`场景键` 或 `人物名\u0000键` */
export function changedKeys(d: StatusDiff): Set<string> {
  return new Set(d.changes.map((c) => changeKey(c.person, c.key)))
}
export function changeKey(person: string | undefined, key: string): string {
  return person ? `${person}\u0000${key}` : key
}
