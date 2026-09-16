import { getDb } from '../schema'
import { toPlain } from '@/utils/plain'
import { emptySave, emptyWorld, type GameWorld, type WorldSave } from '@/types/infiniteWorld'
import { validateSave, validateWorld } from '@/services/infinite-world/validation'
import { collectBlobRefs } from './blobs'

export async function list(): Promise<GameWorld[]> {
  return (await (await getDb()).getAllFromIndex('gameworlds', 'by_updatedAt')).reverse()
}
export async function get(id: string) { return (await getDb()).get('gameworlds', id) }
export async function getSave(worldId: string) { return (await getDb()).getFromIndex('world_saves', 'by_worldId', worldId) }

/** Snapshot all external resources and publish the world in a single IDB transaction. */
async function write(input: GameWorld, editing: boolean) {
  const world = toPlain(input)
  world.name = world.name.trim()
  world.updatedAt = Date.now()
  validateWorld(world)
  const db = await getDb()
  const tx = db.transaction(['gameworlds', 'world_saves', 'world_npcs', 'blobs', 'worldbooks'], 'readwrite')
  try {
    const previous = await tx.objectStore('gameworlds').get(world.id)
    if (editing) {
      if (!previous) throw new Error('此世界已被删除，请返回世界列表。')
      if (input.updatedAt !== previous.updatedAt) throw new Error('世界设定已在别处修改，请重新打开后编辑。')
      if (world.seed !== previous.seed || world.generatorVersion !== previous.generatorVersion ||
        JSON.stringify(world.settings) !== JSON.stringify(previous.settings) ||
        JSON.stringify(world.player.spawn) !== JSON.stringify(previous.player.spawn)) throw new Error('已创建世界的地图参数不能修改，请创建新世界。')
    } else if (previous) throw new Error('此世界已经创建，请返回世界列表。')
    for (const npc of world.npcs) {
      const old = previous?.npcs.find((n) => n.npcId === npc.npcId)
      if (npc.avatarBlobId && npc.avatarBlobId !== old?.avatarBlobId) {
        const source = await tx.objectStore('blobs').get(npc.avatarBlobId)
        if (!source) throw new Error('居民「' + npc.name + '」的头像已不存在，请重新选择。')
        npc.avatarBlobId = crypto.randomUUID()
        await tx.objectStore('blobs').add({ ...source, id: npc.avatarBlobId, createdAt: Date.now() })
      }
    }
    world.lore.worldBookSnapshots = []
    for (const id of world.lore.worldBookIds) {
      const book = previous?.lore.worldBookSnapshots?.find((b) => b.id === id) ?? await tx.objectStore('worldbooks').get(id)
      if (!book) throw new Error('选中的世界书已不存在，请重新选择。')
      world.lore.worldBookSnapshots.push(book)
    }
    let progress = editing ? await tx.objectStore('world_saves').index('by_worldId').get(world.id) : undefined
    if (!progress) progress = emptySave(world)
    else { progress.revision++; progress.updatedAt = Date.now(); progress.relations = toPlain(world.relations) }
    await tx.objectStore('gameworlds').put(world)
    await tx.objectStore('world_saves').put(progress)
    const states = await tx.objectStore('world_npcs').index('by_saveId').getAll(progress.id)
    for (const state of states) if (!world.npcs.some((n) => n.npcId === state.npcId)) await tx.objectStore('world_npcs').delete([progress.id, state.npcId])
    for (const npc of world.npcs) if (!states.some((n) => n.npcId === npc.npcId)) {
      await tx.objectStore('world_npcs').add({ saveId: progress.id, npcId: npc.npcId, position: [...npc.home], state: 'idle', scheduleIndex: 0, updatedAt: Date.now() })
    }
    await tx.done
    return { world, save: progress }
  } catch (error) {
    try { tx.abort() } catch { /* already aborted */ }
    await tx.done.catch(() => {})
    throw error
  }
}
export function create(world = emptyWorld()) { return write(world, false) }
export function save(world: GameWorld) { return write(world, true) }

export async function saveProgress(input: WorldSave): Promise<WorldSave> {
  const snapshot = toPlain(input)
  const db = await getDb()
  const tx = db.transaction(['world_saves', 'gameworlds'], 'readwrite')
  try {
    const current = await tx.objectStore('world_saves').get(snapshot.id)
    if (!current || current.revision !== snapshot.revision || current.worldId !== snapshot.worldId) throw new Error('存档已在其他页面更新，请重新进入世界后继续。')
    const world = await tx.objectStore('gameworlds').get(snapshot.worldId)
    if (!world) throw new Error('世界已被删除。')
    validateSave(snapshot, world)
    snapshot.revision++
    snapshot.updatedAt = Date.now()
    await tx.objectStore('world_saves').put(snapshot)
    await tx.done
    return snapshot
  } catch (error) {
    try { tx.abort() } catch { /* already aborted */ }
    await tx.done.catch(() => {})
    throw error
  }
}

export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['gameworlds', 'world_saves', 'world_chunks', 'world_npcs', 'world_events', 'blobs', 'characters', 'groups', 'settings'], 'readwrite')
  const world = await tx.objectStore('gameworlds').get(id)
  const saves = await tx.objectStore('world_saves').index('by_worldId').getAll(id)
  await tx.objectStore('gameworlds').delete(id)
  for (const progress of saves) {
    await tx.objectStore('world_saves').delete(progress.id)
    for (const store of ['world_chunks', 'world_npcs', 'world_events'] as const) {
      const keys = await tx.objectStore(store).index('by_saveId').getAllKeys(progress.id)
      for (const key of keys) await tx.objectStore(store).delete(key as never)
    }
  }
  const refs = collectBlobRefs({
    characters: await tx.objectStore('characters').getAll(),
    groups: await tx.objectStore('groups').getAll(),
    persona: (await tx.objectStore('settings').get('app'))?.persona,
    gameworlds: await tx.objectStore('gameworlds').getAll(),
  })
  for (const npc of world?.npcs ?? []) if (npc.avatarBlobId && !refs.has(npc.avatarBlobId)) await tx.objectStore('blobs').delete(npc.avatarBlobId)
  await tx.done
}
