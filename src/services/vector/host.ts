/**
 * 嵌入 Worker 的宿主：生命周期 + 三件套防护。
 *
 * ORT 有**四类**失败，而 try/catch 只能接住其中两类：
 *  1. 创建期抛异常      —— catch 得住
 *  2. 运行期崩溃        —— catch 得住
 *  3. 静默坏结果        —— catch 不住，只能**校验输出**（NaN / 全零 / 范数为 0）
 *  4. 永远不 resolve    —— catch 不住，只能**超时**
 *     （ORT issue #26858：外部权重格式 + 多线程时 session 创建无限挂起，
 *       无报错、无 console 输出，至今未修。我们用单文件 q8 规避了触发条件，
 *       但超时保护仍然必须有 —— 挂起时用户看到的是「点了没反应」。）
 *
 * 所以超时 + 输出校验 + 连续失败降级，三者缺一不可。
 *
 * 纯 service：不 import vue/pinia。**绝不静态 import transformers.js** ——
 * 那会把 1.05MB 拖进主 chunk，毁掉「不开就零字节」。
 */

import type { InMsg, OutMsg } from './embedder.worker'
import type { ModelSpec } from './presets'

const INIT_TIMEOUT = 90_000
const EMBED_TIMEOUT = 30_000
/** 空闲这么久就 terminate。WebAssembly.Memory 只有 terminate 能真正还给系统 */
const IDLE_MS = 5 * 60_000
/** 连续这么多次异常就永久降级，不再反复重试折磨用户 */
const MAX_STRIKES = 2

export interface EmbedderOpts {
  /** 用哪个模型。它决定向量维度，换了就等于整套索引作废 */
  model: ModelSpec
  onProgress?: (loaded: number, total: number) => void
}

export class Embedder {
  #worker: Worker | null = null
  #ready: Promise<number> | null = null
  #dim = 0
  #seq = 0
  #pending = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }>()
  #idleTimer: ReturnType<typeof setTimeout> | null = null
  #strikes = 0
  #dead = false
  #deadReason = ''

  constructor(private opts: EmbedderOpts) {}

  get dim(): number {
    return this.#dim
  }
  get dead(): boolean {
    return this.#dead
  }
  get deadReason(): string {
    return this.#deadReason
  }

  /** 加载模型。重复调用返回同一个 promise */
  ensure(): Promise<number> {
    if (this.#dead) return Promise.reject(new Error(this.#deadReason))
    if (this.#ready) return this.#ready
    this.#ready = this.#boot()
    return this.#ready
  }

  async #boot(): Promise<number> {
    const w = new Worker(new URL('./embedder.worker.ts', import.meta.url), { type: 'module' })
    this.#worker = w
    w.onmessage = (ev: MessageEvent<OutMsg>) => this.#onMessage(ev.data)
    w.onerror = (e) => this.#fail(new Error(`Worker 出错：${e.message || '未知'}`))

    const dim = await this.#withTimeout(
      new Promise<number>((resolve, reject) => {
        this.#bootResolve = resolve
        this.#bootReject = reject
        this.#post({ type: 'init', model: this.opts.model })
      }),
      INIT_TIMEOUT,
      '模型加载超时',
    )
    this.#dim = dim
    this.#touch()
    return dim
  }

  #bootResolve: ((n: number) => void) | null = null
  #bootReject: ((e: Error) => void) | null = null

  #onMessage(m: OutMsg): void {
    if (m.type === 'progress') {
      this.opts.onProgress?.(m.loaded, m.total)
      return
    }
    if (m.type === 'ready') {
      this.#bootResolve?.(m.dim)
      this.#bootResolve = null
      return
    }
    if (m.type === 'embedded') {
      const p = this.#pending.get(m.id)
      if (!p) return
      this.#pending.delete(m.id)
      // 类型 3 的防护：坏向量只能靠校验发现
      const bad = m.vecs.find((v) => !isHealthy(v))
      if (bad) {
        this.#strike('模型返回了无效向量（NaN 或全零）')
        p.reject(new Error('模型返回了无效向量'))
        return
      }
      this.#strikes = 0
      p.resolve(m.vecs)
      return
    }
    // checked / downloaded / removed 是给 ModelManager 的，推理宿主收到就忽略。
    // 少了这一行会掉进下面的 error 分支，把一条正常回执当成失败去 strike。
    if (m.type !== 'error') return

    if (m.id !== undefined) {
      const p = this.#pending.get(m.id)
      this.#pending.delete(m.id)
      p?.reject(new Error(m.message))
    } else {
      this.#bootReject?.(new Error(m.message))
      this.#bootReject = null
    }
    this.#strike(m.message)
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (!texts.length) return []
    await this.ensure()
    this.#touch()
    const id = ++this.#seq
    const p = new Promise<Float32Array[]>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#post({ type: 'embed', id, texts })
    })
    return this.#withTimeout(p, EMBED_TIMEOUT, '嵌入超时')
  }

  #post(m: InMsg): void {
    this.#worker?.postMessage(m)
  }

  async #withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let t: ReturnType<typeof setTimeout> | null = null
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, rej) => {
          t = setTimeout(() => rej(new Error(what)), ms)
        }),
      ])
    } catch (e) {
      if (e instanceof Error && e.message === what) this.#strike(what)
      throw e
    } finally {
      if (t) clearTimeout(t)
    }
  }

  #strike(reason: string): void {
    this.#strikes++
    if (this.#strikes >= MAX_STRIKES) this.#fail(new Error(reason))
  }

  #fail(e: Error): void {
    this.#dead = true
    this.#deadReason = e.message
    for (const [, p] of this.#pending) p.reject(e)
    this.#pending.clear()
    this.dispose()
  }

  /** 空闲计时。terminate 是唯一能把那 100MB 真正还给系统的手段 */
  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => this.dispose(), IDLE_MS)
  }

  dispose(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = null
    this.#worker?.terminate()
    this.#worker = null
    this.#ready = null
  }
}

/** 全零、NaN、Inf 都要判死。范数阈值取 1e-6 而不是 0，防浮点误差 */
function isHealthy(v: Float32Array): boolean {
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    if (x === undefined || !Number.isFinite(x)) return false
    sum += x * x
  }
  return sum > 1e-6
}
