/**
 * 上下文预算分配。
 *
 * ⚠️ 顺序至关重要：`mandatory + injected` 先扣掉，剩下的才给历史/示例。
 * 反过来做的话，长对话会把用户配置的 depth-0 约束提示词**静默丢掉** ——
 * 这是需求 4 最坏的失败模式：模型突然不守设定，而用户完全不知道为什么。
 */

import type { TokenCounter } from '../tokens'
import type { PromptMessage } from '@/types/prompt'

export interface FitInput {
  /** 卡片块 + 世界书 before/after + persona 等，恒定保留 */
  mandatory: PromptMessage[]
  /** 深度注入产生的伪消息（已 materialize），恒定保留 */
  injected: PromptMessage[]
  /** 旧→新时序的真实历史 */
  history: PromptMessage[]
  /** 对话示例，按块 */
  exampleBlocks: PromptMessage[][]
  budget: number
  count: TokenCounter
  pinExamples: boolean
  /** 每条消息的固定开销估算 */
  perMessage: number
  /**
   * 上一轮的截断起点（history 下标）。只要从它开始仍放得下就原样沿用，
   * 前缀因此逐轮不变、能命中服务端的前缀缓存。缺省 0。
   */
  anchor?: number
  /**
   * 放不下、必须前移起点时，截到剩余预算的多少比例（0.5 ~ 1）。
   * 1 = 旧行为：只挤掉刚好放不下的那几条，且不沿用 anchor。
   */
  trimRatio?: number
}

export interface FitResult {
  history: PromptMessage[]
  examples: PromptMessage[]
  droppedHistory: number
  droppedExamples: number
  /** 本轮历史起点（history 下标），调用方应存下来作为下一轮的 anchor */
  historyStart: number
  /** 注入 + 必留块占用的 token，供预览面板显示 */
  reserved: number
  used: number
}

export function fitWithinBudget(input: FitInput): FitResult {
  const { mandatory, injected, history, exampleBlocks, budget, count, pinExamples, perMessage } =
    input
  const size = (m: PromptMessage) => count(m.content) + perMessage

  let used = 0
  for (const m of mandatory) used += size(m)
  for (const m of injected) used += size(m) // ← 注入先占位，这两行是需求 4 的命脉
  const reserved = used

  const takeExamples = () => {
    const kept: PromptMessage[] = []
    let dropped = 0
    let blocksKept = 0
    for (const block of exampleBlocks) {
      const t = block.reduce((s, m) => s + size(m), 0)
      if (used + t > budget) {
        dropped = exampleBlocks.length - blocksKept
        break
      }
      used += t
      kept.push(...block)
      blocksKept++
    }
    return { kept, dropped }
  }

  /**
   * 历史的起点带迟滞（hysteresis）：
   *   1. 整段放得下 → 从 0 开始（对话还短，或刚调大了上下文）
   *   2. 从上一轮的 anchor 开始仍放得下 → 沿用，前缀逐轮不变
   *   3. 否则一次性前移到「后缀 ≤ 剩余预算 × trimRatio」的最早位置，
   *      腾出一截余量，接下来若干轮又能沿用
   * 最新一条永远保留，否则会发出空历史。
   */
  const takeHistory = () => {
    const n = history.length
    if (!n) return { kept: [] as PromptMessage[], dropped: 0, start: 0 }
    // suffix[i] = history[i..] 的总 token
    const suffix = new Array<number>(n + 1).fill(0)
    for (let i = n - 1; i >= 0; i--) {
      const m = history[i]
      suffix[i] = (suffix[i + 1] ?? 0) + (m === undefined ? 0 : size(m))
    }
    const room = budget - used
    const fits = (i: number) => (suffix[i] ?? 0) <= room
    const ratio = Math.min(1, Math.max(0.5, input.trimRatio ?? 1))
    const anchor = ratio >= 1 ? 0 : Math.min(n - 1, Math.max(0, input.anchor ?? 0))

    let start: number
    if (fits(0)) start = 0
    else if (anchor > 0 && fits(anchor)) start = anchor
    else {
      const target = room * ratio
      start = n - 1
      for (let i = 0; i < n - 1; i++) {
        if ((suffix[i] ?? 0) <= target) {
          start = i
          break
        }
      }
    }
    used += suffix[start] ?? 0
    return { kept: history.slice(start), dropped: start, start }
  }

  // pinExamples 时示例优先吃预算，否则历史优先（与 ST 一致）
  if (pinExamples) {
    const kept = exampleBlocks.flat()
    for (const m of kept) used += size(m)
    const h = takeHistory()
    return {
      history: h.kept,
      examples: kept,
      droppedHistory: h.dropped,
      droppedExamples: 0,
      historyStart: h.start,
      reserved,
      used,
    }
  }
  const h = takeHistory()
  // 历史已经被截过：示例若去吃「剩下的」预算，剩多少会随历史逐轮增长而变，
  // 示例块数跟着浮动 —— 它们夹在系统块与历史之间，一变整段前缀全失效。
  // 这时干脆不带（旧行为在长对话里也基本挤不出示例的位置）；想保留请开 pinExamples。
  const ex =
    h.dropped > 0 && (input.trimRatio ?? 1) < 1
      ? { kept: [] as PromptMessage[], dropped: exampleBlocks.length }
      : takeExamples()
  return {
    history: h.kept,
    examples: ex.kept,
    droppedHistory: h.dropped,
    droppedExamples: ex.dropped,
    historyStart: h.start,
    reserved,
    used,
  }
}
