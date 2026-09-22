import { getDb, chatRange } from '../schema'
import { toPlain } from '../plain'
import { pruneUnreferenced } from './blobs'
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
  await db.put('chats', toPlain(meta))
  return meta
}

export async function save(meta: ChatMeta): Promise<void> {
  const db = await getDb()
  meta.updatedAt = Date.now()
  await db.put('chats', toPlain(meta))
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
  await tx.store.put(toPlain(meta))
  await tx.done
}

export async function rename(id: string, title: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('chats', 'readwrite')
  const meta = await tx.store.get(id)
  if (meta) {
    meta.title = title
    meta.updatedAt = Date.now()
    await tx.store.put(toPlain(meta))
  }
  await tx.done
}

/** 删会话同时删其全部消息、向量块与仅本会话引用的配图 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  // memchunks 必须和 messages 在**同一事务**里删：分开删的话，中途失败会留下
  // 几 MB 的孤儿向量，而且没有任何东西会再去回收它们
  const tx = db.transaction(['chats', 'messages', 'memchunks'], 'readwrite')
  // 删除前先在同一游标里收集本会话消息引用到的图片（配图 + force_avatar）。
  // 会话删掉后这些记录就再也数不到了，孤儿图片会永久留在 blobs 里（此前只有
  // 设置页「清理未引用图片」才会回收）。这里只扫本会话主键区间，纯文本会话候选为空。
  const candidates = new Set<string>()
  let cursor = await tx.objectStore('messages').openCursor(chatRange(id))
  while (cursor) {
    const m = cursor.value as { force_avatar?: string; images?: { blobId?: string }[] }
    if (m.force_avatar) candidates.add(m.force_avatar)
    for (const img of m.images ?? []) if (img.blobId) candidates.add(img.blobId)
    cursor = await cursor.continue()
  }
  await tx.objectStore('messages').delete(chatRange(id))
  await tx.objectStore('memchunks').delete(chatRange(id))
  await tx.objectStore('chats').delete(id)
  await tx.done
  // 会话已删除，再回收「删完后全库无人引用」的图片。分支会共享 blobId，
  // 所以交给 pruneUnreferenced 逐个比对全库可达集，不会误删分支仍在用的配图。
  await pruneUnreferenced(candidates)
}
