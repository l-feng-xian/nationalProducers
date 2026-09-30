import { getDb, type BlobRecord } from '../schema'

export async function put(data: Blob): Promise<string> {
  const rec: BlobRecord = {
    id: crypto.randomUUID(),
    mime: data.type || 'application/octet-stream',
    size: data.size,
    data,
    createdAt: Date.now(),
  }
  const db = await getDb()
  await db.put('blobs', rec)
  return rec.id
}

export async function get(id: string): Promise<Blob | undefined> {
  const db = await getDb()
  const rec = await db.get('blobs', id)
  return rec?.data
}

/** 单事务批量取多条记录（含元数据与 Blob 本体），数据管理页图片子表用 */
export async function getMany(ids: string[]): Promise<Record<string, BlobRecord | undefined>> {
  const out: Record<string, BlobRecord | undefined> = {}
  if (!ids.length) return out
  const db = await getDb()
  const tx = db.transaction('blobs')
  const store = tx.objectStore('blobs')
  for (const id of ids) out[id] = await store.get(id)
  await tx.done
  return out
}

export async function remove(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('blobs', id)
}

/** 指向 blobs 的记录形状。只取用得着的字段，免得把整套业务类型拖进来 */
export interface BlobRefSource {
  messages?: { images?: { blobId: string }[]; force_avatar?: string }[]
  characters?: { avatarBlobId?: string | undefined; depthBlobId?: string | undefined }[]
  groups?: { avatarBlobId?: string | undefined; depthBlobId?: string | undefined }[]
  persona?: { avatarBlobId?: string | undefined } | undefined
}

/**
 * 收集这些记录引用到的全部图片 id。
 *
 * ⚠️ **角色有两个图片字段**：`avatarBlobId`（立绘）和 `depthBlobId`（视差深度图）。
 * 早先这里只数了 avatar，深度图于是被判成无人引用的垃圾 —— gc 一跑就全删光，
 * 角色卡的视差效果随之失效，而且不报任何错、看上去只是「视差突然不工作了」。
 * 以后再给记录加图片字段，必须同步改这一个函数：gc 与整库备份都从这里取可达集，
 * 不会再出现两处各漏一个字段的情况。
 */
export function collectBlobRefs(src: BlobRefSource): Set<string> {
  const out = new Set<string>()
  for (const message of src.messages ?? []) {
    if (message.force_avatar) out.add(message.force_avatar)
    for (const image of message.images ?? []) if (image.blobId) out.add(image.blobId)
  }
  for (const c of src.characters ?? []) {
    if (c.avatarBlobId) out.add(c.avatarBlobId)
    if (c.depthBlobId) out.add(c.depthBlobId)
  }
  // 演绎封面同样是两个字段：横版封面 + 视差深度图
  for (const g of src.groups ?? []) {
    if (g.avatarBlobId) out.add(g.avatarBlobId)
    if (g.depthBlobId) out.add(g.depthBlobId)
  }
  if (src.persona?.avatarBlobId) out.add(src.persona.avatarBlobId)
  return out
}

/**
 * 全库可达的图片 id 集。gc、整库备份、「删会话连带清图」都从这里取同一张可达面，
 * 字段清单只在 {@link collectBlobRefs} 一处维护，不会两处各漏一个引用字段。
 */
export async function reachableBlobIds(): Promise<Set<string>> {
  const db = await getDb()
  return collectBlobRefs({
    characters: await db.getAll('characters'),
    messages: await db.getAll('messages'),
    groups: await db.getAll('groups'),
    persona: (await db.get('settings', 'app'))?.persona,
  })
}

/** 扫全库引用，删除未被任何记录引用的图片。设置页「清理未引用图片」 */
export async function gc(): Promise<number> {
  const db = await getDb()
  const referenced = await reachableBlobIds()

  const ids = await db.getAllKeys('blobs')
  let removed = 0
  for (const id of ids) {
    if (referenced.has(id)) continue
    await db.delete('blobs', id)
    removed++
  }
  return removed
}

/**
 * 从候选集里回收「删除操作发生后、全库已无人引用」的图片。
 *
 * 删会话时用：被删会话消息带的配图（images[].blobId）与 force_avatar 都是候选。
 * **不能直接删候选** —— 分支（copyUpTo）会让另一个会话的消息共享同一 blobId，
 * 直接删会击穿仍在使用它的分支会话配图。所以在会话/消息已删除之后，重算一次
 * 全库可达集，只回收真正的孤儿。候选为空时零成本返回，纯文本会话不付这次扫描。
 */
export async function pruneUnreferenced(candidates: Set<string>): Promise<number> {
  if (candidates.size === 0) return 0
  const referenced = await reachableBlobIds()
  const db = await getDb()
  const tx = db.transaction('blobs', 'readwrite')
  let removed = 0
  for (const id of candidates) {
    if (referenced.has(id)) continue
    await tx.store.delete(id)
    removed++
  }
  await tx.done
  return removed
}
