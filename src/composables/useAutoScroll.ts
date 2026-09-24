import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/** 键盘上这些键会滚动容器，按下即视为用户接管 */
const SCROLL_KEYS = new Set([
  'PageUp',
  'PageDown',
  'Home',
  'End',
  'ArrowUp',
  'ArrowDown',
  ' ',
  'Spacebar',
])
/** 往上翻的键：按下立刻解除吸附，不等 scroll 事件 */
const UP_KEYS = new Set(['PageUp', 'Home', 'ArrowUp'])

/** 超过这么多屏的距离就直接跳，不做平滑滚动 */
const SMOOTH_MAX_SCREENS = 4
/** 跳到底之后最多再盯几帧，用来吃掉虚拟列表的估算误差 */
const SETTLE_TRIES = 8
/**
 * 用户自己滚动时，离底多近才算「回到底部、重新吸附」。
 * 必须很小：原来统一用 80px，结果用户在流式输出时往上划 30px 仍被判为贴底，
 * 下一次刷新（100ms）就被拽回去 —— 手机上表现为「一直定位到最底部、划不动」。
 */
const USER_STICK_SLACK = 8
/** 非用户造成的滚动（布局夹取、虚拟列表修正、Ctrl+F 跳转）沿用宽松阈值 */
const LAYOUT_STICK_SLACK = 80
/** 滚动停下来多久算手势（含惯性）结束 */
const GESTURE_IDLE_MS = 160

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 消息列表贴底。只有**用户自己的滚动**才解除吸附，程序滚动（流式跟随、点「回到底部」）不算。
 *
 * 区分自己滚的与用户滚的：
 *  - 瞬时滚动同步生效，记下落点，随后那个位置一致的 scroll 事件就是我们自己造成的；
 *  - 平滑滚动中途位置一直在变，记下目标，到达之前的 scroll 事件都不作数。
 *
 * 用户手势期间（手指按着 / 滚轮 / 滚动键 / 拖滚动条，以及松手后的惯性）：
 *  - **完全不自动跟随**：原来只是取消平滑滚动，流式刷新照样每 100ms 把列表 scrollTo 到底，
 *    和手指抢位置 —— 这是「AI 回复时划不动」的直接原因；
 *  - 往上的动作（手指下拉、滚轮上滚、上翻键）立刻解除吸附，不等位移超过阈值；
 *  - 只有真正划回底部（≤8px）才重新吸附，手势结束后若仍吸附再补一次跟随。
 */
