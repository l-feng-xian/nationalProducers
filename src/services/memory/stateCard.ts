/**
 * 会话记忆 · 状态卡的提炼。
 *
 * 机制：每积累 N 条消息，把「上次提炼之后的新对话」连同「旧状态卡」一起丢给模型，
 * 要求它**整体重写**出一段 ≤200 token 的现在时快照，而不是在旧的后面追加。
 *
 * 为什么是重写而不是追加：
 *  - 追加会无限膨胀，最终吃光上下文；
 *  - 更重要的是，只有重写才能表达「这件事已经不成立了」。第 30 条她说「我讨厌你」，
 *    第 200 条已经生死与共 —— 检索式记忆（关键词也好向量也好）会把那句「我讨厌你」
 *    按相似度原样捞回来，模型收到一条**已被剧情推翻**的记忆，比没有记忆更糟。
 *    状态卡每次重写时丢掉不再成立的内容，是这个问题唯一的解法。
 *
 * 本文件是纯 service：不 import vue/pinia，可单独在浏览器里 dynamic import 跑断言。
 * 提炼提示词与容错解析改编自 sillyTavernTauri/src/services/memory/chatMemory.ts。
 */

import { estimateTokens } from '../tokens'
import { chatOnce } from '../provider/openaiCompatible'
import type { ProviderConfig } from '@/types/provider'
import type { StateCard } from '@/types/chat'

/** 状态卡硬上限。它每轮必注入，这个数字直接等于每轮的固定 token 开销 */
export const STATE_TOKEN_CAP = 200

export function emptyStateCard(): StateCard {
  return { text: '', throughSeq: -1, updatedAt: 0 }
}

/**
 * 去掉推理模型的思维链。
 * ⚠️ 被 maxTokens 截断的未闭合 `<think>` 块要整体判空 —— 否则半截思考会被当成状态卡存下来。
 */
export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/, '')
  if (/<think>/i.test(out)) out = ''
  return out.trim()
}

/** 按 token 预算截断，尽量不切断行 */
export function capTokens(text: string, budget: number): string {
  const t = text.trim()
  if (!t || estimateTokens(t) <= budget) return t
  const lines = t.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    if (estimateTokens([...kept, line].join('\n')) > budget) break
    kept.push(line)
  }
  // 单行就超预算时只能硬切。这里刻意用 estimateTokens 反推而不是 budget*4：
  // 原实现的 *4 是纯英文假设，中文下会截出 4 倍长的内容。
  if (!kept.length) {
    let cut = t
    while (cut.length > 8 && estimateTokens(cut) > budget) {
      cut = cut.slice(0, Math.floor(cut.length * 0.8))
    }
    return cut.trim()
  }
  return kept.join('\n').trim()
}

const EXTRACT_SYSTEM = [
  '你负责维护一段角色扮演对话的长期记忆。你会收到当前的记忆状态和最新的对话。',
  '只回复一个纯 JSON 对象，不要 markdown 代码块，不要任何解释：{"state": string}',
  '',
  '"state" 是对「故事此刻进展到哪里」的**完整重写**快照：人物关系到了哪一步、',
  '彼此如何称呼、身处何地、正在进行什么、有什么未了结的约定或悬念、当前情绪基调。',
  '',
  '重要规则：',
  '1. 必须**整体重写**，把旧状态与新发生的变化合并成一段新的描述，而不是在旧的后面追加。',
  '2. **丢弃已经不再成立的内容**。如果关系变了、地点换了、某个计划已经完成或作废，',
  '   旧的说法就不要再出现。这是本任务最重要的一条。',
  '3. 控制在 120 字以内，写成连贯的叙述，不要分条列点。',
  '4. 只写已经在对话里发生过的事，不要推测、不要续写剧情。',
  '5. **用与对话相同的语言书写**。',
].join('\n')

/** 模型明确拒答/答非所问时的特征串。命中即判失败，避免把垃圾写进状态卡 */
const REFUSAL_PATTERNS = [
  /我无法/,
  /我不能/,
  /作为(一个)?(AI|人工智能|语言模型)/i,
  /抱歉[，,]/,
  /^\s*(I['’]m sorry|I cannot|I can['’]t|As an AI)/i,
]

