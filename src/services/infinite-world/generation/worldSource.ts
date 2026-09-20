/**
 * 主线程门面：起 Worker、报进度、取消、缓存。
 *
 * ## ⭐ 缓存的是 WorldGrid **本体**
 * 创建向导的预览、点「创建」之后的正式生成、进入游戏时的加载 ——
 * 三处拿到的是**同一个 grid 实例**。于是「相同种子与版本，三处结果相同」
 * 这条验收从「需要测的性质」变成「构造上如此」。
 *
 * ## ⚠️ Worker 不可用时同步回退
 * 老浏览器、某些 WebView、以及 Node 下的验证脚本都没有 Worker。
 * 回退路径跑的是**同一个 pipeline**，只是会卡住主线程约 1 秒 ——
 * 页面已有遮罩，可以接受。绝不能因为没有 Worker 就整个功能不可用。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { hashObject } from '@/services/hash'
import { toPlain } from '@/utils/plain'
import { buildWorld, GENERATOR_VERSION, type BuildWorldInput } from './pipeline'
import type { WorldGrid } from './grid'
import type { WorkerRequest, WorkerResponse } from './world.worker'

export interface BuildRequest {
  seed: string
  settings: BuildWorldInput['settings']
  generatorVersion?: string
  signal?: AbortSignal
  onProgress?: (step: string, ratio: number) => void
}

/** 缓存键：只由「决定世界长什么样」的三件事构成 */
export function buildKey(r: Pick<BuildRequest, 'seed' | 'settings' | 'generatorVersion'>): string {
  return `${r.generatorVersion ?? GENERATOR_VERSION}|${r.seed}|${hashObject(r.settings)}`
}

/**
 * LRU 缓存。上限 3：同时最多比较「当前草稿 / 上一版 / 已打开的世界」。
 *
 * ⚠️ 一张 grid 约 3.3 MB，上限不能设大。
 */
const cache = new Map<string, WorldGrid>()
const CACHE_LIMIT = 3

function remember(key: string, grid: WorldGrid): WorldGrid {
  cache.delete(key)
  cache.set(key, grid)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return grid
}

export function peekCache(key: string): WorldGrid | undefined {
  return cache.get(key)
}

export function clearWorldCache(): void {
  cache.clear()
}

// ── Worker 生命周期 ──
let worker: Worker | null = null
let nextJobId = 1

function ensureWorker(): Worker | null {
  if (worker) return worker
  if (typeof Worker === 'undefined') return null
  try {
    // vite.config.ts 已配 `worker.format: 'es'`，可以直接用 module worker
    worker = new Worker(new URL('./world.worker.ts', import.meta.url), { type: 'module' })
    return worker
  } catch {
    return null
  }
}

/** 主动释放 Worker（路由离开时调用，避免后台常驻一个空闲线程） */
export function disposeWorldWorker(): void {
  worker?.terminate()
  worker = null
}

export async function buildWorldAsync(req: BuildRequest): Promise<WorldGrid> {
  const key = buildKey(req)
  const hit = cache.get(key)
  if (hit) {
    req.onProgress?.('完成', 1)
    return remember(key, hit)
  }

  const w = ensureWorker()
  if (!w) {
    // ── 同步回退 ──
    const grid = buildWorld({
      seed: req.seed,
      generatorVersion: req.generatorVersion,
      settings: toPlain(req.settings),
      signal: req.signal
        ? {
            get aborted() {
              return req.signal!.aborted
            },
          }
        : undefined,
      onProgress: req.onProgress,
    })
    return remember(key, grid)
  }

  const jobId = nextJobId++

  return new Promise<WorldGrid>((resolve, reject) => {
    const onAbort = () => {
      w.postMessage({ type: 'cancel' })
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })

    const cleanup = () => {
      w.removeEventListener('message', onMessage)
      req.signal?.removeEventListener('abort', onAbort)
    }

    const onMessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data
      // ⚠️ 过期请求直接丢弃。拖动种子滑杆会连发好几次，
      // 晚到的结果必须能识别出「这不是当前要的那个」
      if (msg.jobId !== jobId) return

      if (msg.type === 'progress') {
        req.onProgress?.(msg.step, msg.ratio)
        return
      }
      cleanup()
      if (msg.type === 'done') {
        resolve(remember(key, msg.grid as WorldGrid))
      } else if (msg.type === 'cancelled') {
        reject(new DOMException('世界生成已取消', 'AbortError'))
      } else {
        reject(new Error(msg.message))
      }
    }

    w.addEventListener('message', onMessage)
    // ⚠️ 必须 toPlain()。
    //
    // `settings` 多半来自 Vue 的 reactive 草稿，而 **postMessage 走结构化克隆，
    // 克隆不了 Proxy** —— 抛的是 "could not be cloned"，而且在 Vue 里
    // 常常被 computed/watch 吞掉，表现为「预览一直转圈但没有任何报错」。
    //
    // 项目里这条铁律原本记在 db.put 那条路径上（见 utils/plain.ts）。
    // Worker 是它的**第二个入口**，同样要守。修在这里而不是各调用处，
    // 是因为这是数据跨进 Worker 的唯一关口。
    const request: WorkerRequest = {
      jobId,
      seed: req.seed,
      settings: toPlain(req.settings),
      generatorVersion: req.generatorVersion,
    }
    w.postMessage(request)
  })
}

/**
 * 同步生成，供验证脚本与没有 Worker 的环境使用。
 *
 * ⚠️ 会卡住调用线程约 1 秒。UI 路径请用 `buildWorldAsync`。
 */
export function buildWorldSync(req: Omit<BuildRequest, 'signal'>): WorldGrid {
  const key = buildKey(req)
  const hit = cache.get(key)
  if (hit) return remember(key, hit)
  const grid = buildWorld({
    seed: req.seed,
    settings: req.settings,
    onProgress: req.onProgress,
    generatorVersion: req.generatorVersion,
  })
  return remember(key, grid)
}
