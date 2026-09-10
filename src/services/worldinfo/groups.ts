/**
 * 包含组（inclusion group）：同组条目互相竞争，最终只留一个。
 * 对齐 SillyTavern world-info.js:5269 filterByInclusionGroups。
 *
 * 过滤顺序（有语义，不能重排）：
 *   1. 定时效果：组内有 sticky 命中 → 只留 sticky 的；再剔除 cooldown / delay 中的
 *   2. 组内评分：命中关键词多的胜出（仅当开启 useGroupScoring）
 *   3. 主选择：已激活过同组 → 整组丢弃；groupOverride 优先；否则按 groupWeight 加权随机
 */

import type { WorldInfoBuffer } from './buffer'
import type { WorldInfoTimedEffects } from './timed'
import { DEFAULT_WEIGHT, type ResolvedEntry, type ScanState } from '@/types/worldinfo'
import type { WorldInfoSettings } from '@/types/settings'

function removeAllBut(group: ResolvedEntry[], keep: ResolvedEntry, list: ResolvedEntry[]) {
  for (const e of group) {
    if (e === keep) continue
    const i = list.indexOf(e)
    if (i !== -1) list.splice(i, 1)
  }
}

export function filterByInclusionGroups(
  newEntries: ResolvedEntry[],
  allActivated: Map<string, ResolvedEntry>,
  buffer: WorldInfoBuffer,
  scanState: ScanState,
  timed: WorldInfoTimedEffects,
  settings: WorldInfoSettings,
): void {
  // 一个条目可属多组（逗号分隔）
  const grouped = new Map<string, ResolvedEntry[]>()
  for (const e of newEntries) {
    if (!e.group) continue
    for (const g of e.group.split(/,\s*/).filter(Boolean)) {
      const list = grouped.get(g) ?? []
      list.push(e)
      grouped.set(g, list)
    }
  }
  if (!grouped.size) return

  for (const [key, groupRaw] of grouped) {
    let group = groupRaw.filter((e) => newEntries.includes(e))
    if (!group.length) continue

    // ── 1. 定时效果 ──
    const stickies = group.filter((e) => timed.isEffectActive('sticky', e))
    const hasSticky = stickies.length > 0
    if (hasSticky) {
      for (const e of group) {
        if (stickies.includes(e)) continue
        const i = newEntries.indexOf(e)
        if (i !== -1) newEntries.splice(i, 1)
      }
      group = stickies
    } else {
      group = group.filter((e) => {
        const blocked = timed.isEffectActive('cooldown', e) || timed.isDelayed(e)
        if (blocked) {
          const i = newEntries.indexOf(e)
          if (i !== -1) newEntries.splice(i, 1)
        }
        return !blocked
      })
    }
    if (!group.length) continue

    // ── 2. 组内评分 ──
    const scoringOn =
      settings.world_info_use_group_scoring || group.some((e) => e.useGroupScoring === true)
    if (scoringOn && !hasSticky && group.length > 1) {
      const scores = group.map((e) => buffer.getScore(e, scanState))
      const max = Math.max(...scores)
      const survivors: ResolvedEntry[] = []
      group.forEach((e, i) => {
        const uses = e.useGroupScoring ?? settings.world_info_use_group_scoring
        if (uses && (scores[i] ?? 0) < max) {
          const idx = newEntries.indexOf(e)
          if (idx !== -1) newEntries.splice(idx, 1)
        } else {
          survivors.push(e)
        }
      })
      group = survivors
    }
    if (!group.length) continue

    // ── 3. 主选择 ──
    if (hasSticky) continue // sticky 的全部保留

    // 已有同组条目被激活过 → 整组丢弃（组已满足）
    // 注意：ST 这里用的是整串比较，`group: "a, b"` 不会被 key "a" 拦住。
    // 用户要求「完整对齐」，这里保留上游行为。
    let already = false
    for (const act of allActivated.values()) {
      if (act.group === key) {
        already = true
        break
      }
    }
    if (already) {
      for (const e of group) {
        const i = newEntries.indexOf(e)
        if (i !== -1) newEntries.splice(i, 1)
      }
      continue
    }

    if (group.length <= 1) continue

    // 优先级覆盖
    const prios = group.filter((e) => e.groupOverride).sort((a, b) => b.order - a.order)
    const first = prios[0]
    if (first) {
      removeAllBut(group, first, newEntries)
      continue
    }

    // 加权随机
    const total = group.reduce((acc, e) => acc + (e.groupWeight ?? DEFAULT_WEIGHT), 0)
    const roll = Math.random() * total
    let acc = 0
    let winner = group[group.length - 1]
    for (const e of group) {
      acc += e.groupWeight ?? DEFAULT_WEIGHT
      if (roll <= acc) {
        winner = e
        break
      }
    }
    if (winner) removeAllBut(group, winner, newEntries)
  }
}
