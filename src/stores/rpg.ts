/**
 * RPG 模块的响应式状态。
 *
 * ⚠️ 名字刻意叫 `rpg` 而不是 `worlds` —— `stores/worlds.ts` 已经是**世界书**
 * 的 store（useWorldsStore），同名会让 import 与 devtools 都分不清。
 *
 * 引擎本身（rAF、渲染、碰撞）不在这里，它是纯 TS 的 services/rpg/engine.ts；
 * 这里只放「列表、当前世界、对话态」这些要驱动 UI 的东西。
 */

import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { rpgWorldsRepo } from '@/db/repositories'
import { resolveNpc, type RpgNpc, type RpgWorld } from '@/types/rpg'
import { fnv1a } from '@/services/hash'
import { useCharactersStore } from './characters'

export interface DialogueLine {
  who: 'player' | 'npc'
  name: string
  text: string
}

export const useRpgStore = defineStore('rpg', () => {
  const list = ref<RpgWorld[]>([])
  const loaded = ref(false)
  const current = ref<RpgWorld | null>(null)

  // ── 对话态 ──
  /** 正在对话的 NPC。为空表示没在对话 */
  const talkingTo = ref<RpgNpc | null>(null)
  /** 本次对话的往来，只留在内存里 —— 完整历史在会话本身 */
  const lines = ref<DialogueLine[]>([])
  const pending = ref(false)
  const dialogueError = ref('')

  const chars = useCharactersStore()

  /** 正在对话的 NPC 显示名。关联了卡就跟着卡走 */
  const talkingName = computed(() => {
    const n = talkingTo.value
    if (!n) return ''
    return resolveNpc(n, chars.byId(n.characterId)).name
  })

  async function load(): Promise<void> {
    list.value = await rpgWorldsRepo.list()
    loaded.value = true
  }

  async function create(name = '新世界'): Promise<RpgWorld> {
    const w = await rpgWorldsRepo.create(name)
    list.value = [w, ...list.value]
    return w
  }

  async function open(id: string): Promise<RpgWorld | null> {
    const w = await rpgWorldsRepo.get(id)
    current.value = w ?? null
    return current.value
  }

  async function save(): Promise<void> {
    const w = current.value
    if (!w) return
    await rpgWorldsRepo.save(w)
    const i = list.value.findIndex((x) => x.id === w.id)
    if (i >= 0) list.value.splice(i, 1, w)
  }

  async function remove(id: string): Promise<void> {
    await rpgWorldsRepo.remove(id)
    list.value = list.value.filter((w) => w.id !== id)
    if (current.value?.id === id) current.value = null
  }

  // ── NPC 增删改 ──
  function addNpc(x: number, y: number): RpgNpc | null {
    const w = current.value
    if (!w) return null
    const id = crypto.randomUUID()
    const npc: RpgNpc = {
      id,
      x: Math.floor(x),
      y: Math.floor(y),
      // 出生格即锚点;漫游半径按 id 哈希 3..6 —— 村民的活动范围各有大小
      homeX: Math.floor(x),
      homeY: Math.floor(y),
      roamR: 3 + (fnv1a(id) % 4),
      name: '新 NPC',
      description: '',
    }
    w.npcs = [...w.npcs, npc]
    void save()
    return npc
  }

  function removeNpc(id: string): void {
    const w = current.value
    if (!w) return
    w.npcs = w.npcs.filter((n) => n.id !== id)
    void save()
  }

  function openDialogue(npc: RpgNpc): void {
    talkingTo.value = npc
    lines.value = []
    dialogueError.value = ''
  }

  function closeDialogue(): void {
    talkingTo.value = null
    lines.value = []
    pending.value = false
    dialogueError.value = ''
  }

  function reset(): void {
    current.value = null
    closeDialogue()
  }

  return {
    list,
    loaded,
    current,
    talkingTo,
    talkingName,
    lines,
    pending,
    dialogueError,
    load,
    create,
    open,
    save,
    remove,
    addNpc,
    removeNpc,
    openDialogue,
    closeDialogue,
    reset,
  }
})
