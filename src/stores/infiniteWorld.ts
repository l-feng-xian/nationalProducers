import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { gameworldsRepo } from '@/db/repositories'
import { emptyWorld, type GameWorld, type WorldSave } from '@/types/infiniteWorld'
import { generateTerrainPreview } from '@/services/infinite-world/generation/terrain'

export const useInfiniteWorldStore = defineStore('infiniteWorld', () => {
  const items = ref<GameWorld[]>([])
  const active = ref<GameWorld | null>(null)
  const save = ref<WorldSave | null>(null)
  const loaded = ref(false)
  const preview = computed(() => (active.value ? generateTerrainPreview(active.value) : null))

  async function load() {
    items.value = await gameworldsRepo.list()
    loaded.value = true
  }

  function draft(): GameWorld {
    return emptyWorld()
  }

  async function create(world: GameWorld) {
    const result = await gameworldsRepo.create(world)
    items.value = [result.world, ...items.value.filter((item) => item.id !== result.world.id)]
    active.value = result.world
    save.value = result.save
    return result
  }

  async function open(id: string) {
    active.value = null
    save.value = null
    const world = await gameworldsRepo.get(id)
    if (!world) return undefined
    active.value = world
    save.value = await gameworldsRepo.getSave(id) ?? null
    return world
  }

  async function persist(world: GameWorld) {
    const result = await gameworldsRepo.save(world)
    const i = items.value.findIndex((item) => item.id === world.id)
    if (i >= 0) items.value.splice(i, 1, result.world)
    active.value = result.world
    save.value = result.save
    return result
  }

  async function remove(id: string) {
    await gameworldsRepo.remove(id)
    items.value = items.value.filter((item) => item.id !== id)
    if (active.value?.id === id) {
      active.value = null
      save.value = null
    }
  }

  return { items, active, save, loaded, preview, load, draft, create, open, persist, remove }
})
