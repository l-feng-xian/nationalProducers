/**
 * 嵌入 Worker。**全项目唯一一处 import transformers.js 的地方。**
 *
 * 三个理由决定了它必须在 Worker 里，而不是主线程：
 *
 * 1. transformers.js 源码末尾写死 `ONNX_ENV.wasm.proxy = false`，WASM 推理默认
 *    跑在调用它的线程上。一块 0.3–0.6s 的同步计算会**冻住 UI 和流式打字机动画**。
 * 2. `WebAssembly.Memory` 一旦 grow 就**永不归还系统**，`session.release()` 只是把
 *    arena 还给 ORT 内部分配器。`worker.terminate()` 是唯一能把那 100MB 真正还给
 *    系统的手段 —— 对低端安卓这是生死线。
 * 3. 任何静态 `import { env } from '@huggingface/transformers'`（哪怕只是在 store 里
 *    读一个 flag）都会把整个 1.05MB 的库拖进主 chunk，彻底毁掉「不开记忆就一个字节
 *    都不下载」的承诺。**类型 import 是安全的（会被擦除），值 import 不是。**
 *
 * 它同时服务两类调用方：推理（Embedder）与模型管理（ModelManager）。共用一个
 * worker **文件**但各自 new 一个实例 —— 下载动辄几分钟，不能和推理挤在一个
 * 生命周期里，否则「取消下载」就得连带干掉正在用的模型。
 */

/// <reference lib="webworker" />
import wasmPaths from './wasm'
import type { ModelSpec } from './presets'

// 没有这行，TS 会把 self 推断成 Window，postMessage 的 transfer 参数重载对不上
declare const self: DedicatedWorkerGlobalScope

export interface InitMsg {
  type: 'init'
  model: ModelSpec
}
export interface EmbedMsg {
  type: 'embed'
  id: number
  texts: string[]
}
/** 查这些模型是否已完整下载到浏览器缓存 */
export interface CheckMsg {
  type: 'check'
  ids: string[]
}
export interface DownloadMsg {
  type: 'download'
  model: ModelSpec
}
export interface RemoveMsg {
  type: 'remove'
  id: string
}
export type InMsg = InitMsg | EmbedMsg | CheckMsg | DownloadMsg | RemoveMsg

export type OutMsg =
  | { type: 'ready'; dim: number }
  | { type: 'progress'; loaded: number; total: number; file: string }
  | { type: 'embedded'; id: number; vecs: Float32Array[]; dim: number }
  | { type: 'checked'; cached: Record<string, boolean> }
  | { type: 'downloaded'; id: string }
  | { type: 'removed'; id: string }
  | { type: 'error'; id?: number; message: string }

type Tf = typeof import('@huggingface/transformers')

