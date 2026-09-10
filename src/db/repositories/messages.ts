/**
 * 消息仓储。主键 [chatId, seq]。
 *
 * `nextSeq` **只增不减**：removeTail 后不回退，避免 seq 复用导致游标/分页错乱。
 * seq 稀疏无害。
 */

import { getDb, chatRange } from '../schema'
import { toPlain } from '../plain'
import type { ChatMessage } from '@/types/chat'

/** 追加一条：同一事务内从 ChatMeta.nextSeq 取号并自增，同时更新计数/时间 */
export async function append(chatId: string, msg: Omit<ChatMessage, 'seq'>): Promise<ChatMessage> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (!meta) throw new Error(`会话 ${chatId} 不存在`)
  const row: ChatMessage = { ...msg, seq: meta.nextSeq }
  await tx.objectStore('messages').put(toPlain(row))
  meta.nextSeq += 1
  meta.messageCount += 1
  meta.lastMessageAt = row.send_date
  meta.updatedAt = Date.now()
  await chats.put(toPlain(meta))
  await tx.done
  return row
}

export async function appendMany(
  chatId: string,
  msgs: Omit<ChatMessage, 'seq'>[],
): Promise<ChatMessage[]> {
  if (!msgs.length) return []
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (!meta) throw new Error(`会话 ${chatId} 不存在`)
  const store = tx.objectStore('messages')
  const out: ChatMessage[] = []
  for (const m of msgs) {
    const row: ChatMessage = { ...m, seq: meta.nextSeq }
    await store.put(toPlain(row))
    meta.nextSeq += 1
    meta.messageCount += 1
    meta.lastMessageAt = row.send_date
    out.push(row)
  }
  meta.updatedAt = Date.now()
  await chats.put(toPlain(meta))
  await tx.done
  return out
}

/** 原地更新（流式增量落盘 / 编辑 / swipe 切换）。已知 seq */
export async function update(row: ChatMessage): Promise<void> {
  const db = await getDb()
  await db.put('messages', toPlain(row))
}

export async function getById(chatId: string, id: string): Promise<ChatMessage | undefined> {
  const db = await getDb()
  return db.getFromIndex('messages', 'by_msgId', [chatId, id])
}

/** 全量取（会话不长时用），升序 */
export async function all(chatId: string): Promise<ChatMessage[]> {
  const db = await getDb()
  return db.getAll('messages', chatRange(chatId))
}

/**
 * 最近 limit 条，升序返回。
 * before 传入则取 seq < before 的一页（向上翻页）。
 */
export async function page(
  chatId: string,
  opts: { limit: number; before?: number } = { limit: 50 },
): Promise<{ rows: ChatMessage[]; hasMore: boolean }> {
  const db = await getDb()
  const upper: IDBValidKey = opts.before === undefined ? [chatId, []] : [chatId, opts.before]
  const range = IDBKeyRange.bound([chatId], upper, false, opts.before !== undefined)
  const out: ChatMessage[] = []
  let cursor = await db.transaction('messages').store.openCursor(range, 'prev')
  while (cursor && out.length < opts.limit) {
    out.push(cursor.value)
    cursor = await cursor.continue()
  }
  return { rows: out.reverse(), hasMore: cursor !== null }
}

/** 取最后 n 条（提示词构建 / 世界书扫描窗口），升序 */
export async function tail(chatId: string, n: number): Promise<ChatMessage[]> {
  const res = await page(chatId, { limit: n })
  return res.rows
}

export async function remove(chatId: string, seq: number): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  await tx.objectStore('messages').delete([chatId, seq])
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (meta) {
    meta.messageCount = Math.max(0, meta.messageCount - 1)
    meta.updatedAt = Date.now()
    await chats.put(toPlain(meta))
  }
  await tx.done
}

/** 删除末尾 n 条（regenerate / 重掷整批） */
export async function removeTail(chatId: string, n: number): Promise<void> {
  if (n <= 0) return
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  let cursor = await tx.objectStore('messages').openCursor(chatRange(chatId), 'prev')
  let removed = 0
  while (cursor && removed < n) {
    await cursor.delete()
    removed++
    cursor = await cursor.continue()
  }
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (meta) {
    meta.messageCount = Math.max(0, meta.messageCount - removed)
    meta.updatedAt = Date.now()
    await chats.put(toPlain(meta))
  }
  await tx.done
}

/** 删除 seq >= fromSeq 的全部消息（分支点之后） */
export async function removeFrom(chatId: string, fromSeq: number): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  const range = IDBKeyRange.bound([chatId, fromSeq], [chatId, []])
  let cursor = await tx.objectStore('messages').openCursor(range)
  let removed = 0
  while (cursor) {
    await cursor.delete()
    removed++
    cursor = await cursor.continue()
  }
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (meta) {
    meta.messageCount = Math.max(0, meta.messageCount - removed)
    meta.updatedAt = Date.now()
    await chats.put(toPlain(meta))
  }
  await tx.done
}

export async function clear(chatId: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  await tx.objectStore('messages').delete(chatRange(chatId))
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (meta) {
    meta.messageCount = 0
    meta.updatedAt = Date.now()
    await chats.put(toPlain(meta))
  }
  await tx.done
}

/** 分支：把 src 会话 seq <= atSeq 的消息复制进 dst，返回复制条数 */
export async function copyUpTo(src: string, dst: string, atSeq: number): Promise<number> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  const store = tx.objectStore('messages')
  const rows = await store.getAll(IDBKeyRange.bound([src], [src, atSeq]))
  const chats = tx.objectStore('chats')
  const meta = await chats.get(dst)
  if (!meta) throw new Error(`会话 ${dst} 不存在`)
  for (const r of rows) {
    const row: ChatMessage = { ...r, chatId: dst, seq: meta.nextSeq, id: crypto.randomUUID() }
    await store.put(toPlain(row))
    meta.nextSeq += 1
    meta.messageCount += 1
    meta.lastMessageAt = row.send_date
  }
  meta.updatedAt = Date.now()
  await chats.put(toPlain(meta))
  await tx.done
  return rows.length
}
