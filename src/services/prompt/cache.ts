/**
 * 前缀缓存辅助：易变宏检测、提示词签名、与上一次请求的公共前缀比对、历史净化。
 *
 * 背景：DeepSeek / OpenAI 等的缓存都是「前缀精确匹配」—— 从第一个不同的 token 起，
 * 后面全部按未命中计费。所以要让每轮只有末尾在变，并能看出是哪一块先变了。
 *
 * 纯 TS，不 import vue/pinia。
 */

import { fnv1a } from '../hash'
import type { PromptMessage } from '@/types/prompt'

/** 每轮都会变的宏 */
const PER_TURN = [
  'random',
  'roll',
  'time',
  'isotime',
  'datetimeformat',
  'idleduration',
  'idle_duration',
  'lastmessage',
  'lastmessageid',
  'lastusermessage',
  'lastcharmessage',
  'input',
]
/** 按天变的宏：一天内稳定，影响小 */
const PER_DAY = ['date', 'isodate', 'weekday']

const MACRO_RE = /\{\{\s*([a-z_]+)(?:\s*::[^}]*)?\s*\}\}/gi

export interface VolatileMacroHit {
  /** 出现在哪一块（PromptPreview 的 source 标签键） */
  where: string
  macro: string
  /** turn = 每轮都变；day = 按天变 */
  scope: 'turn' | 'day'
}

/**
 * 在「会进前缀」的模板原文里找易变宏。
 * 只该传前缀部分（主提示词、角色卡、人设……）；深度注入、PHI 本来就在尾部，放那里无妨。
 */
export function findVolatileMacros(sources: Record<string, string>): VolatileMacroHit[] {
  const hits: VolatileMacroHit[] = []
  for (const [where, text] of Object.entries(sources)) {
    if (!text) continue
    const seen = new Set<string>()
    for (const m of text.matchAll(MACRO_RE)) {
      const name = (m[1] ?? '').toLowerCase()
      // {{time_UTC+8}} 这种写法会被预处理成 time::…，名字前缀一致
      const key = name.startsWith('time_') ? 'time' : name
      if (seen.has(key)) continue
      const scope = PER_TURN.includes(key) ? 'turn' : PER_DAY.includes(key) ? 'day' : null
      if (!scope) continue
      seen.add(key)
      hits.push({ where, macro: key, scope })
    }
  }
  return hits
}

/** 每块一个签名：role + name + 内容。squash 前的块，才能指认是哪一块先变了 */
export function signPrompt(sections: PromptMessage[]): number[] {
  return sections.map((m) => fnv1a(`${m.role}\u0001${m.name ?? ''}\u0001${m.content}`))
}

/** 两串签名的公共前缀长度（块数） */
export function commonPrefix(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a[i] === b[i]) i++
  return i
}

export interface PrefixReport {
  /** 与上一次请求相同的前导块数 */
  sameBlocks: number
  totalBlocks: number
  /** 这些前导块的估算 token（≈ 可命中缓存的上限） */
  sameTokens: number
  totalTokens: number
  /** 第一处不同的块；全同或没有上一次时为 undefined */
  firstDiff?: PromptMessage
}

/**
 * 当前组装结果 vs 上一次真实发出的请求。
 * prev 为空（本会话还没发过）时返回 null。
 */
export function comparePrefix(
  sections: PromptMessage[],
  prev: readonly number[] | undefined,
  count: (m: PromptMessage) => number,
): PrefixReport | null {
  if (!prev?.length) return null
  const sig = signPrompt(sections)
  const same = commonPrefix(sig, prev)
  let sameTokens = 0
  let totalTokens = 0
  sections.forEach((m, i) => {
    const t = count(m)
    totalTokens += t
    if (i < same) sameTokens += t
  })
  const firstDiff = same < sections.length ? sections[same] : undefined
  return {
    sameBlocks: same,
    totalBlocks: sections.length,
    sameTokens,
    totalTokens,
    ...(firstDiff ? { firstDiff } : {}),
  }
}

/**
 * 历史里 AI 消息的净化：去掉**已闭合**的 `<think>…</think>`，压掉 3 个以上的连续空行。
 *
 * 只作用于发给模型的副本，不改库里的消息。刻意不碰未闭合的 `<think>`：
 * 那可能是正文里真的出现了这个词，整条判空会让历史凭空少一条。
 */
export function cleanHistoryText(text: string): string {
  if (!text) return text
  let out = text
  if (/<think>/i.test(out)) out = out.replace(/<think>[\s\S]*?<\/think>\s*/gi, '')
  out = out.replace(/\n{3,}/g, '\n\n').trim()
  // 整条只有思维链：保留原文，别发出一条空 assistant
  return out || text
}
