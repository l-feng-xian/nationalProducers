/**
 * 把记忆合成一本**只存在于内存里**的世界书。
 *
 * 一套机制两个用途：既复用了世界书引擎的常驻/预算/插入位置，
 * 又让 `PromptPreview.vue` **零改动**就能看到状态卡和每条召回片段。
 * 在一个没有测试框架的项目里，那个可视化面板就是调试器。
 *
 * 纯 service：不 import vue/pinia。
 */

import { DEFAULT_WI_ENTRY, world_info_position, type WorldBook } from '@/types/worldinfo'
import { EXT_ROLE } from '@/types/prompt'
import type { Hit } from './search'

export const MEMORY_BOOK_ID = '__vecmem__'

export interface MemoryBookOpts {
  stateCard: string
  hits: Hit[]
  stateDepth: number
  recallDepth: number
}

/**
 * 召回片段的免责抬头。
 *
 * 这句话是必需的，不是客套：召回来的是**过去的**对话原文，它完全可能已被后续
 * 剧情推翻（第 30 条说「我讨厌你」，第 200 条已经生死与共）。
 * 状态卡注入得更靠近回复位置（depth 更小），冲突时天然占上风；
 * 这句抬头是第二道保险，明确告诉模型「这是曾经，不是此刻」。
 */
const RECALL_HEADER = '【相关往事·可能已过时，以上方的会话记忆为准】'

/**
 * 构造记忆书。没有任何内容时返回 null —— 绝不产生空块。
 *
 * ⚠️ 每个条目必须以 `DEFAULT_WI_ENTRY` 打底再覆盖：`WorldInfoEntry` 有 40 个字段，
 * 其中 `scanDepth` / `caseSensitive` / `matchWholeWords` / `sticky` / `cooldown` / `delay`
 * 的 `null` 是**三态语义**（null = 继承全局），与 false/0 完全不同。
 * 手写字面量必然漏字段，`noUncheckedIndexedAccess` 也会报错。
 */
export function buildMemoryBook(opts: MemoryBookOpts): WorldBook | null {
  const state = opts.stateCard.trim()
  const hits = opts.hits.filter((h) => h.text.trim())
  if (!state && !hits.length) return null

  const entries: WorldBook['entries'] = {}
  let uid = 0

  if (state) {
    entries[String(uid)] = {
      ...DEFAULT_WI_ENTRY,
      uid,
      // constant 让它不需要关键词就激活；ignoreBudget 让它免疫世界书预算
      constant: true,
      ignoreBudget: true,
      content: `【会话记忆】\n${state}`,
      position: world_info_position.atDepth,
      depth: opts.stateDepth,
      role: EXT_ROLE.SYSTEM,
      order: 150,
      comment: '记忆·状态卡',
      // 记忆不参与递归扫描，否则会自己触发自己
      preventRecursion: true,
      excludeRecursion: true,
    }
    uid++
  }

  for (const h of hits) {
    entries[String(uid)] = {
      ...DEFAULT_WI_ENTRY,
      uid,
      constant: true,
      ignoreBudget: true,
      content: `${RECALL_HEADER}\n${h.text}`,
      position: world_info_position.atDepth,
      depth: opts.recallDepth,
      role: EXT_ROLE.SYSTEM,
      order: 140,
      // 相似度进 comment，预览面板里一眼能看到这条为什么被召回
      comment: `记忆·召回 ${h.score.toFixed(3)}`,
      preventRecursion: true,
      excludeRecursion: true,
    }
    uid++
  }

  return {
    id: MEMORY_BOOK_ID,
    name: '会话记忆',
    description: '运行时合成，不落库',
    entries,
    createdAt: 0,
    updatedAt: 0,
  }
}
