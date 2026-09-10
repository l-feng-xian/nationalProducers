/**
 * 会话与消息类型。消息字段沿用 SillyTavern 原生命名，便于对照与将来导入 ST 聊天记录。
 */

import type { GroupRelation, GroupNodeLayout } from './group'

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
