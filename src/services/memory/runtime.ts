/**
 * 记忆运行时的单例：管住 Embedder、打包索引缓存、以及「本轮召回结果」。
 *
 * 之所以要一个单例而不是每次新建：
 *  - Embedder 背后是一个装了 100MB 模型的 Worker，绝不能每轮 spawn；
 *  - 打包索引是 N×512 的 Float32Array（几千块时是 5MB 级的 JS 堆对象），
 *    会话打开时建一次，切走时必须释放 —— 不释放的话用户切几个长会话
 *    就能把低端安卓的标签页耗死，表现是「用着用着白屏」。
 *
 * 纯 service：不 import vue/pinia。
 */

import { Embedder } from '../vector/host'
import { loadIndex, recall } from './vectorIndex'
import type { PackedIndex, Hit, SearchOpts } from './search'
import { DEFAULT_SEARCH } from './search'
import type { ChatMessage } from '@/types/chat'

export const MODEL_ID = 'Xenova/bge-small-zh-v1.5'
export const MODEL_PATH = '/models/'

let embedder: Embedder | null = null
let packed: PackedIndex | null = null
let packedChatId = ''
/** 本轮召回结果。build() 是同步的，只能提前算好放这儿 */
let lastHits: Hit[] = []

export function getEmbedder(onProgress?: (a: number, b: number) => void): Embedder {
  if (!embedder || embedder.dead) {
    embedder = new Embedder({
      localModelPath: MODEL_PATH,
      modelId: MODEL_ID,
      ...(onProgress ? { onProgress } : {}),
    })
  }
  return embedder
}

export function embedderState(): { alive: boolean; dead: boolean; reason: string } {
  return {
    alive: !!embedder && !embedder.dead,
    dead: !!embedder?.dead,
    reason: embedder?.deadReason ?? '',
  }
}

/** 切会话时必须调：释放几 MB 的打包缓存 */
export function releaseIndex(): void {
  packed = null
  packedChatId = ''
  lastHits = []
}

export function disposeAll(): void {
  releaseIndex()
  embedder?.dispose()
  embedder = null
}

export function currentHits(): Hit[] {
  return lastHits
}

export function clearHits(): void {
  lastHits = []
}

export interface PrepareArgs {
  chatId: string
  messages: ChatMessage[]
  /** 用最近几条做查询 */
  queryWindow: number
  opts?: Partial<SearchOpts>
}

/**
 * 在 `build()` **之前**调用：算好本轮召回，存进 lastHits。
 *
 * 任何失败都静默返回空结果 —— 记忆是尽力而为的增强，绝不能让它把生成搞崩。
 */
export async function prepareRecall(args: PrepareArgs): Promise<Hit[]> {
  lastHits = []
  try {
    const emb = getEmbedder()
    if (emb.dead) return []
    await emb.ensure()

    if (packedChatId !== args.chatId || !packed) {
      packed = await loadIndex(args.chatId, emb.dim)
      packedChatId = args.chatId
    }
    if (!packed) return []

    const usable = args.messages.filter((m) => !m.is_system && !m.exclude && m.mes.trim())
    const last = usable[usable.length - 1]
    if (!last) return []
    const q = usable.slice(-args.queryWindow)

    lastHits = await recall({
      idx: packed,
      queryMessages: q,
      embedder: emb,
      opts: { ...DEFAULT_SEARCH, ...args.opts, lastSeq: last.seq },
    })
    return lastHits
  } catch {
    return []
  }
}

/** 索引变了（回填完成 / 消息被删改）就让缓存失效，下次重建 */
export function invalidateIndex(chatId: string): void {
  if (packedChatId === chatId) {
    packed = null
    packedChatId = ''
  }
}
