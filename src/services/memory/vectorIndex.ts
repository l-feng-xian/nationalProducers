/**
 * 向量索引的建立与检索编排。
 *
 * 写入走**拉模式追赶**而不是推模式钩子：消息入口太多
 * （appendUser / 开场白播种 / 导入 / appendMany / swipe / regenerate），
 * 每个都挂钩子迟早漏一个。水位线追赶天然幂等、可断点续、崩溃刷新后自愈、
 * 导入的历史也会自动补上。
 *
 * 纯 service：不 import vue/pinia。
 */

import { memchunksRepo } from '@/db/repositories'
import type { MemChunk } from '@/db/schema'
import type { ChatMessage } from '@/types/chat'
import { chunkMessages, renderWindow } from './chunk'
import { packIndex, search, type Hit, type PackedIndex, type SearchOpts } from './search'
import type { Embedder } from '../vector/host'

/**
 * 索引滞后。swipe / 重新生成 / 中断续写只动最后一条 AI 消息，
 * 滞后 2 条就把 99% 的返工消灭了。**绝不索引流式中的半成品。**
 */
export const INDEX_LAG = 2
/** 一批嵌多少块。批间让出主线程，否则回填会把 UI 卡住 */
const BATCH = 8

export interface IndexState {
  /** 已索引到的最大 seq */
  throughSeq: number
  chunks: number
  model: string
  dim: number
}

export function emptyIndexState(model: string, dim: number): IndexState {
  return { throughSeq: -1, chunks: 0, model, dim }
}

export interface CatchUpArgs {
  chatId: string
  messages: ChatMessage[]
  state: IndexState
  embedder: Embedder
  model: string
  /** 只回填最近这么多条；全历史给显式按钮 */
  backfillLimit: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

export interface CatchUpResult {
  state: IndexState
  added: number
  aborted: boolean
}

/**
 * 把会话的向量索引追到最新。
 *
 * ⚠️ transformers.js 内部有全局的 webInitChain / webInferenceChain 把所有
 * session 创建与推理**串行化**，写 Promise.all 并发不会提速，别白写。
 */
export async function catchUp(args: CatchUpArgs): Promise<CatchUpResult> {
  const { chatId, messages, embedder, signal } = args
  let state = args.state

  // 换了模型，旧向量全废（维度和分布都不同）
  if (state.model !== args.model) {
    await memchunksRepo.clearChat(chatId)
    state = emptyIndexState(args.model, state.dim)
  }

  const usable = messages.filter((m) => !m.is_system && !m.exclude && m.mes.trim())
  const last = usable[usable.length - 1]
  if (!last) return { state, added: 0, aborted: false }

  const ceiling = last.seq - INDEX_LAG
  let pending = usable.filter((m) => m.seq > state.throughSeq && m.seq <= ceiling)
  if (!pending.length) return { state, added: 0, aborted: false }

  // 首次回填只做最近 N 条，否则长会话要在后台烧几分钟 CPU，手机会发烫降频
  if (state.throughSeq < 0 && pending.length > args.backfillLimit) {
    pending = pending.slice(-args.backfillLimit)
  }

  const chunks = chunkMessages(pending)
  if (!chunks.length) return { state, added: 0, aborted: false }

  let ord = state.chunks
  let added = 0
  for (let i = 0; i < chunks.length; i += BATCH) {
    if (signal?.aborted) return { state, added, aborted: true }
    // 页面不可见时暂停：后台标签页跑满 CPU 会被系统杀掉，而且很耗电
    if (typeof document !== 'undefined' && document.hidden) {
      return { state, added, aborted: true }
    }

    const batch = chunks.slice(i, i + BATCH)
    let vecs: Float32Array[]
    try {
      vecs = await embedder.embed(batch.map((c) => c.text))
    } catch {
      // 嵌入失败就停在这里，下次从同一水位线继续。绝不推进 throughSeq
      return { state, added, aborted: true }
    }

    const rows: MemChunk[] = []
    for (let k = 0; k < batch.length; k++) {
      const c = batch[k]
      const v = vecs[k]
      if (!c || !v) continue
      rows.push({
        chatId,
        kindRank: 0,
        ord: ord++,
        text: c.text,
        srcSeqs: c.srcSeqs,
        endSeq: c.endSeq,
        vec: v,
        srcHash: c.srcHash,
      })
    }
    await memchunksRepo.putMany(rows)
    added += rows.length
    const lastRow = rows[rows.length - 1]
    if (lastRow) {
      state = { ...state, throughSeq: lastRow.endSeq, chunks: ord, dim: embedder.dim }
    }
    args.onProgress?.(Math.min(i + BATCH, chunks.length), chunks.length)

    // 让出主线程一拍，否则回填期间 UI 会明显卡顿
    await new Promise((r) => setTimeout(r, 0))
  }
  return { state, added, aborted: false }
}

/** 会话打开时建一次打包缓存，之后每轮检索复用 */
export async function loadIndex(chatId: string, dim: number): Promise<PackedIndex | null> {
  const chunks = await memchunksRepo.listByChat(chatId)
  if (!chunks.length) return null
  return packIndex(chatId, chunks, dim)
}

export interface RecallArgs {
  idx: PackedIndex
  /** 查询文本 —— 必须用与索引期**同一个**渲染器，否则分布错位 */
  queryMessages: ChatMessage[]
  embedder: Embedder
  opts: SearchOpts
}

/**
 * bge 系列的**非对称检索**指令前缀。
 *
 * ⚠️ 只加在**查询侧**，文档侧绝不能加 —— 这是 bge 的设计，两边都加会把优势抵消。
 *
 * 实测（本项目真实对话样本，4 条文档）：
 *   不加前缀：相关最高 − 无关最高 = 0.053
 *   加前缀　：相关最高 − 无关最高 = 0.086（区分度 +62%）
 * 「老陈的酒馆」这条无关项从 0.418 掉到 0.335，正好被 minScore 拦住。
 * 不加不报错，只是召回里混进一堆看似沾边的噪声。
 */
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：'

export async function recall(args: RecallArgs): Promise<Hit[]> {
  const text = renderWindow(args.queryMessages)
  if (!text.trim()) return []
  const [q] = await args.embedder.embed([QUERY_PREFIX + text])
  if (!q) return []
  return search(args.idx, q, args.opts)
}
