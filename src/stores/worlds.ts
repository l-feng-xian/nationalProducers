import { defineStore } from 'pinia'
import { ref } from 'vue'
import { worldbooksRepo } from '@/db/repositories'
import type { WorldBook, WorldInfoEntry } from '@/types/worldinfo'
import type { LoreSources } from '@/services/worldinfo/sources'
import { useCharactersStore } from './characters'
import { useGroupsStore } from './groups'
import { useSettingsStore } from './settings'

export const useWorldsStore = defineStore('worlds', () => {
  const items = ref<WorldBook[]>([])
  const loaded = ref(false)

  async function load() {
    items.value = await worldbooksRepo.list()
    loaded.value = true
  }

  function byId(id: string | undefined): WorldBook | undefined {
    if (!id) return undefined
    return items.value.find((b) => b.id === id)
  }

  function byIds(ids: string[]): WorldBook[] {
    return ids.map((id) => byId(id)).filter((b): b is WorldBook => !!b)
  }

  async function create(name = '新世界书'): Promise<WorldBook> {
    const b = await worldbooksRepo.create(name)
    items.value = [b, ...items.value]
    return b
  }

  async function save(b: WorldBook): Promise<void> {
    await worldbooksRepo.save(b)
    const i = items.value.findIndex((x) => x.id === b.id)
    if (i >= 0) items.value.splice(i, 1, b)
  }

  async function addEntry(bookId: string): Promise<WorldInfoEntry | undefined> {
    const entry = await worldbooksRepo.addEntry(bookId)
    if (entry) {
      const b = byId(bookId)
      if (b) b.entries[String(entry.uid)] = entry
    }
    return entry
  }

  async function upsertEntry(bookId: string, entry: WorldInfoEntry): Promise<void> {
    await worldbooksRepo.upsertEntry(bookId, entry)
    const b = byId(bookId)
    if (b) b.entries[String(entry.uid)] = entry
  }

  async function removeEntry(bookId: string, uid: number): Promise<void> {
    await worldbooksRepo.removeEntry(bookId, uid)
    const b = byId(bookId)
    if (b) delete b.entries[String(uid)]
  }

  async function remove(id: string): Promise<void> {
    await worldbooksRepo.remove(id)
    items.value = items.value.filter((b) => b.id !== id)
    const settings = useSettingsStore().settings
    settings.worldInfo.globalBookIds = settings.worldInfo.globalBookIds.filter((bookId) => bookId !== id)
    const chars = useCharactersStore()
    for (const char of chars.items) {
      char.worldBookIds = char.worldBookIds.filter((bookId) => bookId !== id)
      if (char.worldBookId === id) delete char.worldBookId
    }
    const groups = useGroupsStore()
    for (const group of groups.items) if (group.worldBookId === id) delete group.worldBookId
  }

  /**
   * 汇总本轮生效的世界书来源。
   * 需求 5：全局世界书只在全局配置里启用；角色世界书与角色关联。
   */
  function resolveSources(opts: {
    globalBookIds: string[]
    characterBookIds?: string[]
    chatBookId?: string | undefined
    personaBookId?: string | undefined
  }): LoreSources {
    return {
      global: byIds(opts.globalBookIds),
      character: byIds(opts.characterBookIds ?? []),
      chat: opts.chatBookId ? byIds([opts.chatBookId]) : [],
      persona: opts.personaBookId ? byIds([opts.personaBookId]) : [],
    }
  }

  return {
    items,
    loaded,
    load,
    byId,
    byIds,
    create,
    save,
    addEntry,
    upsertEntry,
    removeEntry,
    remove,
    resolveSources,
  }
})
