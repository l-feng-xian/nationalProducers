import { onBeforeUnmount, ref } from 'vue'
import { mount, move, unmount } from '@/services/depth/parallax'
import { requestTiltPermission, startTilt, tiltSupported } from '@/services/depth/tilt'
import { blobsRepo } from '@/db/repositories'
import { useSettingsStore } from '@/stores/settings'
import { viewTransitionActive } from './useViewTransition'

/**
 * 深度立绘视差的两种驱动方式，由设备决定、会话内不变：
 * - `pointer`：能 hover 的精确指针（桌面鼠标 / 触控板）—— 鼠标在画框上的位置；
 * - `tilt`：触屏设备 —— 手机倾斜（陀螺仪 / 方向传感器，见 services/depth/tilt.ts）。
 * 用户要求减少动效时两种都不做：视差是典型的前庭刺激来源，该彻底关掉而不是调小幅度。
 */
export type ParallaxMode = 'pointer' | 'tilt' | null

function detectMode(): ParallaxMode {
  if (typeof window === 'undefined') return null
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return 'pointer'
  return tiltSupported() ? 'tilt' : null
}
export const parallaxMode: ParallaxMode = detectMode()

/**
 * 传感器要不要用户先点一下授权。第一次挂画框时静默探测（见 requestTiltPermission）：
 * 安卓 / Chrome 直接通过，恒为 false；只有 iOS 会变 true，界面据此显示「开启重力视差」。
 * 全局共享，一处授权处处生效。
 */
const needsPermission = ref(false)

/**
 * 一个页面里「挂着视差的那些画框」。
 *
 * 渲染器是全局单例（一个 WebGL 上下文，见 parallax.ts），但可以同时驱动多个画框：
 * - 桌面：鼠标悬停的那一张（enter 挂、leave 摘）；
 * - 手机：编辑页的大立绘 / 列表里所有进入可视区的卡，全部跟着手机倾斜同步动。
 * 本实例挂的画框离开页面时自动摘掉；传感器在挂着 ≥1 个画框时才监听。
 */
export function useDepthParallax() {
  const settings = useSettingsStore()
  /** 本实例挂上（或正在挂）的画框 */
  const hosts = new Set<HTMLElement>()
  let stopTilt: (() => void) | null = null

  /** 这张图能不能做视差：有深度模型配置、有立绘、有深度图 */
  function eligible(avatarBlobId?: string, depthBlobId?: string): boolean {
    return !!parallaxMode && !!settings.settings.depth.modelId && !!avatarBlobId && !!depthBlobId
  }

  async function ensureTilt() {
    if (parallaxMode !== 'tilt' || stopTilt || !hosts.size) return
    const ok = await requestTiltPermission()
    needsPermission.value = !ok
    if (ok && hosts.size && !stopTilt) stopTilt = startTilt(move)
  }
  function stopTiltIfIdle() {
    if (hosts.size) return
    stopTilt?.()
    stopTilt = null
  }

  /** 挂到画框上。失败静默返回 false（视差是纯装饰），画框里仍是静态 <img> */
  /** aspect = 画框宽高比：角色卡 2:3（默认），演绎封面横版 3:2 */
  async function activate(
    el: HTMLElement,
    avatarBlobId?: string,
    depthBlobId?: string,
    aspect = 2 / 3,
  ) {
    if (!eligible(avatarBlobId, depthBlobId)) return false
    if (hosts.has(el)) return true
    hosts.add(el)
    // 角色卡 ⇄ 编辑页的共享元素形变期间别往画框里塞 canvas：新状态的快照是「活」的，
    // 塞进去会在形变中途换掉画面。等它播完（最多 1s）再挂
    for (let i = 0; i < 20 && viewTransitionActive(); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    if (!hosts.has(el)) return false
    const [color, depth] = await Promise.all([
      blobsRepo.get(avatarBlobId!),
      blobsRepo.get(depthBlobId!),
    ])
    if (!color || !depth || !hosts.has(el)) {
      hosts.delete(el)
      return false
    }
    const ok = await mount({
      el,
      key: `${avatarBlobId}|${depthBlobId}`,
      color,
      depth,
      aspect,
    })
    if (!hosts.has(el)) {
      // 等待期间已被 deactivate：mount 若成功要撤掉
      if (ok) unmount(el)
      return false
    }
    if (!ok) {
      hosts.delete(el)
      return false
    }
    await ensureTilt()
    return true
  }

  /** 摘掉一个画框（滚出可视区 / 鼠标离开） */
  function deactivate(el: HTMLElement) {
    if (!hosts.delete(el)) return
    unmount(el)
    stopTiltIfIdle()
  }

  /** 桌面：鼠标在画框里移动。坐标按事件所在画框归一化 */
  function pointer(e: PointerEvent) {
    if (parallaxMode !== 'pointer' || !hosts.size) return
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // 归一化到 -1..1，原点在画框中心
    move(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1)
  }

  /** 摘掉本实例挂的全部画框 */
  function release() {
    for (const el of [...hosts]) {
      hosts.delete(el)
      unmount(el)
    }
    stopTiltIfIdle()
  }

  /** iOS：在点击回调里调用。授权后给已挂的画框补上传感器监听 */
  async function enableTilt() {
    if (!(await requestTiltPermission())) return false
    needsPermission.value = false
    await ensureTilt()
    return true
  }

  onBeforeUnmount(release)

  return { activate, deactivate, pointer, release, eligible, enableTilt, needsPermission }
}