type Extractor = (
  texts: string[],
  opts: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>

const TASK = 'feature-extraction'
const DTYPE = 'q8'

let extractor: Extractor | null = null
let pooling: 'cls' | 'mean' = 'cls'
let dim = 0

/**
 * 配好 env 并返回 transformers 模块。
 *
 * ⚠️ `allowLocalModels` 必须**恒为 false**，这条是踩出来的，代价很大：
 *
 * 模型不再随应用发布，`/models/...` 已经不存在。而 SPA 托管（vite dev、preview、
 * Netlify、Vercel…）对未知路径的回落是 **200 + index.html**，不是 404。
 * allowLocalModels 为 true 时，未命中缓存的文件会先去那里探一次，拿回一份 HTML；
 * `loadResourceFile` 只看状态码是不是 200 就把它**写进 Cache Storage**，键是本地路径。
 *
 * 于是缓存被永久毒化：此后每次加载都先命中这条 HTML 条目，而**缓存命中会短路掉
 * 所有 allow 开关**，重试、换配置、改 env 全都没用，报错永远是
 * 「Unexpected token '<'」，看不出跟本地路径有任何关系。只有手动清掉整个
 * Cache Storage 才能恢复。
 *
 * 连带的代价：不能用 `local_files_only` 来表达「只用缓存、绝不联网」——
 * 它有一道守卫要求 allowLocalModels 为 true（allowLocalModels=false +
 * local_files_only=true 直接抛错）。所以「不许联网」改由调用方在 pipeline **之前**
 * 用 is_pipeline_cached 把关，见 init()。
 */
async function setup(): Promise<Tf> {
  const tf = await import('@huggingface/transformers')
  const env = tf.env

  const wasmEnv = env.backends.onnx.wasm
  if (!wasmEnv) throw new Error('onnxruntime-web 的 wasm 后端不可用')
  // wasmPaths 必须是**同时带 .wasm 与 .mjs 两个键的对象**：
  // v4 源码里 shouldUseWasmCache 的守卫要求如此，老文档里的字符串写法
  // 不报错，只是静默禁用 WASM 缓存。
  wasmEnv.wasmPaths = wasmPaths
  // 不追求多线程：需要 COOP/COEP 跨源隔离，而那会拦掉角色卡外链头像和外部字体，
  // 静态托管也多半配不了。换来的 2.5× 只作用在批量回填这一个非交互场景。
  wasmEnv.numThreads = 1
  wasmEnv.proxy = false

  env.allowLocalModels = false
  env.allowRemoteModels = true
  return tf
}

function onProgress(p: unknown): void {
  const o = p as { status?: string; loaded?: number; total?: number; file?: string }
  if (o.status === 'progress' && o.total) {
    post({ type: 'progress', loaded: o.loaded ?? 0, total: o.total, file: o.file ?? '' })
  }
}

async function init(msg: InitMsg): Promise<void> {
  const tf = await setup()
  pooling = msg.model.pooling

  // 前置检查是「没下载就绝不联网」这条承诺的**唯一**执行点 ——
  // allowRemoteModels 恒为 true（见 setup 的说明，它不能为 false），
  // 所以少了这一步，启用一个没下载的模型就会静默地从 HF 拉几十 MB。
  // 顺带也把错误变成一句人话，而不是 pipeline 深处的某个解析失败。
  const ready = await tf.ModelRegistry.is_pipeline_cached(TASK, msg.model.id, { dtype: DTYPE })
  if (!ready) throw new Error('模型尚未下载完成，请到「模型管理」里下载后再启用')

  const pipe = await tf.pipeline(TASK, msg.model.id, {
    // q8 单文件。**不要用外部权重格式**（图 + .onnx_data 两个文件）——
    // 那是 ORT issue #26858 的触发条件：session 创建无限挂起，无报错无超时。
    dtype: DTYPE,
    device: 'wasm',
    progress_callback: onProgress,
  })
  extractor = pipe as unknown as Extractor

  // 探针推理：ORT 有一类失败是「创建成功但推理出 NaN/全零」，只能靠实际跑一次发现
  const probe = await extractor(['测试向量'], { pooling, normalize: true })
  dim = probe.dims[probe.dims.length - 1] ?? 0
  if (!dim) throw new Error('模型返回的向量维度为 0')
  post({ type: 'ready', dim })
}

/**
 * 下载：让 transformers 自己走一遍完整加载流程，文件顺路落进浏览器缓存。
 *
 * 刻意不自己写 fetch + 存库。缓存键是 transformers 内部按
 * `buildResourcePaths` 算出来的（远程 URL），自己拼一份迟早对不上 ——
 * 那种错的表现是「显示已下载，但用的时候还是去联网」，很难发现。
 * 让它自己下、自己存，键天然一致。
 */
async function download(msg: DownloadMsg): Promise<void> {
  const tf = await setup()
  // 全项目**唯一**不做前置缓存检查就调 pipeline 的地方 ——
  // 也就是唯一允许产生网络流量的地方。其它入口都先过 is_pipeline_cached。
  const pipe = await tf.pipeline(TASK, msg.model.id, {
    dtype: DTYPE,
    device: 'wasm',
    progress_callback: onProgress,
  })
  // 跑一次再报成功：只「加载成功」不足以说明模型可用，
  // ORT 有「建得出 session 但推理出 NaN」这一类失败
  const probe = (await (pipe as unknown as Extractor)(['测试向量'], {
    pooling: msg.model.pooling,
    normalize: true,
  })) as { dims: number[] }
  if (!probe.dims[probe.dims.length - 1]) throw new Error('模型下载完成但推理异常')
  post({ type: 'downloaded', id: msg.model.id })
}

async function check(msg: CheckMsg): Promise<void> {
  const tf = await setup()
  const cached: Record<string, boolean> = {}
  for (const id of msg.ids) {
    try {
      cached[id] = await tf.ModelRegistry.is_pipeline_cached(TASK, id, { dtype: DTYPE })
    } catch {
      // 查不出来一律按「没下载」处理：宁可让用户多点一次下载，
      // 也不要显示「已下载」然后在真正用的时候才炸
      cached[id] = false
    }
  }
  post({ type: 'checked', cached })
}

async function remove(msg: RemoveMsg): Promise<void> {
  const tf = await setup()
  await tf.ModelRegistry.clear_cache(msg.id, { dtype: DTYPE })
  post({ type: 'removed', id: msg.id })
}

function post(m: OutMsg, transfer?: Transferable[]): void {
  if (transfer) self.postMessage(m, transfer)
  else self.postMessage(m)
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data
  try {
    switch (msg.type) {
      case 'init':
        await init(msg)
        return
      case 'check':
        await check(msg)
        return
      case 'download':
        await download(msg)
        return
      case 'remove':
        await remove(msg)
        return
      case 'embed': {
        if (!extractor) throw new Error('模型尚未就绪')
        // pooling 由预设决定：bge 系是 'cls'，e5 系是 'mean'。
        // 写错不会报错，只会静默掉几个点的检索质量。
        const out = await extractor(msg.texts, { pooling, normalize: true })
        const d = out.dims[out.dims.length - 1] ?? dim
        const vecs: Float32Array[] = []
        for (let i = 0; i < msg.texts.length; i++) {
          vecs.push(new Float32Array(out.data.subarray(i * d, (i + 1) * d)))
        }
        post(
          { type: 'embedded', id: msg.id, vecs, dim: d },
          vecs.map((v) => v.buffer),
        )
        return
      }
    }
  } catch (e) {
    const id = 'id' in msg ? msg.id : undefined
    post({ type: 'error', ...(typeof id === 'number' ? { id } : {}), message: errText(e) })
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
