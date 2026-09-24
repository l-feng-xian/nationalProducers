import { onUnmounted, ref } from 'vue'

/**
 * 移动端长按。触屏没有 hover，操作条要么常显要么长按呼出。
 *
 * 移动超过阈值即取消（说明用户在滚动而不是长按）；
 * pointercancel 同样要清理，否则会留下野定时器。
 */
export function useLongPress(cb: () => void, ms = 500, moveTolerance = 10) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let startX = 0
  let startY = 0
  /** 按住未满时长期间为真：给元素一点「正在被按」的收缩反馈，用户知道长按有效 */
  const pressing = ref(false)

  function clear() {
    pressing.value = false
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function onPointerDown(ev: PointerEvent) {
    // 只对触摸生效，鼠标走 hover 那套
    if (ev.pointerType === 'mouse') return
    startX = ev.clientX
    startY = ev.clientY
    clear()
    pressing.value = true
    timer = setTimeout(() => {
      timer = null
      pressing.value = false
      // 轻震一下确认「菜单出来了」；不支持的设备（iOS Safari）静默跳过
      navigator.vibrate?.(12)
      cb()
    }, ms)
  }

  function onPointerMove(ev: PointerEvent) {
    if (!timer) return
    if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > moveTolerance) clear()
  }

  onUnmounted(clear)

  return {
    pressing,
    handlers: {
      onPointerdown: onPointerDown,
      onPointermove: onPointerMove,
      onPointerup: clear,
      onPointercancel: clear,
      onPointerleave: clear,
    },
  }
}
