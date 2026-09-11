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
import { findPreset, toSpec, type EmbedModelPreset } from '../vector/presets'
import { loadIndex, recall } from './vectorIndex'
import type { PackedIndex, Hit, SearchOpts } from './search'
import { DEFAULT_SEARCH } from './search'
import type { ChatMessage } from '@/types/chat'

let embedder: Embedder | null = null
/** 当前 embedder 装的是哪个模型。换模型必须整个换掉，维度都不一样 */
let embedderModelId = ''
let packed: PackedIndex | null = null
let packedChatId = ''
/** 本轮召回结果。build() 是同步的，只能提前算好放这儿 */
let lastHits: Hit[] = []

/**
 * 取指定模型的 embedder。模型变了就把旧的整个扔掉。
 *
 * 不复用是硬性的：向量维度随模型变（512 / 768 / 384），
 * 拿旧 worker 去嵌新模型的文本只会得到维度对不上的结果，
 * 而点积那层是按 dim 手工展开的，对不上时不报错、只输出垃圾分数。
 */
export function getEmbedder(
  preset: EmbedModelPreset,
  onProgress?: (a: number, b: number) => void,
): Embedder {
  if (embedder && !embedder.dead && embedderModelId === preset.id) return embedder
  if (embedder && embedderModelId !== preset.id) {
    embedder.dispose()
    // 旧模型的打包索引也作废：维度变了，留着会算出没有意义的相似度
    releaseIndex()
  }
  embedder = new Embedder({
    model: toSpec(preset),
    ...(onProgress ? { onProgress } : {}),
  })
  embedderModelId = preset.id
  return embedder
}

/** 按 settings 里存的 id 取预设；没选或 id 失效都返回 undefined */
export function activePreset(modelId: string): EmbedModelPreset | undefined {
  return modelId ? findPreset(modelId) : undefined
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
  embedderModelId = ''
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
  preset: EmbedModelPreset
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
    const emb = getEmbedder(args.preset)
    if (emb.dead) return []
    await emb.ensure()

    if (packedChatId !== args.chatId || !packed) {
      packed = await loadIndex(args.chatId, emb.dim)
      packedChatId = args.chatId
    }
    // 为 null 可能是「还没建索引」，也可能是「索引是用别的模型建的、维度对不上」
    // —— 后者由 loadIndex 负责识别并拒绝，这里一律当作没有可召回的内容
    if (!packed) return []

    const usable = args.messages.filter((m) => !m.is_system && !m.exclude && m.mes.trim())
    const last = usable[usable.length - 1]
    if (!last) return []
    const q = usable.slice(-args.queryWindow)

    lastHits = await recall({
      idx: packed,
      queryMessages: q,
      embedder: emb,
      queryPrefix: args.preset.queryPrefix,
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
