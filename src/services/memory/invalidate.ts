/**
 * 消息被改动时的向量索引失效。
 *
 * 索引是**拉模式追赶**的（见 vectorIndex.ts），只解决「消息变多」。
 * 消息被改小/改写时没有任何机制会自己发现 —— 水位线只升不降，
 * 于是那些块会永远留在库里，检索时把早已不存在的内容当往事捞回来喂给模型。
 * 这里负责把受影响的块删掉、并把水位线**退回**到改动点之前，让追赶重新覆盖。
 *
 * ⚠️ 绝不去动 `state.chunks`：它在 catchUp 里是 **ord 取号器**（`let ord = state.chunks`），
 * 不是「还剩多少块」。删掉中间某块后若按剩余数把它调小，下次取号就会撞上仍然
 * 存在的 ord，直接 put 覆盖掉一条无关的记忆 —— 静默的数据损坏。
 * 代价只是这个数字偏大，真要显示条数请用 `memchunksRepo.countByChat()`。
 *
 * 纯 service：不 import vue/pinia。
 */

import { memchunksRepo } from '@/db/repositories'
import type { MemIndexState } from '@/types/chat'

/** 水位线只许退不许进 */
function rollback(state: MemIndexState, toSeq: number): MemIndexState {
  const next = Math.min(state.throughSeq, toSeq)
  return next === state.throughSeq ? state : { ...state, throughSeq: next }
}

export interface InvalidateResult {
  removed: number
  /** 非 null 表示水位线变了，调用方要落盘 */
  state: MemIndexState | null
}

const NOOP: InvalidateResult = { removed: 0, state: null }

/**
 * 单条消息**被删除**。
 *
 * 只删覆盖到它的窗口块（窗口有重叠，不止一块），**水位线故意不动**。
 *
 * 不退水位线是关键。退了的话追赶会从这里开始重新切窗口，而它后面那些块
 * 明明还在、内容也没变 —— 于是同一段对话在索引里存两份，窗口边界还错开，
 * srcSeqs 去重只能挡掉一部分，长期反复编辑会让索引越滚越肥。
 * 代价只是这附近留一小段没被索引；删除本来就没有新内容要补，这笔买卖划算。
 */
export async function invalidateDeletedSeq(
  chatId: string,
  seq: number,
  state: MemIndexState | undefined,
): Promise<InvalidateResult> {
  if (!state) return NOOP
  const removed = await memchunksRepo.deleteBySeq(chatId, seq)
  return { removed, state: null }
}

/**
 * 从某条起索引全部作废：整段截断（删至末尾 / removeTail / 重新生成），
 * 以及**单条消息被编辑**。
 *
 * 编辑为什么要走这条更贵的路：编辑有新正文需要进索引，所以水位线必须退回去；
 * 而一旦退了水位线，后面的块就必须一起删掉，否则那段会被重复索引（见上）。
 * 「退水位线」和「删掉其后全部块」是绑死的一对，不能只做一半。
 *
 * 代价是编辑点之后的内容要重新嵌入一遍。改最后一条（最常见）只有一两块；
 * 改很靠前的一条则可能是几百块 —— catchUp 分批、批间让出主线程、
 * 页面切到后台自动中止、下次打开接着跑，所以慢但不会卡住界面。
 * 改第 0 条时水位线会退成 -1，正好落回 backfillLimit 的保护范围内。
 */
export async function invalidateFromSeq(
  chatId: string,
  fromSeq: number,
  state: MemIndexState | undefined,
): Promise<InvalidateResult> {
  if (!state) return NOOP
  const removed = await memchunksRepo.deleteFromSeq(chatId, fromSeq)
  if (!removed) return NOOP
  const next = rollback(state, fromSeq - 1)
  return { removed, state: next === state ? null : next }
}

/**
 * 把源会话的水位线换算到分支会话的新编号体系里。
 *
 * 取「≤ 原水位线的、被复制过去的最大一条」对应的新 seq。找不到就当没索引过。
 */
export function remapThroughSeq(throughSeq: number, seqMap: Map<number, number>): number {
  if (throughSeq < 0) return -1
  let best = -1
  for (const [src, dst] of seqMap) {
    if (src <= throughSeq && dst > best) best = dst
  }
  return best
}
