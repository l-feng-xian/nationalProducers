import { getDb, type BlobRecord } from '@/db/schema'
import type { GameWorld, WorldSave, WorldChunkDelta, WorldNpcState, WorldEvent } from '@/types/infiniteWorld'
import { validateSave, validateWorld, validPosition } from '../validation'
import { toPlain } from '@/utils/plain'

export interface WorldBackup {
  world: GameWorld
  saves: WorldSave[]
  chunks: WorldChunkDelta[]
  npcs: WorldNpcState[]
  events: WorldEvent[]
}

/** Freeze the definition, progress and owned images in one readonly transaction. */
export async function readWorldBackups() {
  const db = await getDb()
  const tx = db.transaction(['gameworlds', 'world_saves', 'world_chunks', 'world_npcs', 'world_events', 'blobs'], 'readonly')
  const bundles: WorldBackup[] = [], blobs: BlobRecord[] = []
  const refs = new Set<string>()
  for (const world of await tx.objectStore('gameworlds').getAll()) {
    const saves = await tx.objectStore('world_saves').index('by_worldId').getAll(world.id)
    const bundle: WorldBackup = { world, saves, chunks: [], npcs: [], events: [] }
    for (const save of saves) {
      bundle.chunks.push(...await tx.objectStore('world_chunks').index('by_saveId').getAll(save.id))
      bundle.npcs.push(...await tx.objectStore('world_npcs').index('by_saveId').getAll(save.id))
      bundle.events.push(...await tx.objectStore('world_events').index('by_saveId').getAll(save.id))
    }
    for (const npc of world.npcs) if (npc.avatarBlobId) refs.add(npc.avatarBlobId)
    bundles.push(bundle)
  }
  for (const id of refs) {
    const blob = await tx.objectStore('blobs').get(id)
    if (!blob) throw new Error('世界头像缺失，无法生成完整备份。')
    blobs.push(blob)
  }
  await tx.done
  return { bundles, blobs }
}

function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message) }
function unique(rows: unknown[], key: (row: any) => unknown) {
  const keys = rows.map((row) => JSON.stringify(key(row)))
  assert(new Set(keys).size === keys.length, '世界备份含有重复记录。')
}

/** A bad/missing dependent row rejects the entire world before replacing any local state. */
export async function restoreWorldBackup(input: WorldBackup, images: { id: string; mime: string; dataUrl: string }[]) {
  const bundle = toPlain(input)
  validateWorld(bundle.world)
  for (const rows of [bundle.saves, bundle.chunks, bundle.npcs, bundle.events]) assert(Array.isArray(rows), '世界备份缺少附属数据。')
  assert(bundle.saves.length > 0, '世界备份缺少存档。')
  const ids = new Set(bundle.saves.map((save) => save.id))
  const npcIds = new Set(bundle.world.npcs.map((npc) => npc.npcId))
  unique(bundle.saves, (r) => r.id)
  unique(bundle.chunks, (r) => [r.saveId, r.cx, r.cy])
  unique(bundle.npcs, (r) => [r.saveId, r.npcId])
  unique(bundle.events, (r) => [r.saveId, r.seq])
  for (const save of bundle.saves) validateSave(save, bundle.world)
  for (const row of [...bundle.chunks, ...bundle.npcs, ...bundle.events]) assert(ids.has(row.saveId), '世界备份含有无主记录。')
  for (const chunk of bundle.chunks) {
    assert(Number.isInteger(chunk.cx) && Number.isInteger(chunk.cy) && Number.isInteger(chunk.revision) && chunk.revision >= 0 && chunk.generatorVersion === bundle.world.generatorVersion, '区块版本或坐标不正确。')
    assert(Array.isArray(chunk.changedTiles) && Array.isArray(chunk.removedObjectIds) && Array.isArray(chunk.placedObjects), '区块差量不完整。')
  }
  for (const state of bundle.npcs) assert(npcIds.has(state.npcId) && validPosition(state.position), '居民状态或位置无效。')
  for (const save of bundle.saves) assert(bundle.npcs.filter((n) => n.saveId === save.id).length === npcIds.size, '存档缺少居民状态。')
  for (const event of bundle.events) assert(Number.isInteger(event.seq) && event.seq >= 0 && Number.isFinite(event.at) && typeof event.type === 'string', '世界事件不完整。')
  for (const id of bundle.world.lore.worldBookIds) assert(bundle.world.lore.worldBookSnapshots?.some((book) => book.id === id), '世界书副本缺失。')
  const blobs: BlobRecord[] = []
  for (const id of new Set(bundle.world.npcs.map((npc) => npc.avatarBlobId).filter((id): id is string => !!id))) {
    const image = images.find((b) => b.id === id)
    assert(image && typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:'), '世界头像未包含在备份中。')
    const response = await fetch(image.dataUrl)
    const data = await response.blob()
    blobs.push({ id, mime: image.mime, size: data.size, data, createdAt: Date.now() })
  }
  const db = await getDb()
  const tx = db.transaction(['gameworlds', 'world_saves', 'world_chunks', 'world_npcs', 'world_events', 'blobs'], 'readwrite')
  try {
    const oldSaves = await tx.objectStore('world_saves').index('by_worldId').getAll(bundle.world.id)
    for (const save of bundle.saves) {
      const existing = await tx.objectStore('world_saves').get(save.id)
      assert(!existing || existing.worldId === bundle.world.id, '存档 ID 被另一个世界使用。')
      // Invalidate live editors even if the incoming backup has an older/same revision.
      save.revision = Math.max(existing?.revision ?? -1, save.revision) + 1
    }
    for (const save of oldSaves) {
      await tx.objectStore('world_saves').delete(save.id)
      for (const name of ['world_chunks', 'world_npcs', 'world_events'] as const) {
        for (const key of await tx.objectStore(name).index('by_saveId').getAllKeys(save.id)) await tx.objectStore(name).delete(key as never)
      }
    }
    const prior = await tx.objectStore('gameworlds').get(bundle.world.id)
    bundle.world.updatedAt = Math.max(Date.now(), (prior?.updatedAt ?? 0) + 1)
    await tx.objectStore('gameworlds').put(bundle.world)
    for (const save of bundle.saves) await tx.objectStore('world_saves').put(save)
    for (const chunk of bundle.chunks) await tx.objectStore('world_chunks').put(chunk)
    for (const npc of bundle.npcs) await tx.objectStore('world_npcs').put(npc)
    for (const event of bundle.events) await tx.objectStore('world_events').put(event)
    for (const blob of blobs) await tx.objectStore('blobs').put(blob)
    await tx.done
    return blobs.length
  } catch (error) {
    try { tx.abort() } catch { /* already aborted */ }
    await tx.done.catch(() => {})
    throw error
  }
}
