import { defineStore } from 'pinia'
import { ref } from 'vue'
import { groupsRepo } from '@/db/repositories'
import { emptyGroup, type Group, type GroupNodeLayout, type GroupRelation } from '@/types/group'

export const useGroupsStore = defineStore('groups', () => {
  const items = ref<Group[]>([])
  const loaded = ref(false)

  async function load() {
    items.value = await groupsRepo.list()
    loaded.value = true
  }

  function byId(id: string | undefined): Group | undefined {
    if (!id) return undefined
    return items.value.find((g) => g.id === id)
  }

  async function create(name = '新演绎'): Promise<Group> {
    const g = await groupsRepo.create(name)
    items.value = [g, ...items.value]
    return g
  }

  async function save(g: Group): Promise<void> {
    await groupsRepo.save(g)
    const i = items.value.findIndex((x) => x.id === g.id)
    if (i >= 0) items.value.splice(i, 1, g)
    else items.value = [g, ...items.value]
  }

  async function remove(id: string): Promise<void> {
    await groupsRepo.remove(id)
    items.value = items.value.filter((g) => g.id !== id)
  }

  function newRelation(from: string, to: string, label = ''): GroupRelation {
    return { id: crypto.randomUUID(), from, to, label }
  }

  function emptyLayout(): Record<string, GroupNodeLayout> {
    return {}
  }

  return { items, loaded, load, byId, create, save, remove, newRelation, emptyLayout, emptyGroup }
})
