/**
 * 世界生成 Worker。
 *
 * 只做三件事：跑 pipeline、回报进度、把结果 transfer 回主线程。
 *
 * ⚠️ 取消不是抢占式的。`AbortController` 不会中断正在执行的同步计算，
 * 所以这里用一个可变标志 + pipeline 内部的检查点。粒度是「一步」，
 * 最长的一步约 200ms。
 *
 * ⚠️ 过期请求靠 jobId 丢弃：用户拖动种子滑杆会连发好几个请求，
 * 晚到的结果必须能识别出「这不是当前要的那个」。
 */

import { buildWorld, isCancelled } from './pipeline'
import { transferablesOf } from './grid'
import type { BuildWorldInput } from './pipeline'

export interface WorkerRequest {
  generatorVersion?: string
  jobId: number
  seed: string
  settings: BuildWorldInput['settings']
}

export type WorkerResponse =
  | { type: 'progress'; jobId: number; step: string; ratio: number }
  | { type: 'done'; jobId: number; grid: unknown }
  | { type: 'error'; jobId: number; message: string }
  | { type: 'cancelled'; jobId: number }

/** 当前正在跑的 jobId。收到新请求时把它换掉，旧的那次会在下一个检查点自行退出 */
let currentJob = -1
const signal = { aborted: false }

self.onmessage = (ev: MessageEvent<WorkerRequest | { type: 'cancel' }>) => {
  const data = ev.data

  if ('type' in data && data.type === 'cancel') {
    signal.aborted = true
    return
  }

  const req = data as WorkerRequest
  // 新请求进来 → 让上一轮在下一个检查点退出
  signal.aborted = false
  currentJob = req.jobId

  try {
    const grid = buildWorld({
      seed: req.seed,
      generatorVersion: req.generatorVersion,
      settings: req.settings,
      signal,
      onProgress: (step, ratio) => {
        // 已经不是当前任务就别再发进度了
        if (currentJob !== req.jobId) return
        const msg: WorkerResponse = { type: 'progress', jobId: req.jobId, step, ratio }
        self.postMessage(msg)
      },
    })

    const msg: WorkerResponse = { type: 'done', jobId: req.jobId, grid }
    // ⚠️ transfer 之后本侧这些数组会变成长度 0 的壳，绝不能再碰 grid
    self.postMessage(msg, transferablesOf(grid))
  } catch (e) {
    if (isCancelled(e)) {
      const msg: WorkerResponse = { type: 'cancelled', jobId: req.jobId }
      self.postMessage(msg)
      return
    }
    const msg: WorkerResponse = {
      type: 'error',
      jobId: req.jobId,
      message: e instanceof Error ? e.message : String(e),
    }
    self.postMessage(msg)
  }
}
