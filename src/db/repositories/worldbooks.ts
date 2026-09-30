import { getDb } from '../schema'
import { toPlain } from '../plain'
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
  await db.put('worldbooks', toPlain(book))
  return book
}

export async function save(book: WorldBook): Promise<void> {
  book.updatedAt = Date.now()
  const db = await getDb()
  await db.put('worldbooks', toPlain(book))
}

export async function rename(id: string, name: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('worldbooks', 'readwrite')
  const b = await tx.store.get(id)
  if (b) {
    b.name = name
    b.updatedAt = Date.now()
    await tx.store.put(toPlain(b))
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
  await tx.store.put(toPlain(b))
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
    await tx.store.put(toPlain(b))
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
    await tx.store.put(toPlain(b))
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
  const tx = db.transaction(['worldbooks', 'settings', 'characters', 'groups', 'chats'], 'readwrite')

  /**
   * ⚠️ 三段级联都是**裸读别的 store**，拿到的行没经过那个仓储的 normalize
   * （normalize 在读路径上，事务里够不着），所以每个跨库字段都要自己防一手。
   *
   * 另外**先清引用、最后才删书**。原先是反过来的，而 JS 抛错并不会把已经
   * 自动提交的删除撤回来：实测拿一个 `chat_metadata` 缺失的会话触发，
   * 书**已经没了**，引用却一处都没清 —— 设置里留着一个指向空书的 id，
   * 角色卡上挂着一本不存在的世界书，而调用方收到的是一句异常、
   * 既不 toast 成功也不刷新列表。删除放最后，抛了就整件事都没发生。
   */
  const sStore = tx.objectStore('settings')
  const s = await sStore.get('app')
  const globalIds = s?.worldInfo?.globalBookIds
  if (s && Array.isArray(globalIds) && globalIds.includes(id)) {
    s.worldInfo.globalBookIds = globalIds.filter((x) => x !== id)
    s.updatedAt = Date.now()
    await sStore.put(toPlain(s))
  }

  const cStore = tx.objectStore('characters')
  const chars = await cStore.getAll()
  for (const c of chars) {
    if (c.worldBookId !== id && (!Array.isArray(c.worldBookIds) || !c.worldBookIds.includes(id))) continue
    if (c.worldBookId === id) delete c.worldBookId
    c.worldBookIds = Array.isArray(c.worldBookIds) ? c.worldBookIds.filter((x) => x !== id) : []
    c.updatedAt = Date.now()
    await cStore.put(toPlain(c))
  }

  const gStore = tx.objectStore('groups')
  for (const g of await gStore.getAll()) {
    if (g.worldBookId !== id) continue
    delete g.worldBookId
    g.updatedAt = Date.now()
    await gStore.put(toPlain(g))
  }

  const chStore = tx.objectStore('chats')
  const chats = await chStore.getAll()
  for (const ch of chats) {
    if (ch.chat_metadata?.worldBookId !== id) continue
    delete ch.chat_metadata.worldBookId
    ch.updatedAt = Date.now()
    await chStore.put(toPlain(ch))
  }

  await tx.objectStore('worldbooks').delete(id)
  await tx.done
}