export interface ExtractOutcome {
  ok: boolean
  /** ok 时的新状态卡正文 */
  text?: string
  /** 失败原因，给 UI 显示 */
  reason?: string
}

/** 容错解析：模型经常在 JSON 外面裹一层废话或代码块 */
export function parseStateReply(raw: string): string | null {
  const text = stripThink(raw)
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  const body = start !== -1 && end > start ? text.slice(start, end + 1) : text
  try {
    const obj: unknown = JSON.parse(body)
    if (!obj || typeof obj !== 'object') return null
    const state = (obj as { state?: unknown }).state
    return typeof state === 'string' && state.trim() ? state.trim() : null
  } catch {
    return null
  }
}

/**
 * 质量校验 —— 这一步比选哪种检索机制更影响最终观感。
 *
 * SillyTavern 的 Summarize 全部兜底只有 `if (!summary) return`：模型拒答、复读提示词、
 * 输出一段角色台词，都会被原样写进摘要，然后**作为下一次提炼的输入被喂回去**，
 * 于是错误单调累积且永远无法自愈。用户看到的现象是「聊着聊着记忆整个乱了」。
 */
export function validateState(next: string, prev: string): ExtractOutcome {
  const t = next.trim()
  if (t.length < 20) return { ok: false, reason: '模型返回的内容过短，疑似未按要求输出' }
  if (estimateTokens(t) > STATE_TOKEN_CAP * 2) {
    return { ok: false, reason: '模型返回的内容远超长度上限，疑似把对话原文抄了回来' }
  }
  if (REFUSAL_PATTERNS.some((re) => re.test(t))) {
    return { ok: false, reason: '模型拒绝了提炼请求' }
  }
  // 已有相当篇幅的状态卡突然缩水八成，通常是模型没读懂任务而不是剧情真的清空了
  if (prev.trim().length > 60 && t.length < prev.trim().length * 0.2) {
    return { ok: false, reason: '新状态卡比原有内容短太多，疑似提炼失败' }
  }
  return { ok: true, text: t }
}

export interface ExtractInput {
  prev: StateCard
  /** 上次提炼之后的新对话，已渲染成 `名字：内容` 逐行 */
  dialogue: string
  cfg: ProviderConfig
  model: string
  signal?: AbortSignal
}

/**
 * 跑一次提炼。**永不抛异常** —— 记忆是尽力而为的增强，绝不能让它把聊天搞崩。
 */
export async function extractStateCard(input: ExtractInput): Promise<ExtractOutcome> {
  const prevText = input.prev.text.trim()
  const user = [
    prevText ? `当前记忆状态：\n${prevText}` : '当前还没有记忆状态。',
    '',
    '新的对话：',
    input.dialogue,
  ].join('\n')

  try {
    const raw = await chatOnce(
      input.cfg,
      {
        model: input.model,
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: user },
        ],
        stream: false,
        // 这个额度要同时覆盖推理模型的思考链和 JSON 本体。
        // 给小了会截断成未闭合的 <think>，stripThink 整体判空，
        // 表现为「提炼永远失败却没有任何报错」。
        maxTokens: 1536,
        temperature: 0.3,
      },
      input.signal,
    )
    const state = parseStateReply(raw)
    if (!state) return { ok: false, reason: '模型没有返回可解析的 JSON' }
    return validateState(state, prevText)
  } catch (e) {
    if (input.signal?.aborted) return { ok: false, reason: '已取消' }
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** 把提炼结果并进状态卡。失败时**不推进 throughSeq**，下次会把这段对话重新提炼一遍 */
export function mergeStateCard(prev: StateCard, outcome: ExtractOutcome, seq: number): StateCard {
  if (!outcome.ok || !outcome.text) {
    return {
      ...prev,
      failures: (prev.failures ?? 0) + 1,
      lastError: outcome.reason ?? '未知原因',
    }
  }
  return {
    text: capTokens(outcome.text, STATE_TOKEN_CAP),
    throughSeq: seq,
    updatedAt: Date.now(),
    failures: 0,
  }
}
