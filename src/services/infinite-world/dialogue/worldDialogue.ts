/**
 * 世界对话：把「此刻的世界 + 这位居民 + 你俩的关系」组装成给模型的提示词。
 *
 * ## 为什么自成一路，不接主聊天管线
 * 主聊天的 `buildChatPrompt` 是**同步**的，且有硬约束「普通会话提示词逐字不变」。
 * 世界对话是即时的、上下文完全不同的一段临时交谈，走独立组装 + 直连 provider，
 * 于是**结构上不可能**动到普通会话的提示词 —— 那条不变性无需验证即成立。
 *
 * 纯 service：不 import three/vue/pinia。
 */

import type { ChatMessageParam } from '@/types/provider'
import type { GameWorld, NpcBlueprint, WorldSave } from '@/types/infiniteWorld'
import { USER_NODE_ID } from '@/types/group'

export interface WorldMoment {
  day: number
  minute: number
  weather: WorldSave['weather']
}

/** 一条对话消息（面板本地保存，不进 IndexedDB） */
export interface DialogueMessage {
  role: 'user' | 'assistant'
  text: string
}

const WEATHER_LABEL: Record<WorldSave['weather'], string> = {
  clear: '晴',
  rain: '雨',
  storm: '风雨',
}

function hhmm(minute: number): string {
  const m = ((Math.floor(minute) % 1440) + 1440) % 1440
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')
}

/** {{user}} / {{char}} 替换（世界对话只用得到这两个） */
function sub(text: string, userName: string, charName: string): string {
  return text
    .replace(/\{\{\s*user\s*\}\}/gi, userName)
    .replace(/\{\{\s*char\s*\}\}/gi, charName)
}

/**
 * 你与这位居民的关系，人格化成一行。
 *
 * ⚠️ 数值必须人格化（`亲近(+42) 信任70`），不能给裸数字 —— 模型拿到裸 42
 * 会自己编量表，同一个数在不同回合被解读成完全不同的态度。
 * 没有关系记录则返回「初次见面」。
 */
export function renderRelationLine(world: GameWorld, npc: NpcBlueprint): string {
  const rel = world.relations.find(
    (r) =>
      (r.from === USER_NODE_ID && r.to === npc.npcId) ||
      (r.from === npc.npcId && r.to === USER_NODE_ID),
  )
  if (!rel) return `你与${npc.name}还是初次见面。`
  const label = rel.label.trim() || '相识'
  const score = rel.score
  const scoreWord =
    score >= 60 ? '亲密' : score >= 20 ? '亲近' : score > -20 ? '平常' : score > -60 ? '疏远' : '敌对'
  const sign = score >= 0 ? '+' : ''
  const descPart = rel.desc?.trim() ? `（${rel.desc.trim()}）` : ''
  return `你与${npc.name}的关系：${label}${descPart}，此刻${scoreWord}（好感 ${sign}${score}，信任 ${rel.trust}）。`
}

/** NPC 人设：优先用角色卡快照，退而用职业兜底 */
function personaOf(npc: NpcBlueprint, userName: string): string {
  const card = npc.cardSnapshot
  const parts: string[] = []
  if (card) {
    if (card.description?.trim()) parts.push(sub(card.description.trim(), userName, npc.name))
    if (card.personality?.trim()) parts.push('性格：' + sub(card.personality.trim(), userName, npc.name))
    if (card.scenario?.trim()) parts.push('情境：' + sub(card.scenario.trim(), userName, npc.name))
  }
  if (parts.length === 0) {
    parts.push(`${npc.name}是这片土地上的${npc.profession || '居民'}，性情随和，过着安稳的日子。`)
  }
  return parts.join('\n')
}

export interface BuildDialogueInput {
  npc: NpcBlueprint
  world: GameWorld
  moment: WorldMoment
  history: DialogueMessage[]
}

/**
 * 组装给模型的消息序列。
 *   system  = 【此刻】世界上下文 + 关系 + 扮演指令 + NPC 人设
 *   然后是开场白（first_mes 作为第一条 assistant）+ 历史
 */
export function buildDialogueMessages(input: BuildDialogueInput): ChatMessageParam[] {
  const { npc, world, moment } = input
  const player = world.player
  const userName = player.name || '旅行者'

  const context = [
    '【此刻】',
    `这里是《${world.name}》。${world.lore.premise}`.trim(),
    world.lore.geography?.trim() ? world.lore.geography.trim() : '',
    `现在是第 ${moment.day} 天 ${hhmm(moment.minute)}，天气${WEATHER_LABEL[moment.weather]}。`,
    `${userName}${player.identity ? `（${player.identity}）` : ''}走到你面前想和你聊聊。`,
    renderRelationLine(world, npc),
  ]
    .filter(Boolean)
    .join('\n')

  const instruction =
    `请始终以${npc.name}的身份，用第一人称、贴合上述性格与心境，自然地和${userName}交谈。` +
    `只输出${npc.name}的话语与神态动作，不要替${userName}发言或旁白，回复简短口语化。`

  const system = [context, '', `【你的身份：${npc.name}】`, personaOf(npc, userName), '', instruction].join('\n')

  const messages: ChatMessageParam[] = [{ role: 'system', content: system }]

  // 开场白：卡片 first_mes（若有），只在还没聊过时作为第一句
  const greeting = npc.cardSnapshot?.first_mes?.trim()
  if (greeting && input.history.length === 0) {
    messages.push({ role: 'assistant', content: sub(greeting, userName, npc.name) })
  }
  for (const m of input.history) {
    messages.push({ role: m.role, content: m.text })
  }
  return messages
}

/** 开场白文本（面板初始化时显示为第一条），没有则给个默认 */
export function openingLine(npc: NpcBlueprint, userName: string): string {
  const g = npc.cardSnapshot?.first_mes?.trim()
  if (g) return sub(g, userName, npc.name)
  return `（${npc.name}抬起头，朝你笑了笑）欸，${userName}，今天怎么有空过来？`
}
