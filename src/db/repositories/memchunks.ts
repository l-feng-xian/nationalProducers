/**
 * 会话记忆向量块的仓储。
 *
 * 主键是 `[chatId, kindRank, ord]`，所以：
 *  - 整会话取用 `chatRange(chatId)`；
 *  - 「某一类里 endSeq ≥ S 的全部块」用 bound 一刀切。
 *
 * 遵守 schema.ts 的铁律：事务里只 await IDB 请求。
 */

import { getDb, chatRange, type MemChunk } from '../schema'

export async function putMany(rows: MemChunk[]): Promise<void> {
  if (!rows.length) return
  const db = await getDb()
  const tx = db.transaction('memchunks', 'readwrite')
  const store = tx.objectStore('memchunks')
  for (const r of rows) await store.put(r)
  await tx.done
}

/** 整会话取出。检索前会在内存里打包成一整块 Float32Array，所以这里一次全取 */
export async function listByChat(chatId: string): Promise<MemChunk[]> {
  const db = await getDb()
  return db.getAll('memchunks', chatRange(chatId))
}

export async function countByChat(chatId: string): Promise<number> {
  const db = await getDb()
  return db.count('memchunks', chatRange(chatId))
}

export async function clearChat(chatId: string): Promise<void> {
  const db = await getDb()
  await db.delete('memchunks', chatRange(chatId))
}

/**
 * 删掉覆盖范围触及 `fromSeq` 及其之后的所有块。
 *
 * 注意判据是 `endSeq >= fromSeq` 而不是主键序 —— 窗口块有 50% 重叠，
 * 一个起点很早的窗口也可能覆盖到 fromSeq。所以只能整会话扫一遍再按
 * endSeq 过滤，不能用键范围抄近路。会话块数通常在几千量级，可以接受。
 */
export async function deleteFromSeq(chatId: string, fromSeq: number): Promise<number> {
  const db = await getDb()
  const all = await db.getAll('memchunks', chatRange(chatId))
  const doomed = all.filter((c) => c.endSeq >= fromSeq)
  if (!doomed.length) return 0
  const tx = db.transaction('memchunks', 'readwrite')
  const store = tx.objectStore('memchunks')
  for (const c of doomed) await store.delete([c.chatId, c.kindRank, c.ord])
  await tx.done
  return doomed.length
}

/** 删掉覆盖了指定 seq 的块（消息被编辑/删除时用） */
export async function deleteBySeq(chatId: string, seq: number): Promise<number> {
  const db = await getDb()
  const all = await db.getAll('memchunks', chatRange(chatId))
  const doomed = all.filter((c) => c.srcSeqs.includes(seq))
  if (!doomed.length) return 0
  const tx = db.transaction('memchunks', 'readwrite')
  const store = tx.objectStore('memchunks')
  for (const c of doomed) await store.delete([c.chatId, c.kindRank, c.ord])
  await tx.done
  return doomed.length
}

/**
 * 分支会话时平移向量块。
 *
 * `copyUpTo` 会给新会话**重新取号 seq**，旧向量的 srcSeqs 对新分支全是废的。
 * 不做映射直接复制的后果很隐蔽：失效逻辑会在错误的位置开刀，表现为
 * 「编辑了第 30 条，第 80 条附近的记忆莫名消失」，且只在分支过的会话里复现。
 *
 * seqMap 里找不到的块直接丢弃（说明它覆盖的消息没被复制过去）。
 */
export async function copyRemapped(
  srcChatId: string,
  dstChatId: string,
  seqMap: Map<number, number>,
): Promise<number> {
  const src = await listByChat(srcChatId)
  const out: MemChunk[] = []
  for (const c of src) {
    const mapped: number[] = []
    let ok = true
    for (const s of c.srcSeqs) {
      const n = seqMap.get(s)
      if (n === undefined) {
        ok = false
        break
      }
      mapped.push(n)
    }
    if (!ok || !mapped.length) continue
    out.push({
      ...c,
      chatId: dstChatId,
      srcSeqs: mapped,
      endSeq: Math.max(...mapped),
      // 向量是 Float32Array，跨记录复制要拷贝而不是共享同一个 buffer
      vec: new Float32Array(c.vec),
    })
  }
  await putMany(out)
  return out.length
}
