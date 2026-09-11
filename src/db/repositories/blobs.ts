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

export async function remove(id: string): Promise<void> {
  const db = await getDb()
  await db.delete('blobs', id)
}

/** 指向 blobs 的记录形状。只取用得着的字段，免得把整套业务类型拖进来 */
export interface BlobRefSource {
  characters?: { avatarBlobId?: string | undefined; depthBlobId?: string | undefined }[]
  groups?: { avatarBlobId?: string | undefined }[]
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
  for (const c of src.characters ?? []) {
    if (c.avatarBlobId) out.add(c.avatarBlobId)
    if (c.depthBlobId) out.add(c.depthBlobId)
  }
  for (const g of src.groups ?? []) {
    if (g.avatarBlobId) out.add(g.avatarBlobId)
  }
  if (src.persona?.avatarBlobId) out.add(src.persona.avatarBlobId)
  return out
}

/** 扫全库引用，删除未被任何记录引用的图片。设置页「清理未引用图片」 */
export async function gc(): Promise<number> {
  const db = await getDb()
  const referenced = collectBlobRefs({
    characters: await db.getAll('characters'),
    groups: await db.getAll('groups'),
    persona: (await db.get('settings', 'app'))?.persona,
  })

  const ids = await db.getAllKeys('blobs')
  let removed = 0
  for (const id of ids) {
    if (referenced.has(id)) continue
    await db.delete('blobs', id)
    removed++
  }
  return removed
}
