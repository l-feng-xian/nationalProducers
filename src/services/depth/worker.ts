/**
 * 深度估计 Worker。
 *
 * 和嵌入 Worker 分开的理由和当初分开推理/下载是同一条：两者各自持有一个装了
 * 几十 MB 权重的 pipeline，塞进一个 worker 就意味着用视差必然连带把嵌入模型
 * 也钉在内存里。分开之后 `terminate()` 能精确地把某一边的内存还给系统。
 *
 * 单张推理实测约 3 秒（长边 512），所以它天生是「用完即弃」的一次性任务，
 * 不像嵌入那样需要常驻。
 */

/// <reference lib="webworker" />
import { setupTf } from '../ml/tfEnv'
import { DEPTH_DTYPE, DEPTH_TASK } from './presets'

// 没有这行，TS 会把 self 推断成 Window，postMessage 的 transfer 参数重载对不上
declare const self: DedicatedWorkerGlobalScope

export interface EstimateMsg {
  type: 'estimate'
  modelId: string
  /** 已经缩放好的图片。缩放放在主线程做 —— Worker 里没有 DOM canvas */
  bitmap: ImageBitmap
  /** transformers.js 下载源（remoteHost）。缓存键含 host，必须与下载时一致，见 downloadHost.ts */
  host?: string
}
export type DepthInMsg = EstimateMsg

export type DepthOutMsg =
  | { type: 'progress'; loaded: number; total: number; file: string }
  /** 单通道灰度，长宽与输入一致 */
  | { type: 'estimated'; data: Uint8Array; width: number; height: number }
  | { type: 'error'; message: string }

type DepthPipe = (img: unknown) => Promise<{
  depth: { data: Uint8Array; width: number; height: number; channels: number }
}>

let pipe: DepthPipe | null = null
let loadedModelId = ''

async function estimate(msg: EstimateMsg): Promise<void> {
  const tf = await setupTf('cache', msg.host)

  if (!pipe || loadedModelId !== msg.modelId) {
    // 前置检查是「没下载就绝不联网」的唯一执行点 —— allowRemoteModels 恒为 true
    // （见 tfEnv 的说明，它不能为 false），少了这一步就会静默拉几十 MB。
    const ready = await tf.ModelRegistry.is_pipeline_cached(DEPTH_TASK, msg.modelId, {
      dtype: DEPTH_DTYPE,
    })
    if (!ready) throw new Error('深度模型尚未下载完成，请到「模型管理」里下载后再启用')

    const p = await tf.pipeline(DEPTH_TASK, msg.modelId, {
      dtype: DEPTH_DTYPE,
      device: 'wasm',
      progress_callback: (raw: unknown) => {
        const o = raw as { status?: string; loaded?: number; total?: number; file?: string }
        if (o.status === 'progress' && o.total) {
          post({ type: 'progress', loaded: o.loaded ?? 0, total: o.total, file: o.file ?? '' })
        }
      },
    })
    pipe = p as unknown as DepthPipe
    loadedModelId = msg.modelId
  }

  // ⚠️ 宽高必须在 bitmapToRgba 之前取：它内部会 close()，
  // 而**已关闭的 ImageBitmap 宽高都是 0** —— 拿 0 去构造 ImageData 会抛
  // 「The source width is zero or not a number」，看不出跟 close 有任何关系。
  const w = msg.bitmap.width
  const h = msg.bitmap.height
  const rgba = await bitmapToRgba(msg.bitmap)
  const img = new tf.RawImage(new Uint8ClampedArray(rgba), w, h, 4)
  const out = await pipe(img)
  const d = out.depth
  if (d.channels !== 1) throw new Error(`深度图通道数异常：${d.channels}`)

  // 转移而非拷贝：512 长边下约 150KB，量不大但没理由白拷
  const buf = new Uint8Array(d.data)
  post({ type: 'estimated', data: buf, width: d.width, height: d.height }, [buf.buffer])
}

/** Worker 里没有 2D canvas API 之外的解码手段，用 OffscreenCanvas 取像素 */
async function bitmapToRgba(bmp: ImageBitmap): Promise<ArrayBufferLike> {
  const cv = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D 上下文不可用')
  ctx.drawImage(bmp, 0, 0)
  const id = ctx.getImageData(0, 0, bmp.width, bmp.height)
  bmp.close()
  return id.data.buffer
}

function post(m: DepthOutMsg, transfer?: Transferable[]): void {
  if (transfer) self.postMessage(m, transfer)
  else self.postMessage(m)
}

self.onmessage = async (ev: MessageEvent<DepthInMsg>) => {
  try {
    if (ev.data.type === 'estimate') await estimate(ev.data)
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) })
  }
}
