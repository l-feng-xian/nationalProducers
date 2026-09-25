import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useUiStore } from '@/stores/ui'

/** 抽屉模式的断点，与 AppSidebar / App.vue 的 @media (max-width: 767px) 保持一致 */
export const DRAWER_MQ = '(max-width: 767px)'

/** 响应式的 matchMedia */
export function useMediaQuery(query: string) {
  const mq = window.matchMedia(query)
  const matches = ref(mq.matches)
  const onChange = (e: MediaQueryListEvent) => (matches.value = e.matches)
  onMounted(() => mq.addEventListener('change', onChange))
  onBeforeUnmount(() => mq.removeEventListener('change', onChange))
  return matches
}

/** 从屏幕左缘多宽的范围内起手算「拉出抽屉」 */
const EDGE = 28
/** 判定方向前的死区 */
const SLOP = 8
/** 松手速度超过它（px/ms）按甩动方向开 / 关，不看位置 */
const FLING = 0.3

/**
 * 移动端抽屉的跟手拖拽：左缘右滑拉出、抽屉打开时左滑推回，松手按位置 / 速度落定。
 *
 * - 只接 `.shell` 内部起手的触摸：Teleport 到 body 的浮层（图片查看、底部菜单、弹窗）
 *   有自己的手势，不能被这里抢走；
 * - 先过死区再定方向，纵向为主就整段放弃，交还给列表滚动；
 * - 监听全部 passive，不拦浏览器默认行为 —— 纵向滚动照常，横向本就无处可滚。
 *
 * ⚠️ 安卓全面屏手势把屏幕左右缘让给了系统返回，最边上那一条 WebView 收不到触摸；
 * EDGE 取 28px 是为了在系统手势区之外还留一截能起手的地方。点菜单按钮始终可用。
 */
export function useDrawerSwipe(shell: () => HTMLElement | null, drawer: () => HTMLElement | null) {
  const ui = useUiStore()
  const mq = window.matchMedia(DRAWER_MQ)

  let track: {
    x0: number
    y0: number
    fromOpen: boolean
    width: number
    locked: boolean
    lastX: number
    lastT: number
    v: number
    /** 起手时手指下的元素：抬手 / 取消事件只会派发到它身上（见 onStart 里的说明） */
    target: EventTarget | null
  } | null = null

  function progressAt(x: number): number {
    if (!track) return 0
    const dx = x - track.x0
    const p = track.fromOpen ? 1 + dx / track.width : dx / track.width
    return Math.min(1, Math.max(0, p))
  }

  function onStart(e: TouchEvent) {
    // 上一段手势的收尾若丢了，这里兜底清掉，别让残留的拖动值继续开着遮罩
    abort()
    if (!mq.matches || e.touches.length !== 1) return
    const t = e.touches[0]!
    const root = shell()
    if (!root || !root.contains(e.target as Node)) return
    if (!ui.drawerOpen && t.clientX > EDGE) return
    const width = drawer()?.offsetWidth || Math.min(window.innerWidth * 0.84, 320)
    track = {
      x0: t.clientX,
      y0: t.clientY,
      fromOpen: ui.drawerOpen,
      width,
      locked: false,
      lastX: t.clientX,
      lastT: e.timeStamp,
      v: 0,
      target: e.target,
    }
    // ⚠️ touchend / touchcancel 永远派发给**起手时的那个元素**，哪怕它已被移出文档；
    // 移出后事件到不了 document，document 上的监听就收不到。典型场景是安卓左缘
    // 「系统返回」手势：滑到一半页面被切走，手指下的元素随旧页面一起卸载 → 收尾丢失 →
    // drawerDrag 残留 → 半透明遮罩（.scrim--on）盖满全屏，整页点不动（实测复现）。
    // 所以同时在起手元素上直接挂一次性的收尾监听。
    e.target?.addEventListener('touchend', onEnd as EventListener, { passive: true, once: true })
    e.target?.addEventListener('touchcancel', onCancel as EventListener, {
      passive: true,
      once: true,
    })
  }

  function onMove(e: TouchEvent) {
    if (!track) return
    const t = e.touches[0]
    if (!t) return
    const dx = t.clientX - track.x0
    const dy = t.clientY - track.y0
    if (!track.locked) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
      // 纵向为主：用户在滚列表，整段放弃
      if (Math.abs(dx) < Math.abs(dy) * 1.2) {
        track = null
        return
      }
      // 方向不对（关着往左、开着往右）也放弃
      if ((!track.fromOpen && dx < 0) || (track.fromOpen && dx > 0)) {
        track = null
        return
      }
      track.locked = true
    }
    const dt = e.timeStamp - track.lastT
    if (dt > 0) track.v = (t.clientX - track.lastX) / dt
    track.lastX = t.clientX
    track.lastT = e.timeStamp
    ui.drawerDrag = progressAt(t.clientX)
  }

  /** 解除起手元素上的收尾监听（document 那路先到时，别让它再触发第二次） */
  function detachTarget(cur: NonNullable<typeof track>) {
    cur.target?.removeEventListener('touchend', onEnd as EventListener)
    cur.target?.removeEventListener('touchcancel', onCancel as EventListener)
  }

  /**
   * 放弃当前手势：拖动值清掉，抽屉回到起手前的状态。
   * 用于手势被系统接管（touchcancel）、切页、切到后台 —— 这些都不是用户「松手」，
   * 不能按位置 / 速度去决定开合。
   */
  function abort() {
    const cur = track
    track = null
    if (cur) detachTarget(cur)
    if (ui.drawerDrag === null) return
    if (cur?.fromOpen) ui.openDrawer()
    else ui.closeDrawer()
    ui.drawerDrag = null
  }

  function onCancel() {
    abort()
  }

  function onEnd() {
    const cur = track
    track = null
    if (cur) detachTarget(cur)
    if (!cur?.locked) return
    const p = ui.drawerDrag ?? (cur.fromOpen ? 1 : 0)
    const open = cur.v > FLING ? true : cur.v < -FLING ? false : p > 0.5
    // 先定终态再清拖动值：同一轮更新里行内 transform 撤掉、类名 transform 生效，CSS 过渡从当前位置接着走
    if (open) ui.openDrawer()
    else ui.closeDrawer()
    ui.drawerDrag = null
  }

  onMounted(() => {
    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: true })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onCancel, { passive: true })
    document.addEventListener('visibilitychange', onVisibility)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('touchstart', onStart)
    document.removeEventListener('touchmove', onMove)
    document.removeEventListener('touchend', onEnd)
    document.removeEventListener('touchcancel', onCancel)
    document.removeEventListener('visibilitychange', onVisibility)
    abort()
  })

  function onVisibility() {
    if (document.visibilityState !== 'visible') abort()
  }

  /** 切页时由外部调用：手势进行中页面换了，这段手势作废 */
  return { abort }
}
