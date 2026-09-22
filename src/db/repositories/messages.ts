/**
 * 消息仓储。主键 [chatId, seq]。
 *
 * `nextSeq` **只增不减**：removeTail 后不回退，避免 seq 复用导致游标/分页错乱。
 * seq 稀疏无害。
 */

import { getDb, chatRange } from '../schema'
import { toPlain } from '../plain'
import { pruneUnreferenced } from './blobs'
import type { ChatMessage } from '@/types/chat'
import type { GeneratedImage } from '@/types/image'

/**
 * 探测像素尺寸，供渲染时占位。**必须在开事务之前做** —— 事务里只能 await IDB 请求，
 * 在里面等解码会让事务静默自动提交（见 schema.ts 开头的铁律）。
 * 解不出来就不存，渲染端自然回退到自适应高度。
 */
async function probeSize(blob: Blob): Promise<{ width: number; height: number } | undefined> {
  try {
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size.width > 0 && size.height > 0 ? size : undefined
  } catch {
    return undefined
  }
}

/** 图片和附件引用原子写入；目标消息已删除时不复活消息、不留下孤立图片。 */
export async function attachImage(
  chatId: string,
  messageId: string,
  image: GeneratedImage,
): Promise<ChatMessage> {
  const size = await probeSize(image.blob)
  const db = await getDb()
  const tx = db.transaction(['messages', 'blobs'], 'readwrite')
  const store = tx.objectStore('messages')
  const row = await store.index('by_msgId').get([chatId, messageId])
  if (!row) {
    await tx.done
    throw new Error('原消息已删除，无法保存配图')
  }
  const id = crypto.randomUUID()
  const createdAt = Date.now()
  await tx
    .objectStore('blobs')
    .put({ id, data: image.blob, mime: image.blob.type, size: image.blob.size, createdAt })
  row.images = [
    ...(row.images ?? []),
    {
      blobId: id,
      prompt: image.prompt,
      model: image.model,
      serviceName: image.serviceName,
      createdAt,
      ...(size ?? {}),
    },
  ]
  await store.put(toPlain(row))
  await tx.done
  return row
}

/** 只用到 openCursor 这一件事，结构化声明即可，免得把 idb 的泛型拖进签名 */
type MsgStore = {
  openCursor(range: IDBKeyRange, direction: 'prev'): Promise<{ key: IDBValidKey } | null>
}

/**
 * 本次该从哪个号开始：`max(meta.nextSeq, 库里真实最大 seq + 1)`。
 *
 * ⚠️ 不能直接信 `meta.nextSeq`。写消息用的是 `put`（复合主键 `[chatId, seq]` 的
 * **upsert**），号一旦发重，旧消息就被**静默覆盖** —— 不报错、条数不变、
 * 新消息还插在会话中间，用户刷新之前根本看不出来。
 *
 * 而 nextSeq 倒退不需要任何畸形数据，走的就是应用自己宣传的那条路：
 * 导入/同步是「同 id 覆盖」，确认页上明写着「其中 N 个会话本机已存在，将被覆盖」。
 * 拿手机上一份**较旧**的同名会话推到电脑（本机 0..19 / nextSeq 20，
 * 来的那份 0..9 / nextSeq 10），会话元数据被整个换成旧的，而本机 10..19 那些
 * 消息行还留在库里 —— 之后每发一条就顶掉一条旧的，直到号追回 20。
 *
 * 这里在**同一个事务**里跟库核一次表，代价是一次 'prev' 游标（O(log n)），
 * 换来的是「seq 只增不减」从注释里的约定变成真正的不变量。
 */
async function allocSeq(store: MsgStore, chatId: string, metaNext: number): Promise<number> {
  const cur = await store.openCursor(chatRange(chatId), 'prev')
  const k = cur?.key
  const maxSeq = Array.isArray(k) ? k[1] : undefined
  const safe = typeof maxSeq === 'number' && Number.isFinite(maxSeq) ? maxSeq + 1 : 0
  const base = typeof metaNext === 'number' && Number.isFinite(metaNext) ? metaNext : 0
  return Math.max(base, safe)
}

/** 追加一条：同一事务内从 ChatMeta.nextSeq 取号并自增，同时更新计数/时间 */
export async function append(chatId: string, msg: Omit<ChatMessage, 'seq'>): Promise<ChatMessage> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (!meta) throw new Error(`会话 ${chatId} 不存在`)
  const store = tx.objectStore('messages')
  const seq = await allocSeq(store, chatId, meta.nextSeq)
  const row: ChatMessage = { ...msg, seq }
  await store.put(toPlain(row))
  meta.nextSeq = seq + 1
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
  meta.nextSeq = await allocSeq(store, chatId, meta.nextSeq)
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
  const store = tx.objectStore('messages')
  // 删除前收集本会话消息引用的图片（配图 + force_avatar），删完后回收孤儿。
  // 与 chats.remove 同理：清空消息会让这些 blob 失去引用，否则永久留在 blobs 里。
  const candidates = new Set<string>()
  let cursor = await store.openCursor(chatRange(chatId))
  while (cursor) {
    const m = cursor.value
    if (m.force_avatar) candidates.add(m.force_avatar)
    for (const img of m.images ?? []) if (img.blobId) candidates.add(img.blobId)
    cursor = await cursor.continue()
  }
  await store.delete(chatRange(chatId))
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (meta) {
    meta.messageCount = 0
    meta.updatedAt = Date.now()
    await chats.put(toPlain(meta))
  }
  await tx.done
  // 分支会共享 blobId，交给 pruneUnreferenced 比对全库可达集，只删真正无人引用的
  await pruneUnreferenced(candidates)
}

/**
 * 分支：把 src 会话 seq <= atSeq 的消息复制进 dst。
 *
 * 返回 **旧 seq → 新 seq** 的映射（`.size` 即复制条数）。新会话是重新取号的，
 * 任何按 seq 索引到消息的旁路数据（向量块的 srcSeqs、记忆水位线）都得靠它平移，
 * 否则会在错误的位置生效。
 */
export async function copyUpTo(
  src: string,
  dst: string,
  atSeq: number,
): Promise<Map<number, number>> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  const store = tx.objectStore('messages')
  const rows = await store.getAll(IDBKeyRange.bound([src], [src, atSeq]))
  const chats = tx.objectStore('chats')
  const meta = await chats.get(dst)
  if (!meta) throw new Error(`会话 ${dst} 不存在`)
  const seqMap = new Map<number, number>()
  // 分支目标会话同样要跟库核表 —— 它也可能是被导入覆盖过的
  meta.nextSeq = await allocSeq(store, dst, meta.nextSeq)
  for (const r of rows) {
    const row: ChatMessage = { ...r, chatId: dst, seq: meta.nextSeq, id: crypto.randomUUID() }
    await store.put(toPlain(row))
    seqMap.set(r.seq, row.seq)
    meta.nextSeq += 1
    meta.messageCount += 1
    meta.lastMessageAt = row.send_date
  }
  meta.updatedAt = Date.now()
  await chats.put(toPlain(meta))
  await tx.done
  return seqMap
}
