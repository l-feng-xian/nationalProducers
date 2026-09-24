/**
 * 模型管理的 Worker 宿主：查缓存 / 下载 / 删除。
 *
 * 为什么不复用 Embedder 那个实例：
 *  - 下载动辄几分钟，而 Embedder 有 5 分钟空闲自杀和「连续失败两次就永久降级」，
 *    两套生命周期规则冲突；
 *  - 「取消下载」的唯一可靠手段是 terminate，若共用实例就会把正在服务的模型一起干掉；
 *  - 下载用的 worker 允许联网，推理用的不允许。分开之后这条边界是物理的，不靠记性。
 *
 * 每次操作用完即弃：这些操作都是低频的人工动作，留着一个装了 1MB 库的 worker
 * 常驻没有意义。
 *
 * 纯 service：不 import vue/pinia。
 */

import type { InMsg, ManagedTask, OutMsg } from './embedder.worker'
import type { ModelSpec } from './presets'
import { getRemoteHost } from '../ml/downloadHost'
import { attachFetchRelay } from '../ml/fetchRelay'

const CHECK_TIMEOUT = 30_000
const REMOVE_TIMEOUT = 60_000
/** 下载不设总时长上限：100MB 在弱网上就是能跑很久。卡死靠「无进展」判定 */
const STALL_TIMEOUT = 120_000

export interface DownloadProgress {
  /** 当前文件已收字节 */
  loaded: number
  total: number
  file: string
}

/** 一次性起一个 worker，发一条消息，等到目标回执或出错，然后一定 terminate */
function once<T>(
  msg: InMsg,
  accept: (m: OutMsg) => T | undefined,
  opts: { timeout: number; onProgress?: (p: DownloadProgress) => void } = {
    timeout: CHECK_TIMEOUT,
  },
): { promise: Promise<T>; cancel: () => void } {
  const w = new Worker(new URL('./embedder.worker.ts', import.meta.url), { type: 'module' })
  // 原生壳里模型下载改由主线程代发（Worker 里用不了 plugin-http），必须早于业务消息
  attachFetchRelay(w)
  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false

  const done = () => {
    settled = true
    if (timer) clearTimeout(timer)
    w.terminate()
  }

  const promise = new Promise<T>((resolve, reject) => {
    // 每收到一次进展就把计时器推后 —— 用「多久没动静」而不是「总共跑了多久」
    // 来判死，否则弱网下载大模型会被自己的超时误杀
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        done()
        reject(new Error('操作超时，长时间没有进展'))
      }, opts.timeout)
    }
    arm()

    w.onerror = (e) => {
      if (settled) return
      done()
      reject(new Error(`Worker 出错：${e.message || '未知'}`))
    }
    w.onmessage = (ev: MessageEvent<OutMsg>) => {
      if (settled) return
      const m = ev.data
      if (m.type === 'progress') {
        arm()
        opts.onProgress?.({ loaded: m.loaded, total: m.total, file: m.file })
        return
      }
      if (m.type === 'error') {
        done()
        reject(new Error(m.message))
        return
      }
      const got = accept(m)
      if (got !== undefined) {
        done()
        resolve(got)
      }
    }
    w.postMessage(msg)
  })

  return {
    promise,
    cancel: () => {
      if (settled) return
      done()
    },
  }
}

/**
 * 查这些模型是否已完整下载。查不出来一律当作「没下载」。
 * `task` 缺省是嵌入；管深度模型时传 'depth-estimation'。
 */
export async function checkCached(
  ids: string[],
  task?: ManagedTask,
): Promise<Record<string, boolean>> {
  if (!ids.length) return {}
  const { promise } = once<Record<string, boolean>>(
    { type: 'check', ids, host: getRemoteHost(), ...(task ? { task } : {}) },
    (m) => (m.type === 'checked' ? m.cached : undefined),
    { timeout: CHECK_TIMEOUT },
  )
  return promise
}

export interface DownloadHandle {
  promise: Promise<string>
  cancel: () => void
}

/**
 * 下载模型到浏览器缓存。
 *
 * 取消 = terminate worker。已经下完的**单个文件**仍留在缓存里，
 * 所以再点一次下载是接着下而不是从头来 —— transformers 是逐文件缓存的。
 */
export function downloadModel(
  model: ModelSpec,
  onProgress?: (p: DownloadProgress) => void,
  task?: ManagedTask,
): DownloadHandle {
  const h = once<string>(
    { type: 'download', model, host: getRemoteHost(), ...(task ? { task } : {}) },
    (m) => (m.type === 'downloaded' ? m.id : undefined),
    { timeout: STALL_TIMEOUT, ...(onProgress ? { onProgress } : {}) },
  )
  return { promise: h.promise, cancel: h.cancel }
}

export async function removeModel(id: string, task?: ManagedTask): Promise<void> {
  const { promise } = once<true>(
    { type: 'remove', id, host: getRemoteHost(), ...(task ? { task } : {}) },
    (m) => (m.type === 'removed' ? true : undefined),
    { timeout: REMOVE_TIMEOUT },
  )
  await promise
}

/**
 * 申请持久化存储。
 *
 * 不申请的话，浏览器在磁盘吃紧时会把 Cache Storage 整个清掉 —— 用户辛苦下了
 * 100MB 模型，某天回来发现「未下载」，而且没有任何提示。
 * 返回 false 只代表没拿到许可（多数浏览器要看站点参与度），不影响功能。
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return false
  }
}
