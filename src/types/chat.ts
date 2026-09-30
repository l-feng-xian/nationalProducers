/**
 * 会话与消息类型。消息字段沿用 SillyTavern 原生命名，便于对照与将来导入 ST 聊天记录。
 */

import type { FlowState } from './flow'

import type { GroupRelation, GroupNodeLayout } from './group'
import type { MessageImage } from './image'
import type { MessageStatus } from './status'

export interface MessageExtra {
  /** 一次多发言人批次的批号 → 支持「重掷整批」 */
  gen_id?: number
  model?: string
  reasoning?: string
  token_count?: number
  /** 冗余存一份，避免靠 name 反查角色 */
  characterId?: string
  duration?: number
  /** 是否被用户中断 */
  stopped?: boolean
  /** 本轮随回复输出的角色状态快照（见 types/status.ts） */
  status?: MessageStatus
  /** 本轮应输出状态但没解析出来的原因；此时「当前状态」沿用上一份 */
  statusError?: string
  /** 服务端报告的用量；cached = 命中前缀缓存的输入 token（服务端没报则缺省） */
  usage?: { prompt: number; completion: number; cached?: number }
  /** 流程控制运行态（见 types/flow.ts）；固定台词消息上标 flowSay */
  flow?: FlowState
  flowSay?: boolean
  [k: string]: unknown
}

export interface SwipeInfo {
  send_date: number
  gen_started?: number
  gen_finished?: number
  extra: MessageExtra
}

export interface ChatMessage {
  // ── 复合主键 [chatId, seq] ──
  chatId: string
  /** 由 ChatMeta.nextSeq 在**同一 IDB 事务内**分配，保证追加 O(1) 且有序 */
  seq: number
  /** crypto.randomUUID()，用于 by_msgId 索引与 v-for :key */
  id: string
  // ── ST 原生字段名 ──
  name: string
  is_user: boolean
  is_system: boolean
  /** 从提示词中排除但仍在 UI 显示（眼睛图标） */
  exclude?: boolean
  mes: string
  send_date: number
  /** 多次生成的候选（开场白池也存这里） */
  swipes?: string[]
  swipe_id?: number
  swipe_info?: SwipeInfo[]
  extra: MessageExtra
  /** 权威的「谁说的」。ST 用 avatar 文件名，这里存 characterId */
  original_avatar?: string
  /** blobs store id */
  force_avatar?: string
  /** 独立图片附件，保留消息正文与 swipe；图片不作为文本提示词发送。 */
  images?: MessageImage[]
}

/** 定时效果的一条记录。key = `${bookId}.${uid}` */
export interface TimedEffect {
  hash: number
  start: number
  end: number
  protected: boolean
}

export interface TimedWorldInfo {
  sticky: Record<string, TimedEffect>
  cooldown: Record<string, TimedEffect>
}

/** 关系图谱快照（1vN 会话级，从 Group 复制而来，允许单会话微调） */
export interface RelationGraphSnapshot {
  relations: GroupRelation[]
  layout: Record<string, GroupNodeLayout>
  relationTemplate: string
}

export interface ChatMetadata {
  /** 世界书定时效果状态。替代 ST 的 chat_metadata.timedWorldInfo */
  timedWorldInfo: TimedWorldInfo
  /** {{setvar}} / {{getvar}} 的会话作用域变量 */
  variables: Record<string, string>
  /** 只有 tainted=false 且无消息时才播种开场白 */
  tainted: boolean
  /** 会话级覆盖 */
  scenario?: string
  mes_example?: string
  /** 会话专属世界书（优先级最高层） */
  worldBookId?: string
  /** {{pick}} 的稳定种子，分支后继承 */
  chat_id_hash?: number
  /** 1vN 关系图谱 */
  relationGraph?: RelationGraphSnapshot
  /** 会话记忆 · 状态卡 */
  stateCard?: StateCard
  /** 会话记忆 · 向量索引水位线（二期） */
  memIndex?: MemIndexState
  /**
   * 历史截断起点：提示词里的聊天历史从 seq >= 此值的第一条开始。
   * 超预算时一次性前移一大段，之后保持不动，让连续多轮的前缀完全一致、命中缓存。
   * 见 services/prompt/budget.ts 的 `fitWithinBudget`。缺省 = 从头开始。
   */
  historyStartSeq?: number
}

/** 向量索引的进度。换模型时整会话作废重建 */
export interface MemIndexState {
  throughSeq: number
  chunks: number
  model: string
  dim: number
}

/**
 * 会话记忆的「状态卡」。
 *
 * 一段由模型**每次整体重写**（而非追加）的现在时快照，描述「此刻是什么样」：
 * 关系到了哪一步、身处何地、在做什么、有什么未了结的事。
 *
 * 整体重写是它不会无限膨胀的唯一原因，也是它能表达「某件事已经不成立了」的原因 ——
 * 这一点是任何检索式记忆（关键词或向量）都做不到的：检索只会把过去的片段原样捞回来，
 * 哪怕那句话早已被后续剧情推翻。
 */
export interface StateCard {
  /** 正文。空串表示还没提炼出任何东西 */
  text: string
  /** 上次提炼覆盖到的最大 seq。下次从这之后的消息开始读 */
  throughSeq: number
  updatedAt: number
  /** 连续失败次数。>0 时 UI 要让用户看见，否则「记忆悄悄停摆」无从察觉 */
  failures?: number
  /** 最后一次失败原因，给 UI 显示 */
  lastError?: string
}

export interface ChatMeta {
  id: string
  kind: 'solo' | 'group'
  characterId?: string
  groupId?: string
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number
  /** 冗余计数，避免侧栏渲染时 count() */
  messageCount: number
  /** append 时取号自增，与写消息在同一事务 */
  nextSeq: number
  chat_metadata: ChatMetadata
  // ── 分支 ──
  parentChatId?: string
  branchFromSeq?: number
}

export function newChatMetadata(): ChatMetadata {
  return {
    timedWorldInfo: { sticky: {}, cooldown: {} },
    variables: {},
    tainted: false,
  }
}

export function newUserMessage(
  chatId: string,
  name: string,
  mes: string,
): Omit<ChatMessage, 'seq'> {
  return {
    chatId,
    id: crypto.randomUUID(),
    name,
    is_user: true,
    is_system: false,
    mes,
    send_date: Date.now(),
    extra: {},
  }
}

export function newAiMessage(
  chatId: string,
  name: string,
  mes = '',
  extra: MessageExtra = {},
): Omit<ChatMessage, 'seq'> {
  return {
    chatId,
    id: crypto.randomUUID(),
    name,
    is_user: false,
    is_system: false,
    mes,
    send_date: Date.now(),
    extra,
  }
}
