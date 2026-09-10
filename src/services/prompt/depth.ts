/**
 * 深度注入 —— 需求 4 的核心算法。
 *
 * 权威参考：SillyTavern openai.js:806 populationInjectionPrompts
 * （不是 script.js 的 doChatInject —— 那是文本补全分支）。
 */

import {
  DEFAULT_ORDER,
  EXT_POSITION,
  EXT_ROLE,
  type Injection,
  type PromptMessage,
  type PromptRole,
} from '@/types/prompt'

const ROLE_NAME: Record<number, PromptRole> = {
  [EXT_ROLE.SYSTEM]: 'system',
  [EXT_ROLE.USER]: 'user',
  [EXT_ROLE.ASSISTANT]: 'assistant',
}

/** 角色优先级：越靠后越「重要」，最终会落在越靠下（越贴近回复）的位置 */
const ROLE_ORDER = [EXT_ROLE.SYSTEM, EXT_ROLE.USER, EXT_ROLE.ASSISTANT]

/**
 * 把 IN_CHAT 注入按深度插进聊天历史。
 *
 * depth N 的精确语义：**注入之后恰好还有 N 条真实聊天消息**。
 *   depth 0 = 追加在最后一条消息之后（**独立的一条消息**，不是拼接到最后一条上）
 *   depth 1 = 紧挨最后一条消息之前
 *   depth >= 历史长度 = 顶到历史最前
 *
 * 实现要点（缺一不可）：
 *   ① 在**新→旧倒序**数组上操作
 *   ② splice 索引 = depth + totalInserted（已插入的伪消息不能顶掉后续深度）
 *   ③ 深度必须**升序**处理，② 才成立
 *   ④ 最后 reverse 回时序
 *
 * 手工验算 chat=[M1,M2,M3]（M3 最新）→ 倒序 [M3,M2,M1]
 *   depth0 : splice(0) → [X,M3,M2,M1] → reverse → [M1,M2,M3,X]   ✔ 在最后一条之后
 *   depth1 : splice(1) → [M3,X,M2,M1] → reverse → [M1,M2,X,M3]   ✔
 *   depth0+1 同时: 先 0 → [X0,M3,M2,M1] (total=1)
 *                  再 1 → idx=1+1=2 → [X0,M3,X1,M2,M1]
 *                  reverse → [M1,M2,X1,M3,X0]                    ✔
 */
export function injectAtDepths(
  chronological: PromptMessage[],
  injections: Injection[],
  opts: { isContinue?: boolean } = {},
): PromptMessage[] {
  const inChat = injections.filter(
    (i) =>
      i.position === EXT_POSITION.IN_CHAT && i.value.trim() !== '' && (!i.filter || i.filter()),
  )
  if (!inChat.length) return chronological.slice()

  // 1) 按深度分桶（continue 时 depth 0 顺延到 1，避免插进被续写的那条之后）
  const byDepth = new Map<number, Injection[]>()
  for (const inj of inChat) {
    let d = Math.max(0, Math.floor(Number(inj.depth) || 0))
    if (opts.isContinue && d === 0) d = 1
    const list = byDepth.get(d)
    if (list) list.push(inj)
    else byDepth.set(d, [inj])
  }

  const messages = chronological.slice().reverse() // 新→旧
  let totalInserted = 0

  // 2) 只遍历真正有注入的深度（ST 是 0..10000 死循环，不要抄）
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const atDepth = byDepth.get(depth)
    if (!atDepth) continue

    const roleMessages: PromptMessage[] = []

    // 3) order 分组，**降序**（高 order 最终更贴近回复）
    const orders = [...new Set(atDepth.map((i) => i.order ?? DEFAULT_ORDER))].sort((a, b) => b - a)
    for (const order of orders) {
      const inOrder = atDepth.filter((i) => (i.order ?? DEFAULT_ORDER) === order)
      // 4) 角色顺序 [system, user, assistant]
      for (const role of ROLE_ORDER) {
        const content = inOrder
          .filter((i) => i.role === role)
          .sort((a, b) => a.key.localeCompare(b.key)) // 确定性 tiebreak
          .map((i) => i.value.trim())
          .filter((v) => v !== '')
          .join('\n') // 5) 同一 (depth,order,role) 合成一条
        if (content) {
          roleMessages.push({
            role: ROLE_NAME[role] ?? 'system',
            content,
            injected: true,
            source: `inject@${depth}`,
          })
        }
      }
    }
    if (!roleMessages.length) continue

    const idx = Math.min(depth + totalInserted, messages.length)
    messages.splice(idx, 0, ...roleMessages)
    totalInserted += roleMessages.length
  }

  messages.reverse()
  return messages
}

/**
 * 预算预留用：注入最终会产生哪些消息（不做插入）。
 *
 * 这些消息必须**先于**普通历史扣掉预算，否则长对话会把用户配置的
 * depth-0 约束提示词静默丢掉 —— 需求 4 最坏的失败模式。
 */
export function materializeInjections(
  injections: Injection[],
  opts: { isContinue?: boolean } = {},
): PromptMessage[] {
  return injectAtDepths([], injections, opts)
}