export function useAutoScroll(el: Ref<HTMLElement | null>) {
  const stuck = ref(true)

  /** 瞬时滚动的落点。位置**恰好相等**的那一次 scroll 是我们自己滚的 */
  let selfTop: number | null = null
  /** 平滑滚动的目标；非 null 表示动画进行中 */
  let smoothTarget: number | null = null
  let smoothFallback: ReturnType<typeof setTimeout> | undefined
  /** 每次新的贴底都作废上一条 settle 链，流式 10Hz 下不至于叠一堆并发链 */
  let settleToken = 0

  /** 手指 / 鼠标正按着（触摸滚动、拖滚动条） */
  let holding = false
  /** 用户手势进行中（含松手后的惯性滚动），期间不自动跟随 */
  let userScrolling = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let lastTouchY = 0
  let ro: ResizeObserver | undefined

  function gapOf(node: HTMLElement): number {
    return node.scrollHeight - node.scrollTop - node.clientHeight
  }

  function cancelSmooth() {
    smoothTarget = null
    settleToken++
    if (smoothFallback !== undefined) {
      clearTimeout(smoothFallback)
      smoothFallback = undefined
    }
  }

  function scrollToBottom(smooth = false) {
    const node = el.value
    if (!node) return
    // 显式调用（发送、点「回到底部」）即使在手势中也要生效，并结束手势态
    endGesture(false)
    // scrollTo 会把越界值夹到 scrollHeight - clientHeight，记夹过的值才对得上落点
    const target = Math.max(0, node.scrollHeight - node.clientHeight)
    cancelSmooth()
    stuck.value = true
    // 远距离不做平滑：实测从 300 条会话的顶部滚到底（约 45000px）Chrome 要跑 1.6s，
    // 既不像「跳转」，也会超出下面那个兜底计时器 —— 兜底一旦提前触发，动画中途的
    // scroll 事件就会被当成用户滚动而解除吸附，按钮在半途闪回来。
    const far = Math.abs(target - node.scrollTop) > node.clientHeight * SMOOTH_MAX_SCREENS
    if (smooth && !far && !prefersReducedMotion()) {
      smoothTarget = target
      // 动画被打断且没等到落点事件时的兜底，避免 smoothTarget 永远挂着把 onScroll 憋死
      smoothFallback = setTimeout(cancelSmooth, 1000)
      selfTop = null
      node.scrollTo({ top: target, behavior: 'smooth' })
      return
    }
    node.scrollTo({ top: target, behavior: 'auto' })
    // 瞬时滚动是同步生效的，这里读到的就是真实落点
    selfTop = node.scrollTop
    settle(SETTLE_TRIES, -1, ++settleToken)
  }

  /**
   * 跳完之后继续盯几帧，直到总高不再变。
   *
   * 虚拟列表里 scrollHeight 对**未测量**的行只是估算，而新行是被 ResizeObserver
   * 量过之后才把总高修正的 —— 那一刻往往已经在我们滚完之后。实测两种表现：
   * 删掉中间一条后跳到底差 139px；流式追加后差 16px，都是「再补一次就正好」。
   * 所以不能只补固定帧数，要一直盯到高度稳定（或用尽预算）。
   * 只在仍然吸附、且用户没在操作时补，用户一碰立刻停手。
   */
  function settle(tries: number, lastHeight: number, token: number) {
    if (tries <= 0 || token !== settleToken) return
    requestAnimationFrame(() => {
      const node = el.value
      if (!node || !stuck.value || userScrolling || smoothTarget !== null || token !== settleToken)
        return
      const height = node.scrollHeight
      const gap = height - node.scrollTop - node.clientHeight
      if (gap > 1) {
        node.scrollTo({ top: Math.max(0, height - node.clientHeight), behavior: 'auto' })
        selfTop = node.scrollTop
      }
      // 高度还在变说明内容没落定，继续盯
      if (gap > 1 || height !== lastHeight) settle(tries - 1, height, token)
    })
  }

  // ── 用户手势 ──

  function beginGesture() {
    userScrolling = true
    cancelSmooth()
    clearTimeout(idleTimer)
  }

  /** 手指已抬起时，等滚动（惯性）停下来再结束手势 */
  function scheduleIdle() {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => endGesture(true), GESTURE_IDLE_MS)
  }

  function endGesture(catchUp: boolean) {
    clearTimeout(idleTimer)
    idleTimer = undefined
    if (!userScrolling) return
    userScrolling = false
    holding = false
    // 手势期间内容可能长了一截：仍吸附的话现在补上
    if (catchUp && stuck.value) scrollToBottom()
  }

  function unstickIfScrollable() {
    const node = el.value
    if (node && node.scrollHeight > node.clientHeight) stuck.value = false
  }

  function onTouchStart(e: TouchEvent) {
    holding = true
    lastTouchY = e.touches[0]?.clientY ?? 0
    beginGesture()
  }
  function onTouchMove(e: TouchEvent) {
    const y = e.touches[0]?.clientY ?? lastTouchY
    // 手指往下拖 = 内容往上翻 = 看旧消息：立刻松开吸附，不给流式刷新再拽回去的机会
    if (y - lastTouchY > 2) unstickIfScrollable()
    lastTouchY = y
    beginGesture()
  }
  function onTouchEnd(e: TouchEvent) {
    if (e.touches.length) return
    holding = false
    scheduleIdle()
  }

  function onWheel(e: WheelEvent) {
    if (e.deltaY < 0) unstickIfScrollable()
    beginGesture()
    scheduleIdle()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!SCROLL_KEYS.has(e.key)) return
    // 输入框里的方向键 / 空格是打字，不是滚动
    const t = e.target as HTMLElement | null
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
    if (UP_KEYS.has(e.key)) unstickIfScrollable()
    beginGesture()
    scheduleIdle()
  }

  /** 鼠标按在容器自身上（不是某条消息里）= 在拖滚动条 */
  function onPointerDown(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || e.target !== el.value) return
    holding = true
    beginGesture()
    window.addEventListener('pointerup', onPointerUp, { once: true })
  }
  function onPointerUp() {
    holding = false
    scheduleIdle()
  }

  function onScroll() {
    const node = el.value
    if (!node) return
    if (smoothTarget !== null) {
      // 允许 1px 取整误差；到达即交还控制权，中途位置一律不作数
      if (Math.abs(node.scrollTop - smoothTarget) <= 1) cancelSmooth()
      return
    }
    // 落点一致 = 这一次是我们自己滚的。放过一次即失效；
    // 若压根没产生滚动（已经在底部），留着的旧值也无害：位置对不上就会走到下面
    if (selfTop !== null && node.scrollTop === selfTop) {
      selfTop = null
      return
    }
    selfTop = null
    if (userScrolling) {
      stuck.value = gapOf(node) <= USER_STICK_SLACK
      // 手指已抬起、还在惯性滚：每个 scroll 事件都把「停下」往后推
      if (!holding) scheduleIdle()
      return
    }
    stuck.value = gapOf(node) <= LAYOUT_STICK_SLACK
  }

  /** 内容增长时调用：只有仍吸附、且用户没在划的时候才跟随 */
  function follow() {
    if (stuck.value && !userScrolling) scrollToBottom()
  }

  onMounted(() => {
    const node = el.value
    if (!node) return
    node.addEventListener('scroll', onScroll, { passive: true })
    node.addEventListener('wheel', onWheel, { passive: true })
    node.addEventListener('touchstart', onTouchStart, { passive: true })
    node.addEventListener('touchmove', onTouchMove, { passive: true })
    node.addEventListener('touchend', onTouchEnd, { passive: true })
    node.addEventListener('touchcancel', onTouchEnd, { passive: true })
    node.addEventListener('pointerdown', onPointerDown, { passive: true })
    node.addEventListener('keydown', onKeyDown, { passive: true })
    // 可视高度变化（弹出 / 收起软键盘、旋转、点名条出现）时，贴底的要继续贴底：
    // 容器变矮时 scrollTop 不变、也不会触发 scroll 事件，最新消息就被压到键盘后面去了
    ro = new ResizeObserver(() => follow())
    ro.observe(node)
  })
  onUnmounted(() => {
    cancelSmooth()
    clearTimeout(idleTimer)
    ro?.disconnect()
    window.removeEventListener('pointerup', onPointerUp)
    const node = el.value
    if (!node) return
    node.removeEventListener('scroll', onScroll)
    node.removeEventListener('wheel', onWheel)
    node.removeEventListener('touchstart', onTouchStart)
    node.removeEventListener('touchmove', onTouchMove)
    node.removeEventListener('touchend', onTouchEnd)
    node.removeEventListener('touchcancel', onTouchEnd)
    node.removeEventListener('pointerdown', onPointerDown)
    node.removeEventListener('keydown', onKeyDown)
  })

  return { stuck, scrollToBottom, follow }
}
