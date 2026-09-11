/**
 * 立绘 → 深度图。
 *
 * 只在**上传图片时**跑一次，结果存进 blobs 永久缓存。实测单张约 3 秒
 * （长边 512，见 presets.ts 里那个拐点的说明），所以不存在「用的时候现算」。
 *
 * 纯 service：不 import vue/pinia。
 */

import { DEPTH_MAX_EDGE } from './presets'
import type { DepthInMsg, DepthOutMsg } from './worker'

/** 无进展就判死。3 秒的活给到 90 秒，弱机器也够 */
const STALL_MS = 90_000

export interface DepthResult {
  /** 单通道灰度 PNG */
  blob: Blob
  width: number
  height: number
  ms: number
}

/**
 * 把图片缩到长边 `DEPTH_MAX_EDGE`。
 *
 * 这一步必须在主线程做：Worker 里没有 `createImageBitmap` 之外的解码手段，
 * 而且原图可能极大 —— 实测用户的一张立绘是 4501×8000（3600 万像素），
 * 不缩放直接喂模型要 21 秒，其中绝大部分耗在把深度插值回原尺寸。
 */
async function downscale(src: Blob): Promise<ImageBitmap> {
  const bmp = await createImageBitmap(src)
  const long = Math.max(bmp.width, bmp.height)
  if (long <= DEPTH_MAX_EDGE) return bmp

  const s = DEPTH_MAX_EDGE / long
  const w = Math.max(1, Math.round(bmp.width * s))
  const h = Math.max(1, Math.round(bmp.height * s))
  // resizeQuality:'high' 让降采样走更好的滤波，避免锯齿污染深度边缘
  const small = await createImageBitmap(bmp, {
    resizeWidth: w,
    resizeHeight: h,
    resizeQuality: 'high',
  })
  bmp.close()
  return small
}

/** 单通道灰度 → PNG Blob。存 PNG 而不是裸字节：浏览器能直接当纹理解码 */
async function grayToPng(data: Uint8Array, width: number, height: number): Promise<Blob> {
  const cv = new OffscreenCanvas(width, height)
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('OffscreenCanvas 2D 上下文不可用')
  const id = ctx.createImageData(width, height)
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0
    const o = i * 4
    id.data[o] = v
    id.data[o + 1] = v
    id.data[o + 2] = v
    id.data[o + 3] = 255
  }
  ctx.putImageData(id, 0, 0)
  return cv.convertToBlob({ type: 'image/png' })
}

/**
 * 生成深度图。**任何失败都抛**，由调用方决定怎么降级 ——
 * 见 stores 里的用法：生成失败只让视差不可用，绝不能挡住用户换头像。
 */
export function generateDepth(
  source: Blob,
  modelId: string,
  onProgress?: (loaded: number, total: number) => void,
): { promise: Promise<DepthResult>; cancel: () => void } {
  const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  let settled = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const done = () => {
    settled = true
    if (timer) clearTimeout(timer)
    w.terminate()
  }

  const promise = new Promise<DepthResult>((resolve, reject) => {
    const t0 = performance.now()
    // 用「多久没动静」判死而不是总时长：下载模型那一段可能很久，但只要有进度就不算卡死
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        done()
        reject(new Error('深度图生成超时，长时间没有进展'))
      }, STALL_MS)
    }
    arm()

    w.onerror = (e) => {
      if (settled) return
      done()
      reject(new Error(`深度 Worker 出错：${e.message || '未知'}`))
    }
    w.onmessage = async (ev: MessageEvent<DepthOutMsg>) => {
      if (settled) return
      const m = ev.data
      if (m.type === 'progress') {
        arm()
        onProgress?.(m.loaded, m.total)
        return
      }
      if (m.type === 'error') {
        done()
        reject(new Error(m.message))
        return
      }
      try {
        const blob = await grayToPng(m.data, m.width, m.height)
        done()
        resolve({ blob, width: m.width, height: m.height, ms: Math.round(performance.now() - t0) })
      } catch (e) {
        done()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    }

    void (async () => {
      try {
        const bmp = await downscale(source)
        const msg: DepthInMsg = { type: 'estimate', modelId, bitmap: bmp }
        // ImageBitmap 必须转移，结构化克隆一张大图会很慢
        w.postMessage(msg, [bmp])
      } catch (e) {
        if (settled) return
        done()
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })

  return { promise, cancel: () => !settled && done() }
}
