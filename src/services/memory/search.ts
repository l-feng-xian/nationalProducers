/**
 * 向量检索。
 *
 * 真正的瓶颈**不是点积**（5000×512 在桌面大核上约 6ms），而是
 * IDB 反序列化几千条记录（50–125ms）。所以打包缓存要在会话打开时一次建好，
 * 之后每轮检索都复用。
 *
 * 纯 service：不 import vue/pinia。
 */

import type { MemChunk } from '@/db/schema'

/** 打包好的会话向量集。连续 buffer 比 N 个独立 Float32Array 快 2–5 倍 */
export interface PackedIndex {
  chatId: string
  dim: number
  /** N × dim 的连续缓冲 */
  data: Float32Array
  meta: { text: string; srcSeqs: number[]; endSeq: number; kindRank: 0 | 1 }[]
}

export function packIndex(chatId: string, chunks: MemChunk[], dim: number): PackedIndex {
  const n = chunks.length
  const data = new Float32Array(n * dim)
  const meta: PackedIndex['meta'] = []
  for (let i = 0; i < n; i++) {
    const c = chunks[i]
    if (!c) continue
    data.set(c.vec, i * dim)
    meta.push({ text: c.text, srcSeqs: c.srcSeqs, endSeq: c.endSeq, kindRank: c.kindRank })
  }
  return { chatId, dim, data, meta }
}

export interface Hit {
  text: string
  score: number
  srcSeqs: number[]
  endSeq: number
  kindRank: 0 | 1
}

export interface SearchOpts {
  topK: number
  /** 排除最近这么多条消息 —— 它们本来就在历史里，召回等于白烧 token */
  recentExclude: number
  /** 当前最大 seq */
  lastSeq: number
  /** LLM 事实的加成（信息密度高、无噪声）与名额上限 */
  factBonus: number
  maxFacts: number
  /**
   * 绝对下限，只用来兜底「整个会话里压根没有相关内容」。
   *
   * ⚠️ 别指望它筛掉噪声。实测（32 条真实对话、14 块、查询问「刀上的崩口」）：
   *   相关块 0.6151 / 0.6137 / 0.5957，纯填充块 0.5783 / 0.5667 / 0.5645
   * 换一个查询整档分数会一起漂 0.1 以上。这个 4 层浅模型给出的是**可靠的排序**
   * 和**不可靠的绝对值** —— 任何固定阈值要么全放过要么全拦死。
   * 判相关性靠下面的 minRatio，这里放低即可。
   */
  minScore: number
  /**
   * 相对截断：低于「最高分 × minRatio」的一律丢掉。
   *
   * 这才是真正起作用的那道闸。它问的是「跟最相关的那条比，这条还沾边吗」，
   * 因此不受整档分数漂移的影响。
   *
   * 0.93 是按上面那组实测选的：
   *   0.6151×0.93 = 0.572 → 三条断刀片段全留，0.5783 的填充块正好挡掉；
   *   换个问法时 0.5882×0.93 = 0.547，留下最相关的一条，同样不放噪声进来。
   * 配合 topK 的语义是「最多 K 条」而**不是「凑满 K 条」** —— 只有一条相关就只给一条。
   * 白烧 token 还只是小事，把无关往事塞进上下文会让模型真的去接那个话茬。
   */
  minRatio: number
}

export const DEFAULT_SEARCH: SearchOpts = {
  topK: 3,
  recentExclude: 20,
  lastSeq: 0,
  factBonus: 0.04,
  maxFacts: 2,
  minScore: 0.4,
  minRatio: 0.93,
}

/**
 * 检索 top-K。
 *
 * 向量写入时已 L2 归一化，所以余弦退化成**纯点积** —— 省掉 N 次 sqrt、
 * N 次除法和 2N 次乘加，内循环降到三分之一。再手动 4 路展开，V8 上还能拿 20–30%。
 */
export function search(idx: PackedIndex, query: Float32Array, opts: SearchOpts): Hit[] {
  const { dim, data, meta } = idx
  const n = meta.length
  const cut = opts.lastSeq - opts.recentExclude
  const scored: Hit[] = []

  for (let i = 0; i < n; i++) {
    const m = meta[i]
    if (!m) continue
    // 最近的片段本来就在历史里，召回它等于花 token 说一遍刚说过的话
    if (m.endSeq > cut) continue

    const base = i * dim
    let s0 = 0
    let s1 = 0
    let s2 = 0
    let s3 = 0
    let j = 0
    for (; j + 3 < dim; j += 4) {
      s0 += (data[base + j] ?? 0) * (query[j] ?? 0)
      s1 += (data[base + j + 1] ?? 0) * (query[j + 1] ?? 0)
      s2 += (data[base + j + 2] ?? 0) * (query[j + 2] ?? 0)
      s3 += (data[base + j + 3] ?? 0) * (query[j + 3] ?? 0)
    }
    for (; j < dim; j++) s0 += (data[base + j] ?? 0) * (query[j] ?? 0)
    let score = s0 + s1 + s2 + s3
    // 坏向量（NaN / 全零）在这里自然被滤掉，不需要单独一趟校验
    if (!Number.isFinite(score)) continue
    if (m.kindRank === 1) score += opts.factBonus
    if (score < opts.minScore) continue
    scored.push({ text: m.text, score, srcSeqs: m.srcSeqs, endSeq: m.endSeq, kindRank: m.kindRank })
  }

  scored.sort((a, b) => b.score - a.score)

  // 相对截断的地板。注意它是在**去重之前**按全体最高分算的：
  // 若放在去重之后按幸存者算，一条因重叠被丢掉的高分块会把地板一起带走，
  // 空出来的名额就又被噪声填上了 —— 这正是实测里第三条召回变成
  // 「老陈的酒馆 / 屋顶漏雨」的原因。
  const floor = (scored[0]?.score ?? 0) * opts.minRatio

  // 去重必做：窗口有 50% 重叠，top-3 极易是同一场戏的三个相邻窗口，
  // 白烧 400 token 说同一件事。用 srcSeqs 求交集既精确又免费，
  // 比在向量之间做 MMR 又快又准。
  const out: Hit[] = []
  const used = new Set<number>()
  let facts = 0
  for (const h of scored) {
    if (out.length >= opts.topK) break
    // 已按分数降序，够不着地板就不会再有够得着的了
    if (h.score < floor) break
    if (h.kindRank === 1 && facts >= opts.maxFacts) continue
    if (h.srcSeqs.some((s) => used.has(s))) continue
    out.push(h)
    for (const s of h.srcSeqs) used.add(s)
    if (h.kindRank === 1) facts++
  }
  return out
}
