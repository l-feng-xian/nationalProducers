import { defineStore } from 'pinia'
import { computed } from 'vue'
import { useChatsStore } from './chats'
import { useCharactersStore, defaultAssistantCharacter } from './characters'
import { useGroupsStore } from './groups'
import { useSettingsStore } from './settings'
import { diffStatus, type StatusDiff } from '@/services/status/diff'
import { resolveStatusContext, type StatusContext } from '@/services/status/complete'
import { resolvePersona } from '@/types/group'
import type { Character } from '@/types/character'
import type { ChatMessage } from '@/types/chat'
import type { MessageStatus, StatusData, StatusField } from '@/types/status'

export interface StatusEntry {
  msg: ChatMessage
  status: MessageStatus
  /** 与上一份快照相比的变化；第一份没有上一份，diff 为空 */
  diff: StatusDiff
}

/**
 * 状态侧栏的只读视图：全部从 chats.messages 派生，没有自己的持久化状态。
 * 快照挂在消息上（MessageExtra.status），删 / 重新生成 / 分支天然回滚。
 */
export const useStatusStore = defineStore('status', () => {
  const chats = useChatsStore()

  const enabled = computed(() => useSettingsStore().settings.status.enabled)

  /** 按时间正序的所有快照 */
  const timeline = computed<StatusEntry[]>(() => {
    const out: StatusEntry[] = []
    let prev: StatusData | null = null
    for (const m of chats.messages) {
      const s = m.extra?.status
      if (!s?.data) continue
      out.push({ msg: m, status: s, diff: diffStatus(prev, s.data) })
      prev = s.data
    }
    return out
  })

  const current = computed<StatusEntry | null>(() => timeline.value.at(-1) ?? null)

  /**
   * 与生成链路（generation.ts statusContextFor）同一套来源：字段、必须出现的人、初始状态。
   * 两边各算各的，侧栏就会显示一套、提示词里注入另一套。
   */
  const context = computed<StatusContext | null>(() => {
    const meta = chats.current
    if (!meta) return null
    const settings = useSettingsStore().settings
    const chars = useCharactersStore()
    const g = meta.kind === 'group' ? useGroupsStore().byId(meta.groupId) : undefined
    return resolveStatusContext({
      settings: settings.status,
      messages: chats.messages,
      userName: resolvePersona(g, settings.persona).name,
      ...(g
        ? {
            members: g.members.map((id) => chars.byId(id)).filter((c): c is Character => !!c),
            groupConfig: g.status ?? null,
          }
        : { char: chars.byId(meta.characterId) ?? defaultAssistantCharacter() }),
    })
  })

  /** 还没有快照时的兜底：演绎 / 角色卡上配的初始状态 */
  const initial = computed<StatusData | null>(() =>
    context.value?.fromInitial ? context.value.current : null,
  )

  /** 侧栏编辑时用的字段模板（只含启用的） */
  const fields = computed<StatusField[]>(() => context.value?.fields ?? [])
  /** 快照里必须各有一项的人（角色们 + 用户），侧栏编辑时锁定这些名字 */
  const required = computed<string[]>(() => context.value?.required ?? [])
  const userName = computed(() => context.value?.userName ?? '')

  /**
   * 最近一轮 AI 回复没解析出状态 → 侧栏与入口按钮给警示。
   * 只看**最新的那条 AI 消息**：更早的失败已经被后面成功的快照盖过去了，不必再提。
   */
  const lastError = computed<{ msg: ChatMessage; error: string } | null>(() => {
    for (let i = chats.messages.length - 1; i >= 0; i--) {
      const m = chats.messages[i]!
      if (m.is_user || m.is_system) continue
      if (m.extra?.status) return null
      const e = m.extra?.statusError
      return typeof e === 'string' && e ? { msg: m, error: e } : null
    }
    return null
  })

  /**
   * 手改状态写到哪条消息：最后一条 AI 消息（开场白也算）。
   * 快照只会挂在 AI 消息上，所以它要么就是最新快照那条，要么在它之后（本轮解析失败）——
   * 写到更新的那条，手改版本才会成为「当前」。没有 AI 消息时返回 undefined。
   */
  const editTarget = computed<ChatMessage | undefined>(() => {
    for (let i = chats.messages.length - 1; i >= 0; i--) {
      const m = chats.messages[i]!
      if (!m.is_user && !m.is_system) return m
    }
    return undefined
  })

  async function save(data: StatusData) {
    const target = editTarget.value
    if (!target) return false
    await chats.setMessageStatus(target.id, { data, source: 'user', updatedAt: Date.now() })
    return true
  }

  return {
    enabled,
    timeline,
    current,
    initial,
    fields,
    required,
    userName,
    lastError,
    editTarget,
    save,
  }
})
