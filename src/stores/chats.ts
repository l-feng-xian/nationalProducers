import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { chatsRepo, memchunksRepo, messagesRepo } from '@/db/repositories'
import { newAiMessage, newUserMessage, type ChatMessage, type ChatMeta } from '@/types/chat'
import { fnv1a } from '@/services/hash'
import { buildMacroEnv, pickGreeting } from '@/services/prompt/builder'
import { useCharactersStore, defaultAssistantCharacter } from './characters'
import { useSettingsStore } from './settings'
import { useGroupsStore } from './groups'
import { toPlain } from '@/utils/plain'
import type { GeneratedImage } from '@/types/image'
import {
  invalidateDeletedSeq,
  invalidateFromSeq,
  remapThroughSeq,
  type InvalidateResult,
} from '@/services/memory/invalidate'
import { invalidateIndex, releaseIndex } from '@/services/memory/runtime'

export const useChatsStore = defineStore('chats', () => {
  const list = ref<ChatMeta[]>([])
  const current = ref<ChatMeta | null>(null)
  const messages = ref<ChatMessage[]>([])
  const loading = ref(false)

  const currentCharacterId = computed(() => current.value?.characterId)

  async function loadList() {
    list.value = await chatsRepo.list()
  }

  async function open(id: string) {
    loading.value = true
    try {
      const meta = await chatsRepo.get(id)
      current.value = meta ?? null
      messages.value = meta ? await messagesRepo.all(id) : []
    } finally {
      loading.value = false
    }
  }

  function close() {
    // 打包索引是 N×512 的 Float32Array，切走不放手的话连开几个长会话
    // 就能把低端机的标签页耗死
    if (current.value) releaseIndex()
    current.value = null
    messages.value = []
  }

  /** 失效结果收口：水位线变了才落盘，并让打包缓存重建 */
  async function applyInvalidation(chatId: string, res: InvalidateResult) {
    if (!res.removed) return
    if (res.state) {
      await chatsRepo.patchMetadata(chatId, { memIndex: res.state })
      await refreshMeta(chatId)
    }
    invalidateIndex(chatId)
  }

  /** 新建 1v1 会话，并随机播种一条开场白。 */
  async function createSolo(characterId: string | undefined, title: string): Promise<ChatMeta> {
    const meta = await chatsRepo.create({ kind: 'solo', title, characterId })
    meta.chat_metadata.chat_id_hash = fnv1a(meta.id)
    await chatsRepo.save(meta)
    list.value = [meta, ...list.value]

    await seedGreeting(meta, characterId)
    return meta
  }

  /**
   * 新建 1vN 群聊会话。
   * 开场白播种：**每个成员各随机一条**（对齐 ST 群聊；不生成 swipes）。
   */
  async function createGroup(groupId: string, title: string): Promise<ChatMeta> {
    const groups = useGroupsStore()
    const chars = useCharactersStore()
    const settings = useSettingsStore()
    const g = groups.byId(groupId)

    const meta = await chatsRepo.create({ kind: 'group', title, groupId })
    meta.chat_metadata.chat_id_hash = fnv1a(meta.id)
    // 关系图谱快照到会话，允许单会话微调而不影响群组模板
    if (g) {
      meta.chat_metadata.relationGraph = {
        relations: toPlain(g.relations),
        layout: toPlain(g.layout),
        relationTemplate: g.relationTemplate,
      }
    }
    await chatsRepo.save(meta)
    list.value = [meta, ...list.value]

    if (g && !meta.chat_metadata.tainted) {
      const rows: Omit<ChatMessage, 'seq'>[] = []
      for (const id of g.members) {
        const char = chars.byId(id)
        if (!char) continue
        const env = buildMacroEnv(
          {
            isGroup: true,
            // ⚠️ 必须把 g 传进去。effectivePersona 里是
            // `resolvePersona(input.isGroup ? input.group : undefined, …)` ——
            // 只给 isGroup 不给 group，群人设会被整个跳过，开场白里的 {{user}}
            // 用全局人设展开，而之后每轮生成用的却是群人设，前后对不上。
            group: g,
            speaker: { id: char.id, name: char.data.name, char },
            members: g.members
              .map((m) => chars.byId(m))
              .filter((c): c is NonNullable<typeof c> => !!c)
              .map((c) => ({ id: c.id, name: c.data.name, char: c })),
            mutedIds: g.disabled_members,
            settings: settings.settings,
            history: [],
            chatId: meta.id,
            chatIdHash: meta.chat_metadata.chat_id_hash ?? 0,
            variables: meta.chat_metadata.variables,
          },
          '',
        )
        const { picked } = pickGreeting(char, env)
        if (!picked) continue
        const msg = newAiMessage(meta.id, char.data.name, picked, { characterId: char.id })
        msg.original_avatar = char.id
        rows.push(msg)
      }
      if (rows.length) {
        const saved = await messagesRepo.appendMany(meta.id, rows)
        messages.value = saved
        await refreshMeta(meta.id)
      }
    }
    return meta
  }

  /** 开场白播种：仅当无消息且未 tainted。 */
  async function seedGreeting(meta: ChatMeta, characterId: string | undefined) {
    if (meta.messageCount > 0 || meta.chat_metadata.tainted) return
    const chars = useCharactersStore()
    const settings = useSettingsStore()
    const char = chars.byId(characterId) ?? defaultAssistantCharacter()

    const env = buildMacroEnv(
      {
        isGroup: false,
        speaker: { id: char.id, name: char.data.name, char },
        members: [{ id: char.id, name: char.data.name, char }],
        mutedIds: [],
        settings: settings.settings,
        history: [],
        chatId: meta.id,
        chatIdHash: meta.chat_metadata.chat_id_hash ?? 0,
        variables: meta.chat_metadata.variables,
      },
      '',
    )
    const { picked, pool, index } = pickGreeting(char, env)
    if (!picked) return

    const msg = newAiMessage(meta.id, char.data.name, picked, { characterId: char.id })
    msg.original_avatar = char.id
    // 1v1：整个开场白池存进 swipes，用户可左右切换（对齐 ST getFirstMessage）
    if (pool.length > 1) {
      msg.swipes = pool
      msg.swipe_id = index
      msg.swipe_info = pool.map(() => ({ send_date: msg.send_date, extra: {} }))
    }
    const row = await messagesRepo.append(meta.id, msg)
    messages.value = [row]
    await refreshMeta(meta.id)
  }

  async function refreshMeta(id: string) {
    const m = await chatsRepo.get(id)
    if (!m) return
    if (current.value?.id === id) current.value = m
    const i = list.value.findIndex((x) => x.id === id)
    if (i >= 0) list.value.splice(i, 1, m)
    // 列表按 updatedAt 倒序
    list.value = [...list.value].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async function appendUser(text: string): Promise<ChatMessage | null> {
    const meta = current.value
    if (!meta) return null
    const settings = useSettingsStore()
    const who = settings.settings.persona.name
    const row = await messagesRepo.append(meta.id, newUserMessage(meta.id, who, text))
    messages.value = [...messages.value, row]
    await refreshMeta(meta.id)
    return row
  }

  async function attachImage(chatId: string, messageId: string, image: GeneratedImage) {
    const row = await messagesRepo.attachImage(chatId, messageId, image)
    if (current.value?.id === chatId) patchLocal(messageId, { images: row.images })
  }

  async function appendAi(name: string, characterId: string): Promise<ChatMessage | null> {
    const meta = current.value
    if (!meta) return null
    const msg = newAiMessage(meta.id, name, '', { characterId })
    msg.original_avatar = characterId
    const row = await messagesRepo.append(meta.id, msg)
    messages.value = [...messages.value, row]
    return row
  }

  /** 流式期间只改内存，结束时才落盘（避免每个 token 一次 IDB 写） */
  function patchLocal(id: string, patch: Partial<ChatMessage>) {
    const i = messages.value.findIndex((m) => m.id === id)
    if (i < 0) return
    const cur = messages.value[i]
    if (!cur) return
    messages.value.splice(i, 1, { ...cur, ...patch })
  }

  async function persist(id: string) {
    const row = messages.value.find((m) => m.id === id)
    if (row) await messagesRepo.update(row)
  }

  /** 按指定会话写回生成结果，避免用户切换会话后丢失回复。 */
  async function writeRow(chatId: string, row: ChatMessage, patch: Partial<ChatMessage>) {
    await messagesRepo.update({ ...row, ...patch })
    if (current.value?.id === chatId) {
      patchLocal(row.id, patch)
      await refreshMeta(chatId)
    }
  }

  /**
   * 删掉**指定会话**里的某一条（生成失败时清掉空占位）。
   *
   * ⚠️ 同样不能用 removeTail：它按 `current.value` 取会话，用户切走之后
   * 删的是**别人**的最后一条 —— 用户正在读的那段对话会凭空少一句，不可撤销。
   */
  async function removeRowFrom(chatId: string, row: ChatMessage) {
    await messagesRepo.remove(chatId, row.seq)
    if (current.value?.id === chatId) {
      messages.value = messages.value.filter((m) => m.id !== row.id)
      await refreshMeta(chatId)
    }
  }

  async function markTainted() {
    const meta = current.value
    if (!meta || meta.chat_metadata.tainted) return
    meta.chat_metadata.tainted = true
    await chatsRepo.patchMetadata(meta.id, { tainted: true })
  }

  async function removeChat(id: string) {
    // 向量块由 chatsRepo.remove 在同一事务里删掉
    await chatsRepo.remove(id)
    invalidateIndex(id)
    list.value = list.value.filter((c) => c.id !== id)
    if (current.value?.id === id) close()
  }

  /** 删除末尾 n 条（重新生成用） */
  async function removeTail(n: number) {
    const meta = current.value
    if (!meta) return
    const from = messages.value[Math.max(0, messages.value.length - n)]
    await messagesRepo.removeTail(meta.id, n)
    messages.value = messages.value.slice(0, Math.max(0, messages.value.length - n))
    await refreshMeta(meta.id)
    if (from) {
      await applyInvalidation(
        meta.id,
        await invalidateFromSeq(meta.id, from.seq, meta.chat_metadata.memIndex),
      )
    }
  }

  /** 编辑某条消息的正文；若它有 swipes，同步更新当前那一条 */
  async function editMessage(id: string, text: string) {
    const row = messages.value.find((m) => m.id === id)
    if (!row) return
    const patch: Partial<ChatMessage> = { mes: text }
    if (row.swipes?.length) {
      const swipes = [...row.swipes]
      swipes[row.swipe_id ?? 0] = text
      patch.swipes = swipes
    }
    patchLocal(id, patch)
    await persist(id)

    // 正文变了：这条之后的索引整段作废重建，新正文才进得来
    const meta = current.value
    if (meta) {
      await applyInvalidation(
        meta.id,
        await invalidateFromSeq(meta.id, row.seq, meta.chat_metadata.memIndex),
      )
    }
  }

  /** 删除单条消息 */
  async function deleteMessage(id: string) {
    const meta = current.value
    const row = messages.value.find((m) => m.id === id)
    if (!meta || !row) return
    await messagesRepo.remove(meta.id, row.seq)
    messages.value = messages.value.filter((m) => m.id !== id)
    await refreshMeta(meta.id)
    await applyInvalidation(
      meta.id,
      await invalidateDeletedSeq(meta.id, row.seq, meta.chat_metadata.memIndex),
    )
  }

  /** 删除该条及其之后的全部消息 */
  async function deleteFrom(id: string) {
    const meta = current.value
    const row = messages.value.find((m) => m.id === id)
    if (!meta || !row) return
    await messagesRepo.removeFrom(meta.id, row.seq)
    const i = messages.value.findIndex((m) => m.id === id)
    if (i >= 0) messages.value = messages.value.slice(0, i)
    await refreshMeta(meta.id)
    await applyInvalidation(
      meta.id,
      await invalidateFromSeq(meta.id, row.seq, meta.chat_metadata.memIndex),
    )
  }

  /**
   * 从某条消息处分支出一个新会话：复制到该条为止的历史。
   * 定时效果与变量一并带过去，否则新分支的世界书状态会莫名重置。
   */
  async function branchFrom(id: string): Promise<ChatMeta | null> {
    const meta = current.value
    const row = messages.value.find((m) => m.id === id)
    if (!meta || !row) return null

    const init: Parameters<typeof chatsRepo.create>[0] = {
      kind: meta.kind,
      title: `${meta.title}（分支）`,
    }
    if (meta.characterId !== undefined) init.characterId = meta.characterId
    if (meta.groupId !== undefined) init.groupId = meta.groupId
    const next = await chatsRepo.create(init)

    next.parentChatId = meta.id
    next.branchFromSeq = row.seq
    next.chat_metadata = toPlain(meta.chat_metadata)
    // {{pick}} 种子继承，分支里的随机选择保持一致
    next.chat_metadata.chat_id_hash = meta.chat_metadata.chat_id_hash ?? fnv1a(meta.id)
    await chatsRepo.save(next)

    const seqMap = await messagesRepo.copyUpTo(meta.id, next.id, row.seq)

    // 新会话是重新取号的，一切按 seq 索引的旁路数据都得跟着平移，
    // 否则失效逻辑会在错误的位置开刀（「改了第 30 条，第 80 条的记忆没了」）
    const memIndex = next.chat_metadata.memIndex
    if (memIndex) {
      const copied = await memchunksRepo.copyRemapped(meta.id, next.id, seqMap)
      if (copied) {
        memIndex.throughSeq = remapThroughSeq(memIndex.throughSeq, seqMap)
      } else {
        delete next.chat_metadata.memIndex
      }
    }
    const card = next.chat_metadata.stateCard
    if (card) card.throughSeq = remapThroughSeq(card.throughSeq, seqMap)
    await chatsRepo.save(next)

    const saved = await chatsRepo.get(next.id)
    if (saved) list.value = [saved, ...list.value]
    return saved ?? next
  }

  async function rename(id: string, title: string) {
    await chatsRepo.rename(id, title)
    await refreshMeta(id)
  }

  return {
    list,
    current,
    messages,
    loading,
    currentCharacterId,
    loadList,
    open,
    close,
    createSolo,
    createGroup,
    appendUser,
    attachImage,
    appendAi,
    patchLocal,
    persist,
    writeRow,
    removeRowFrom,
    markTainted,
    removeChat,
    removeTail,
    editMessage,
    deleteMessage,
    deleteFrom,
    branchFrom,
    rename,
    refreshMeta,
  }
})
