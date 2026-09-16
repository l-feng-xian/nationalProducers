/**
 * 渲染器引导：WebGPU 优先，WebGL 2 回退。
 *
 * ## ⚠️ 只判断 `navigator.gpu` 存在是不够的
 * 安全上下文、adapter/device 获取、初始化本身都可能失败。
 * 唯一可靠的判据是 `await renderer.init()` 有没有抛。
 *
 * ## ⚠️ 后端探测用 `in` 而不是类型断言
 * `@types/three@0.185.4` 比实装的 0.186.0 落后一个小版本，
 * `Backend` 类型上没有 `isWebGPUBackend` 这个字段（运行时有）。
 * 为了过类型而 `as any` 断言一个可能不存在的属性，会在将来类型补齐时
 * 掩盖真正的不兼容。用 `in` 做运行时探测，类型和运行时都诚实。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'

export interface RendererBootstrap {
  renderer: THREE.WebGPURenderer
  backend: 'webgpu' | 'webgl'
  /** 设备丢失回调。WebGPU 下 GPU 崩溃/驱动更新会触发 */
  onLost(cb: (reason: string) => void): void
  dispose(): void
}

export interface RendererOptions {
  canvas: HTMLCanvasElement
  /** 强制 WebGL（`?renderer=webgl` 走这条） */
  forceWebGL?: boolean
  /** 设备像素比上限。移动端性能护栏 */
  maxPixelRatio?: number
}

export async function createRenderer(o: RendererOptions): Promise<RendererBootstrap> {
  const attempts: boolean[] = o.forceWebGL ? [true] : [false, true]
  let lastError: unknown = null

  for (const forceWebGL of attempts) {
    const renderer = new THREE.WebGPURenderer({
      canvas: o.canvas,
      antialias: true,
      forceWebGL,
    })
    try {
      await renderer.init()
    } catch (e) {
      lastError = e
      // ⚠️ 失败的 renderer 必须 dispose，否则会漏一个 canvas 上下文，
      // 第二次尝试可能因为「canvas 已被占用」再次失败
      try {
        renderer.dispose()
      } catch {
        /* dispose 本身失败就不管了 */
      }
      continue
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, o.maxPixelRatio ?? 1.5))

    const backend = detectBackend(renderer)
    const lostCallbacks: ((reason: string) => void)[] = []
    attachLostHandler(renderer, (reason) => {
      for (const cb of lostCallbacks) cb(reason)
    })

    return {
      renderer,
      backend,
      onLost: (cb) => lostCallbacks.push(cb),
      dispose: () => renderer.dispose(),
    }
  }

  throw new Error(
    `无法初始化渲染器（WebGPU 与 WebGL 2 都失败）。${
      lastError instanceof Error ? lastError.message : ''
    }`,
  )
}

function detectBackend(renderer: THREE.WebGPURenderer): 'webgpu' | 'webgl' {
  const backend: unknown = (renderer as unknown as { backend?: unknown }).backend
  if (backend && typeof backend === 'object' && 'isWebGPUBackend' in backend) {
    return (backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl'
  }
  return 'webgl'
}

/**
 * 挂设备丢失处理。
 *
 * ⚠️ 丢失之后必须**停止渲染循环** —— 继续调 render() 会刷一屏控制台错误，
 * 而且掩盖掉真正的丢失原因。调用方收到回调后应当停掉 RAF 并给用户一个
 * 「重新载入场景」的入口（grid 还在内存里，重建只是重跑渲染装配）。
 */
function attachLostHandler(renderer: THREE.WebGPURenderer, onLost: (reason: string) => void): void {
  const backend: unknown = (renderer as unknown as { backend?: unknown }).backend
  if (!backend || typeof backend !== 'object' || !('device' in backend)) return
  const device: unknown = (backend as { device?: unknown }).device
  if (!device || typeof device !== 'object' || !('lost' in device)) return
  const lost = (device as { lost?: Promise<{ reason?: string; message?: string }> }).lost
  if (!lost || typeof lost.then !== 'function') return
  void lost.then((info) => {
    onLost(info?.message || info?.reason || 'GPU 设备丢失')
  })
}
