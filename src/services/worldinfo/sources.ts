/**
 * 世界书来源解析与排序。对齐 SillyTavern world-info.js:4478 getSortedEntries。
 *
 * 层级优先级：会话书 → 人设书 → （角色书 / 全局书，按插入策略）
 * 同名书在更高优先级层出现过就跳过（去重）。
 */

import { entryHash } from './timed'
import { toPlain } from '@/utils/plain'
import {
  KNOWN_DECORATORS,
  world_info_insertion_strategy,
  type ResolvedEntry,
  type WorldBook,
  type WorldInfoEntry,
} from '@/types/worldinfo'

export interface LoreSources {
  global: WorldBook[]
  character: WorldBook[]
  chat: WorldBook[]
  persona: WorldBook[]
}

/** 从 content 头部剥出 @@decorator 行 */
function parseDecorators(content: string): { decorators: string[]; content: string } {
  const decorators: string[] = []
  const lines = content.split('\n')
  let i = 0
  for (; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    if (!line.startsWith('@@')) break
    // @@@ 是转义的字面量，不是装饰器
    if (line.startsWith('@@@')) break
    const name = line.split(/\s+/)[0] ?? ''
    if ((KNOWN_DECORATORS as readonly string[]).includes(name)) decorators.push(name)
  }
  return { decorators, content: i > 0 ? lines.slice(i).join('\n') : content }
}

function toResolved(book: WorldBook, entries: WorldInfoEntry[]): ResolvedEntry[] {
  return entries.map((e) => {
    const { decorators, content } = parseDecorators(e.content)
    return {
      ...e,
      world: book.id,
      worldName: book.name,
      // hash 基于**原始** content 计算（与 ST 一致），装饰器剥离前
      hash: entryHash(e),
      decorators,
      content,
    }
  })
}

const sortFn = (a: ResolvedEntry, b: ResolvedEntry) => b.order - a.order

/**
 * 汇总所有来源、按策略排序，返回**深拷贝**。
 *
 * ⚠️ 深拷贝不可省：扫描过程会就地改写 `entry.content`（宏展开）。
 * 不拷贝的话，Pinia store 里的原始世界书会被展开结果永久污染，
 * 用户一保存就写回 IndexedDB —— 这是会丢数据的 bug。
 */
export function resolveSortedEntries(sources: LoreSources, strategy: 0 | 1 | 2): ResolvedEntry[] {
  const seen = new Set<string>()
  const take = (books: WorldBook[]): ResolvedEntry[] => {
    const out: ResolvedEntry[] = []
    for (const b of books) {
      if (seen.has(b.id)) continue
      seen.add(b.id)
      out.push(...toResolved(b, Object.values(b.entries)))
    }
    return out
  }

  // 去重顺序即优先级：会话 > 人设 > 角色 > 全局
  const chatLore = take(sources.chat)
  const personaLore = take(sources.persona)
  const characterLore = take(sources.character)
  const globalLore = take(sources.global)

  let entries: ResolvedEntry[]
  switch (strategy) {
    case world_info_insertion_strategy.character_first:
      entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)]
      break
    case world_info_insertion_strategy.global_first:
      entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)]
      break
    default:
      entries = [...globalLore, ...characterLore].sort(sortFn)
      break
  }
  // 会话书永远最前，其次人设书
  entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries]

  return toPlain(entries)
}
