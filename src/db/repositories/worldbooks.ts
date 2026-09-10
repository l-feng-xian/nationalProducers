import { getDb } from '../schema'
import { createEntry, type WorldBook, type WorldInfoEntry } from '@/types/worldinfo'

export async function list(): Promise<WorldBook[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('worldbooks', 'by_updatedAt')
  return rows.reverse()
}

export async function get(id: string): Promise<WorldBook | undefined> {
  const db = await getDb()
  return db.get('worldbooks', id)
}

export async function getMany(ids: string[]): Promise<WorldBook[]> {
  const db = await getDb()
  const tx = db.transaction('worldbooks')
  const out: WorldBook[] = []
  for (const id of ids) {
    const b = await tx.store.get(id)
    if (b) out.push(b)
  }
  await tx.done
  return out
}

export async function create(name = '新世界书'): Promise<WorldBook> {
  const now = Date.now()
  const book: WorldBook = {
    id: crypto.randomUUID(),
    name,
    description: '',
    entries: {},
    createdAt: now,
    updatedAt: now,
  }
  const db = await getDb()
  await db.put('worldbooks', book)
  return book
}

export async function save(book: WorldBook): Promise<void> {
  book.updatedAt = Date.now()
  const db = await getDb()
  await db.put('worldbooks', book)
}

export async function rename(id: string, name: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('worldbooks', 'readwrite')
  const b = await tx.store.get(id)
  if (b) {
    b.name = name
    b.updatedAt = Date.now()
    await tx.store.put(b)
  }
  await tx.done
}

export async function addEntry(bookId: string): Promise<WorldInfoEntry | undefined> {
  const db = await getDb()
  const tx = db.transaction('worldbooks', 'readwrite')
  const b = await tx.store.get(bookId)
  if (!b) {
    await tx.done
    return undefined
  }
  const entry = createEntry(b.entries)
  b.entries[String(entry.uid)] = entry
  b.updatedAt = Date.now()
  await tx.store.put(b)
  await tx.done
  return entry
}

export async function upsertEntry(bookId: string, entry: WorldInfoEntry): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('worldbooks', 'readwrite')
  const b = await tx.store.get(bookId)
  if (b) {
    b.entries[String(entry.uid)] = entry
    b.updatedAt = Date.now()
    await tx.store.put(b)
  }
  await tx.done
}

export async function removeEntry(bookId: string, uid: number): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('worldbooks', 'readwrite')
  const b = await tx.store.get(bookId)
  if (b) {
    delete b.entries[String(uid)]
    b.updatedAt = Date.now()
    await tx.store.put(b)
  }
  await tx.done
}

/**
 * 删除世界书并级联摘除所有引用：
 * settings.worldInfo.globalBookIds、各 Character.worldBookIds、ChatMetadata.worldBookId。
 * 不这么做会留下指向已删书的悬空引用，扫描时静默少一本书。
 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['worldbooks', 'settings', 'characters', 'chats'], 'readwrite')

  await tx.objectStore('worldbooks').delete(id)

  const sStore = tx.objectStore('settings')
  const s = await sStore.get('app')
  if (s && s.worldInfo.globalBookIds.includes(id)) {
    s.worldInfo.globalBookIds = s.worldInfo.globalBookIds.filter((x) => x !== id)
    s.updatedAt = Date.now()
    await sStore.put(s)
  }

  const cStore = tx.objectStore('characters')
  const chars = await cStore.getAll()
  for (const c of chars) {
    if (!c.worldBookIds.includes(id)) continue
    c.worldBookIds = c.worldBookIds.filter((x) => x !== id)
    c.updatedAt = Date.now()
    await cStore.put(c)
  }

  const chStore = tx.objectStore('chats')
  const chats = await chStore.getAll()
  for (const ch of chats) {
    if (ch.chat_metadata.worldBookId !== id) continue
    delete ch.chat_metadata.worldBookId
    ch.updatedAt = Date.now()
    await chStore.put(ch)
  }

  await tx.done
}
