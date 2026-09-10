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
}

export interface FitResult {
  history: PromptMessage[]
  examples: PromptMessage[]
  droppedHistory: number
  droppedExamples: number
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

  const takeHistory = () => {
    const kept: PromptMessage[] = []
    let dropped = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]
      if (m === undefined) continue
      const t = size(m)
      // 最新一条永远保留，否则会发出空历史
      if (used + t > budget && kept.length > 0) {
        dropped = i + 1
        break
      }
      used += t
      kept.unshift(m)
    }
    return { kept, dropped }
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
      reserved,
      used,
    }
  }
  const h = takeHistory()
  const ex = takeExamples()
  return {
    history: h.kept,
    examples: ex.kept,
    droppedHistory: h.dropped,
    droppedExamples: ex.dropped,
    reserved,
    used,
  }
}
