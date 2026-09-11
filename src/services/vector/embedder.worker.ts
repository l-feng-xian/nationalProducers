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
 */

/// <reference lib="webworker" />
import wasmPaths from './wasm'

// 没有这行，TS 会把 self 推断成 Window，postMessage 的 transfer 参数重载对不上
declare const self: DedicatedWorkerGlobalScope

export interface InitMsg {
  type: 'init'
  /** 模型目录的前缀，如 `/models/`。模型自托管在 public/ 下，同源加载 */
  localModelPath: string
  modelId: string
}
export interface EmbedMsg {
  type: 'embed'
  id: number
  texts: string[]
}
export type InMsg = InitMsg | EmbedMsg

export type OutMsg =
  | { type: 'ready'; dim: number }
  | { type: 'progress'; loaded: number; total: number; file: string }
  | { type: 'embedded'; id: number; vecs: Float32Array[]; dim: number }
  | { type: 'error'; id?: number; message: string }

type Extractor = (
  texts: string[],
  opts: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<{ dims: number[]; data: Float32Array }>

let extractor: Extractor | null = null
let dim = 0

async function init(msg: InitMsg): Promise<void> {
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

  // 模型随应用发布，同源加载：不走 HF、不需要断点续传、不占用户存储配额
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = msg.localModelPath

  const pipe = await tf.pipeline('feature-extraction', msg.modelId, {
    // q8 单文件。**不要用外部权重格式**（图 + .onnx_data 两个文件）——
    // 那是 ORT issue #26858 的触发条件：session 创建无限挂起，无报错无超时。
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p: unknown) => {
      const o = p as { status?: string; loaded?: number; total?: number; file?: string }
      if (o.status === 'progress' && o.total) {
        post({ type: 'progress', loaded: o.loaded ?? 0, total: o.total, file: o.file ?? '' })
      }
    },
  })
  extractor = pipe as unknown as Extractor

  // 探针推理：ORT 有一类失败是「创建成功但推理出 NaN/全零」，只能靠实际跑一次发现
  const probe = await extractor(['测试向量'], { pooling: 'cls', normalize: true })
  dim = probe.dims[probe.dims.length - 1] ?? 0
  if (!dim) throw new Error('模型返回的向量维度为 0')
  post({ type: 'ready', dim })
}

function post(m: OutMsg, transfer?: Transferable[]): void {
  if (transfer) self.postMessage(m, transfer)
  else self.postMessage(m)
}

self.onmessage = async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data
  try {
    if (msg.type === 'init') {
      await init(msg)
      return
    }
    if (msg.type === 'embed') {
      if (!extractor) throw new Error('模型尚未就绪')
      // pooling 必须是 'cls' —— bge 全系用 CLS。写成示例里最常见的 'mean'
      // 不会报错，只会静默掉几个点的检索质量。
      const out = await extractor(msg.texts, { pooling: 'cls', normalize: true })
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
  } catch (e) {
    const id = 'id' in msg ? msg.id : undefined
    post({ type: 'error', ...(id !== undefined ? { id } : {}), message: errText(e) })
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
