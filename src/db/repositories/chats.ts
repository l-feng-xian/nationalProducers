import { getDb, chatRange } from '../schema'
import { newChatMetadata, type ChatMeta, type ChatMetadata } from '@/types/chat'

export async function list(): Promise<ChatMeta[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('chats', 'by_updatedAt')
  return rows.reverse()
}

export async function listByCharacter(characterId: string): Promise<ChatMeta[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('chats', 'by_characterId', characterId)
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function listByGroup(groupId: string): Promise<ChatMeta[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('chats', 'by_groupId', groupId)
  return rows.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function get(id: string): Promise<ChatMeta | undefined> {
  const db = await getDb()
  return db.get('chats', id)
}

export async function create(
  init: Pick<ChatMeta, 'kind' | 'title'> & Partial<Pick<ChatMeta, 'characterId' | 'groupId'>>,
): Promise<ChatMeta> {
  const now = Date.now()
  const meta: ChatMeta = {
    id: crypto.randomUUID(),
    kind: init.kind,
    title: init.title,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    messageCount: 0,
    nextSeq: 0,
    chat_metadata: newChatMetadata(),
  }
  if (init.characterId !== undefined) meta.characterId = init.characterId
  if (init.groupId !== undefined) meta.groupId = init.groupId
  const db = await getDb()
  await db.put('chats', meta)
  return meta
}

export async function save(meta: ChatMeta): Promise<void> {
  const db = await getDb()
  meta.updatedAt = Date.now()
  await db.put('chats', meta)
}

/** 局部更新 chat_metadata（如世界书定时效果回写） */
export async function patchMetadata(id: string, patch: Partial<ChatMetadata>): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('chats', 'readwrite')
  const meta = await tx.store.get(id)
  if (!meta) {
    await tx.done
    return
  }
  meta.chat_metadata = { ...meta.chat_metadata, ...patch }
  meta.updatedAt = Date.now()
  await tx.store.put(meta)
  await tx.done
}

export async function rename(id: string, title: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('chats', 'readwrite')
  const meta = await tx.store.get(id)
  if (meta) {
    meta.title = title
    meta.updatedAt = Date.now()
    await tx.store.put(meta)
  }
  await tx.done
}

/** 删会话同时删其全部消息，必须同事务 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  await tx.objectStore('messages').delete(chatRange(id))
  await tx.objectStore('chats').delete(id)
  await tx.done
}
