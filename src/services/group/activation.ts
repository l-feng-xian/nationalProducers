/**
 * 群聊发言者选择。对齐 SillyTavern group-chats.js 的四种策略。
 *
 * 纯函数：把 members / chat / characters 都作为参数传入，
 * 不像 ST 那样读全局 this_chid（那正是「生成之外 {{char}} 为空」那类坑的来源）。
 */

import { group_activation_strategy, type Group, type GroupActivationStrategy } from '@/types/group'
import { talkativenessOf, type Character } from '@/types/character'
import type { ChatMessage } from '@/types/chat'

export interface ActivationInput {
  group: Group
  /** id → 角色 */
  charById: Map<string, Character>
  /** 旧→新时序 */
  chat: ChatMessage[]
  /** 本轮是否由用户输入触发（自动模式为 false） */
  isUserInput: boolean
  /** 用户刚输入的文本，用于提名检测 */
  activationText: string
}

function shuffle<T>(list: T[]): T[] {
  const a = [...list]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const x = a[i]
    const y = a[j]
    if (x === undefined || y === undefined) continue
    a[i] = y
    a[j] = x
  }
  return a
}

/** 小写分词，用于提名检测 */
function extractAllWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * 中文名字没有空格分词，`extractAllWords` 对中文只会切出整段。
 * 因此提名检测再补一条：名字作为子串出现即算提名。
 */
function mentions(text: string, name: string): boolean {
  if (!name) return false
  const lower = text.toLowerCase()
  if (lower.includes(name.toLowerCase())) return true
  const words = extractAllWords(text)
  return extractAllWords(name).some((w) => words.includes(w))
}

const enabled = (g: Group) => g.members.filter((m) => !g.disabled_members.includes(m))

/**
 * 用户消息里被「@名字」显式点名的成员，按 @ 在文中出现的先后排序、去重。
 *
 * 与输入框的 @ 选择列表同一套规则：@ 前面不能紧挨字母数字（避开邮箱 a@b.com）。
 * 同一个 @ 后面能对上多个名字时取**最长**的（「白夜」不会被误认成「白」）。
 * 静音成员也算：@ 是用户的明确点名，和点名条一样不受静音限制。
 */
export function explicitMentions(
  text: string,
  group: Group,
  charById: Map<string, Character>,
): string[] {
  if (!text.includes('@')) return []
  const lower = text.toLowerCase()
  const candidates = group.members
    .map((id) => ({ id, name: charById.get(id)?.data.name.toLowerCase() ?? '' }))
    .filter((c) => c.name)
    .sort((a, b) => b.name.length - a.name.length)
  const hits: string[] = []
  for (let i = lower.indexOf('@'); i !== -1; i = lower.indexOf('@', i + 1)) {
    if (i > 0 && /[A-Za-z0-9_]/.test(lower[i - 1] ?? '')) continue
    const hit = candidates.find((c) => lower.startsWith(c.name, i + 1))
    if (hit && !hits.includes(hit.id)) hits.push(hit.id)
  }
  return hits
}

/** 自然顺序：提名优先 + 按 talkativeness 掷骰，可能多人发言 */
export function activateNaturalOrder(input: ActivationInput): string[] {
  const { group, charById, chat, isUserInput, activationText } = input
  const members = enabled(group)
  const last = chat[chat.length - 1]

  // 防止同一角色连续发言；但用户刚说完话时不设限
  let banned: string | undefined
  if (!isUserInput && last && !last.is_user) banned = last.name
  if (group.allow_self_responses) banned = undefined

  const activated: string[] = []

  // ① 提名检测（优先且可叠加）
  if (activationText) {
    for (const id of members) {
      const c = charById.get(id)
      if (!c || c.data.name === banned) continue
      if (mentions(activationText, c.data.name)) activated.push(id)
    }
  }

  // ② talkativeness 掷骰（打乱顺序）
  const chatty: string[] = []
  for (const id of shuffle(members)) {
    const c = charById.get(id)
    if (!c || c.data.name === banned) continue
    const t = talkativenessOf(c)
    if (t >= Math.random()) activated.push(id)
    if (t > 0) chatty.push(id)
  }

  // ③ 一个都没选中时兜底随机挑一个（优先从愿意说话的里面挑）
  const pool = chatty.length ? chatty : members
  if (!activated.length && pool.length) {
    const pick = pool[Math.floor(Math.random() * pool.length)]
    if (pick) activated.push(pick)
  }

  return [...new Set(activated)]
}

/** 列表顺序：每个启用成员各发言一次，严格按 members 顺序 */
export function activateListOrder(group: Group): string[] {
  return [...new Set(enabled(group))]
}

/** 轮流：优先从「本轮用户发言后还没说过话的人」里随机挑一个 */
export function activatePooledOrder(input: ActivationInput): string[] {
  const { group, chat, isUserInput } = input
  const members = enabled(group)
  if (!members.length) return []

  const spokenSinceUser: string[] = []
  if (!isUserInput) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i]
      if (!m) continue
      if (m.is_user) break
      if (m.is_system) continue
      if (m.original_avatar) spokenSinceUser.push(m.original_avatar)
    }
  }

  const haveNot = members.filter((x) => !spokenSinceUser.includes(x))
  if (haveNot.length) {
    const pick = haveNot[Math.floor(Math.random() * haveNot.length)]
    return pick ? [pick] : []
  }

  // 都说过了 → 随机挑一个（排除上一个发言者）
  const last = chat[chat.length - 1]
  const lastAvatar = members.length > 1 && last && !last.is_user ? last.original_avatar : undefined
  const pool = lastAvatar ? members.filter((x) => x !== lastAvatar) : members
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return pick ? [pick] : []
}

/** 手动：用户输入时不自动回复；非用户触发时随机一人 */
export function activateManual(input: ActivationInput): string[] {
  if (input.isUserInput) return []
  const members = enabled(input.group)
  const pick = shuffle(members)[0]
  return pick ? [pick] : []
}

function activateByStrategy(input: ActivationInput): string[] {
  const strategy: GroupActivationStrategy = input.group.activation_strategy
  switch (strategy) {
    case group_activation_strategy.LIST:
      return activateListOrder(input.group)
    case group_activation_strategy.POOLED:
      return activatePooledOrder(input)
    case group_activation_strategy.MANUAL:
      return activateManual(input)
    case group_activation_strategy.NATURAL:
    default:
      return activateNaturalOrder(input)
  }
}

/**
 * 统一入口。forceId 优先（点名 / 重新生成指定角色）。
 *
 * 用户消息里有「@名字」时，被 @ 的人**先**发言（按 @ 的先后）：
 * - 自然 / 列表：被 @ 的人排到最前，其余照原策略接在后面（同一人不重复）；
 * - 轮流 / 手动：本来一轮只有一人或无人回复，这一轮改成**只**由被 @ 的人回复。
 */
export function selectSpeakers(input: ActivationInput, forceId?: string): string[] {
  if (forceId) return [forceId]
  const mentioned = input.isUserInput
    ? explicitMentions(input.activationText, input.group, input.charById)
    : []
  if (!mentioned.length) return activateByStrategy(input)
  const strategy = input.group.activation_strategy
  if (
    strategy === group_activation_strategy.POOLED ||
    strategy === group_activation_strategy.MANUAL
  )
    return mentioned
  return [...new Set([...mentioned, ...activateByStrategy(input)])]
}
