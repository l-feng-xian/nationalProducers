import { getDb, chatRange } from '../schema'
import { emptyCharacter, type Character } from '@/types/character'

export async function list(): Promise<Character[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('characters', 'by_updatedAt')
  return rows.reverse()
}

export async function get(id: string): Promise<Character | undefined> {
  const db = await getDb()
  return db.get('characters', id)
}

export async function getMany(ids: string[]): Promise<Character[]> {
  const db = await getDb()
  const tx = db.transaction('characters')
  const out: Character[] = []
  for (const id of ids) {
    const c = await tx.store.get(id)
    if (c) out.push(c)
  }
  await tx.done
  return out
}

export async function create(name = '新角色'): Promise<Character> {
  const c = emptyCharacter(crypto.randomUUID(), name)
  const db = await getDb()
  await db.put('characters', c)
  return c
}

/** 自动 stamp updatedAt 与 favIdx（IDB 不索引 boolean） */
export async function save(c: Character): Promise<Character> {
  c.updatedAt = Date.now()
  c.favIdx = c.fav ? 1 : 0
  const db = await getDb()
  await db.put('characters', c)
  return c
}

export async function toggleFav(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('characters', 'readwrite')
  const c = await tx.store.get(id)
  if (c) {
    c.fav = !c.fav
    c.favIdx = c.fav ? 1 : 0
    c.updatedAt = Date.now()
    await tx.store.put(c)
  }
  await tx.done
}

export async function count(): Promise<number> {
  const db = await getDb()
  return db.count('characters')
}

/**
 * 删除角色。必须在一个跨 store 事务里，否则中途失败会留下孤儿数据：
 * 头像 blob、该角色的全部会话与消息、群聊中的成员引用与关系边。
 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['characters', 'blobs', 'chats', 'messages', 'groups'], 'readwrite')

  const c = await tx.objectStore('characters').get(id)
  if (c?.avatarBlobId) await tx.objectStore('blobs').delete(c.avatarBlobId)

  const chatStore = tx.objectStore('chats')
  const chatIds = await chatStore.index('by_characterId').getAllKeys(id)
  const msgStore = tx.objectStore('messages')
  for (const cid of chatIds) {
    await msgStore.delete(chatRange(cid))
    await chatStore.delete(cid)
  }

  const gStore = tx.objectStore('groups')
  const groups = await gStore.getAll()
  for (const g of groups) {
    if (!g.members.includes(id)) continue
    g.members = g.members.filter((m) => m !== id)
    g.disabled_members = g.disabled_members.filter((m) => m !== id)
    g.relations = g.relations.filter((r) => r.from !== id && r.to !== id)
    delete g.layout[id]
    g.updatedAt = Date.now()
    await gStore.put(g)
  }

  await tx.objectStore('characters').delete(id)
  await tx.done
}
