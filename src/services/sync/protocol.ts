/**
 * 扫码同步的帧协议。
 *
 * 一条 datachannel 上混跑两种东西：控制帧是 JSON 字符串，数据帧是 ArrayBuffer。
 * `typeof ev.data === 'string'` 就能分辨，不需要额外的帧头。
 *
 * 纯类型 + 纯函数，不 import vue/pinia。
 */

import type { ImportResult, SyncScope } from '@/services/io/backup'

/** 协议版本。两端不一致时握手就要拒绝，别等传到一半才炸 */
export const PROTOCOL_VERSION = 1

export interface SyncCounts {
  characters: number
  worldbooks: number
  groups: number
  chats: number
  messages: number
  blobs: number
  rpgworlds: number
}

export interface Manifest {
  t: 'manifest'
  scope: SyncScope
  /** **压缩后**的总字节数。接收方靠它判断传完没有，进度条也按它走 */
  bytes: number
  counts: SyncCounts
  /**
   * 会话与角色的 id 清单。
   *
   * 带上它，接收方才能在确认页告诉用户「其中 3 个会话本机已存在，将被覆盖」——
   * 这是单向推送语义下唯一的冲突提示。消息不带（一个长会话几千条，id 清单比
   * 正文还大），会话级的粒度已经够用户判断了。
   */
  chatIds: string[]
  charIds: string[]
}

export type Frame =
  | { t: 'hello'; version: number }
  | Manifest
  | { t: 'accept' }
  | { t: 'reject'; reason: string }
  | { t: 'pull'; scope: SyncScope }
  | { t: 'eof' }
  | { t: 'done'; result: ImportResult }
  | { t: 'err'; message: string }

export function encodeFrame(f: Frame): string {
  return JSON.stringify(f)
}

export function decodeFrame(s: string): Frame | null {
  try {
    const v: unknown = JSON.parse(s)
    if (v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string') {
      return v as Frame
    }
  } catch {
    // 对端发来的不是我们的帧，交给调用方当协议错误处理
  }
  return null
}

export function emptyCounts(): SyncCounts {
  return { characters: 0, worldbooks: 0, groups: 0, chats: 0, messages: 0, blobs: 0, rpgworlds: 0 }
}

/** 「角色 4 · 世界书 2 · 会话 1 · 消息 17」，确认页与结果提示共用 */
export function describeCounts(c: SyncCounts & { skipped?: number }): string {
  const parts: string[] = []
  if (c.characters) parts.push(`角色 ${c.characters}`)
  if (c.worldbooks) parts.push(`世界书 ${c.worldbooks}`)
  if (c.groups) parts.push(`群聊 ${c.groups}`)
  if (c.chats) parts.push(`会话 ${c.chats}`)
  if (c.messages) parts.push(`消息 ${c.messages}`)
  if (c.blobs) parts.push(`图片 ${c.blobs}`)
  if (c.rpgworlds) parts.push(`世界 ${c.rpgworlds}`)
  const s = parts.join(' · ') || '空'
  // ⚠️ 跳过数必须跟着一起显示。同步完只报「收到 N 条」而不提「另有 M 条没进来」，
  // 用户是在几天后翻不到某段对话时才发现的 —— 那时早已无从查起。
  // 这个字段是后加的：老版本对端发来的 done 里没有它，所以按可选处理
  return c.skipped ? `${s}（另有 ${c.skipped} 行格式不对被跳过）` : s
}
