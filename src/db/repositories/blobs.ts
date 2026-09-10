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

/** 扫全库引用，删除未被任何记录引用的图片。设置页「清理未引用图片」 */
export async function gc(): Promise<number> {
  const db = await getDb()
  const referenced = new Set<string>()

  for (const c of await db.getAll('characters')) {
    if (c.avatarBlobId) referenced.add(c.avatarBlobId)
  }
  for (const g of await db.getAll('groups')) {
    if (g.avatarBlobId) referenced.add(g.avatarBlobId)
  }
  const s = await db.get('settings', 'app')
  if (s?.persona.avatarBlobId) referenced.add(s.persona.avatarBlobId)

  const ids = await db.getAllKeys('blobs')
  let removed = 0
  for (const id of ids) {
    if (referenced.has(id)) continue
    await db.delete('blobs', id)
    removed++
  }
  return removed
}
