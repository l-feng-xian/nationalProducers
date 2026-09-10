import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { chatsRepo, messagesRepo } from '@/db/repositories'
import { newAiMessage, newUserMessage, type ChatMessage, type ChatMeta } from '@/types/chat'
import { fnv1a } from '@/services/hash'
import { buildMacroEnv, pickGreeting } from '@/services/prompt/builder'
import { useCharactersStore, defaultAssistantCharacter } from './characters'
import { useSettingsStore } from './settings'

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
    current.value = null
    messages.value = []
  }

  /** 新建 1v1 会话，并按需求 2 随机播种一条开场白 */
  async function createSolo(characterId: string | undefined, title: string): Promise<ChatMeta> {
    const meta = await chatsRepo.create({ kind: 'solo', title, characterId })
    meta.chat_metadata.chat_id_hash = fnv1a(meta.id)
    await chatsRepo.save(meta)
    list.value = [meta, ...list.value]

    await seedGreeting(meta, characterId)
    return meta
  }

  /** 开场白播种：仅当无消息且未 tainted */
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
    const row = await messagesRepo.append(
      meta.id,
      newUserMessage(meta.id, settings.settings.persona.name, text),
    )
    messages.value = [...messages.value, row]
    await refreshMeta(meta.id)
    return row
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

  async function markTainted() {
    const meta = current.value
    if (!meta || meta.chat_metadata.tainted) return
    meta.chat_metadata.tainted = true
    await chatsRepo.patchMetadata(meta.id, { tainted: true })
  }

  async function removeChat(id: string) {
    await chatsRepo.remove(id)
    list.value = list.value.filter((c) => c.id !== id)
    if (current.value?.id === id) close()
  }

  /** 删除末尾 n 条（重新生成用） */
  async function removeTail(n: number) {
    const meta = current.value
    if (!meta) return
    await messagesRepo.removeTail(meta.id, n)
    messages.value = messages.value.slice(0, Math.max(0, messages.value.length - n))
    await refreshMeta(meta.id)
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
    appendUser,
    appendAi,
    patchLocal,
    persist,
    markTainted,
    removeChat,
    removeTail,
    rename,
    refreshMeta,
  }
})
