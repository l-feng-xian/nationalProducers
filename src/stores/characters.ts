import { defineStore } from 'pinia'
import { ref } from 'vue'
import { charactersRepo } from '@/db/repositories'
import { emptyCharacter, type Character } from '@/types/character'

/** 未选择角色时的兜底「助手」，让 1v1 聊天在没建角色前也能跑通 */
export function defaultAssistantCharacter(): Character {
  const c = emptyCharacter('__assistant__', '助手')
  c.data.description = '一个乐于助人的 AI 助手。'
  return c
}

export const useCharactersStore = defineStore('characters', () => {
  const items = ref<Character[]>([])
  const loaded = ref(false)

  async function load() {
    items.value = await charactersRepo.list()
    loaded.value = true
  }

  function byId(id: string | undefined): Character | undefined {
    if (!id) return undefined
    return items.value.find((c) => c.id === id)
  }

  async function create(name = '新角色'): Promise<Character> {
    const c = await charactersRepo.create(name)
    items.value = [c, ...items.value]
    return c
  }

  async function save(c: Character): Promise<void> {
    const saved = await charactersRepo.save(c)
    const i = items.value.findIndex((x) => x.id === saved.id)
    if (i >= 0) items.value.splice(i, 1, saved)
    else items.value = [saved, ...items.value]
  }

  async function remove(id: string): Promise<void> {
    await charactersRepo.remove(id)
    items.value = items.value.filter((c) => c.id !== id)
  }

  return { items, loaded, load, byId, create, save, remove }
})
