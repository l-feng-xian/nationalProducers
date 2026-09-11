/**
 * 把对话切成可嵌入的块。
 *
 * 这个渲染器是**索引期与查询期共用的唯一函数**。一旦分叉（比如索引时带名字前缀、
 * 查询时不带），两边的向量就落在不同的分布上，召回质量会莫名其妙地烂，且极难归因。
 *
 * 纯 service：不 import vue/pinia。
 */

import { fnv1a } from '../hash'
import type { ChatMessage } from '@/types/chat'

/** 一块覆盖几条消息 */
export const WINDOW_MSGS = 4
/** 窗口步进。2 = 50% 重叠，让跨窗口的语义不会被切断 */
export const STRIDE_MSGS = 2
/**
 * 单块字符上限。
 *
 * bge-small-zh 的 max_position_embeddings = 512，而它的中文 tokenizer 基本是字级，
 * 超了会**静默截断**（不报错，你只会发现召回莫名变差）。
 * 但也别贴着 512 切 —— 4 层的浅模型在 500 字上语义已经糊了，贴上限纯属自伤。
 */
export const CHUNK_MAX_CHARS = 420
/** 太短的块信息量不足，向量近乎噪声却照样占 top-K 名额 */
export const CHUNK_MIN_CHARS = 40

export interface Chunk {
  text: string
  srcSeqs: number[]
  endSeq: number
  srcHash: number
}

/**
 * 渲染一组消息为可嵌入文本。
 *
 * 带名字前缀是这层能解一部分指代的唯一原因：模型看到的是「铃：我会等你」
 * 而不是裸的「我会等你」。省掉前缀，"她说她会等" 这类召回会大幅变差。
 *
 * `{{` 替换成全角是安全修复，且**必须在写入块时做**而不是注入时做 ——
 * 否则索引里存的和注入出去的不是同一段文本，分布错位。
 * （对话里真出现 `{{user}}` 时，注入回提示词会被宏引擎二次展开。）
 */
export function renderWindow(msgs: ChatMessage[]): string {
  return msgs
    .map((m) => `${m.name}：${m.mes}`)
    .join('\n')
    .replaceAll('{{', '｛｛')
    .replaceAll('}}', '｝｝')
    .trim()
}

/** 单条过长时按重叠子块拆开，避免静默截断 */
function splitLong(text: string, seq: number): Chunk[] {
  const out: Chunk[] = []
  const step = Math.floor(CHUNK_MAX_CHARS * 0.8) // 20% 重叠
  for (let i = 0; i < text.length; i += step) {
    const piece = text.slice(i, i + CHUNK_MAX_CHARS).trim()
    if (piece.length < CHUNK_MIN_CHARS && out.length) break
    out.push({ text: piece, srcSeqs: [seq], endSeq: seq, srcHash: fnv1a(piece) })
    if (i + CHUNK_MAX_CHARS >= text.length) break
  }
  return out
}

/**
 * 把消息切成滑动窗口块。
 *
 * 单条消息单独嵌入不够用，有两个独立原因：
 *  1. 角色扮演里用户轮常是 5–40 字（「嗯」「然后呢」），向量近乎噪声；
 *  2. 「她说她会等」单独嵌入时语义中心落在「等待/承诺」，主语全丢。
 * 滑动窗口 + 名字前缀同时解决这两条。
 */
export function chunkMessages(msgs: ChatMessage[]): Chunk[] {
  const usable = msgs.filter((m) => !m.is_system && !m.exclude && m.mes.trim())
  const out: Chunk[] = []
  if (!usable.length) return out

  for (let i = 0; i < usable.length; i += STRIDE_MSGS) {
    const win = usable.slice(i, i + WINDOW_MSGS)
    if (!win.length) break
    let text = renderWindow(win)

    // 太短就往前多吃两条，最多扩到 6 条
    let extra = 0
    while (text.length < CHUNK_MIN_CHARS && win.length + extra < 6) {
      extra += 1
      const wider = usable.slice(i, i + WINDOW_MSGS + extra)
      if (wider.length === win.length + extra - 1) break
      text = renderWindow(wider)
      if (wider.length >= usable.length - i) break
    }
    if (text.length < CHUNK_MIN_CHARS) continue

    const seqs = win.map((m) => m.seq)
    const last = seqs[seqs.length - 1]
    if (last === undefined) continue

    if (text.length > CHUNK_MAX_CHARS) {
      // 窗口整体超长：按单条拆，保证每个子块都在模型窗口内
      for (const m of win) {
        const one = renderWindow([m])
        if (one.length > CHUNK_MAX_CHARS) out.push(...splitLong(one, m.seq))
        else if (one.length >= CHUNK_MIN_CHARS) {
          out.push({ text: one, srcSeqs: [m.seq], endSeq: m.seq, srcHash: fnv1a(one) })
        }
      }
      continue
    }

    out.push({ text, srcSeqs: seqs, endSeq: last, srcHash: fnv1a(text) })
    if (i + WINDOW_MSGS >= usable.length) break
  }
  return out
}
