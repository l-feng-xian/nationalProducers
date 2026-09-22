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

/** 超过这么多屏的距离就直接跳，不做平滑滚动 */
const SMOOTH_MAX_SCREENS = 4
/** 跳到底之后最多再盯几帧，用来吃掉虚拟列表的估算误差 */
const SETTLE_TRIES = 8

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 消息列表贴底。只有**用户自己的滚动**才解除吸附，程序滚动（流式跟随、点「回到底部」）不算。
 *
 * ⚠️ 原先靠「程序滚动后 150ms 内忽略 scroll 事件」来区分两者，而流式刷新默认
 * **100ms** 一次（`settings.chat.streamFlushMs`）——抑制窗口比刷新间隔还长，
 * 于是流式期间它**永不关闭**，`onScroll` 形同死代码：键盘翻页、拖滚动条、
 * 触控板拖滚动条都挣不脱自动跟随，只有 wheel / touchmove 能解除。
 *
 * 现在改成按**落点**判定，不再和时间赛跑：
 *  - 瞬时滚动同步生效，记下落点，随后那个位置一致的 scroll 事件就是我们自己造成的；
 *  - 平滑滚动中途位置一直在变，记下目标，到达之前的 scroll 事件都不作数；
 *  - 任何真实手势（wheel / touchmove / 滚动键）立刻交还控制权。
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

  function isNearBottom(node: HTMLElement, slack = 80): boolean {
    return node.scrollHeight - node.scrollTop - node.clientHeight <= slack
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
   * 只在仍然吸附时补，用户一滚走立刻停手。
   */
  function settle(tries: number, lastHeight: number, token: number) {
    if (tries <= 0 || token !== settleToken) return
    requestAnimationFrame(() => {
      const node = el.value
      if (!node || !stuck.value || smoothTarget !== null || token !== settleToken) return
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

  /** 真实手势：用户接管，进行中的平滑滚动不再算我们自己的 */
  function onUserGesture() {
    cancelSmooth()
  }

  function onKeyDown(e: KeyboardEvent) {
    if (SCROLL_KEYS.has(e.key)) cancelSmooth()
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
    stuck.value = isNearBottom(node)
  }

  /** 内容增长时调用：只有仍吸附才跟随 */
  function follow() {
    if (stuck.value) scrollToBottom()
  }

  onMounted(() => {
    const node = el.value
    if (!node) return
    node.addEventListener('scroll', onScroll, { passive: true })
    node.addEventListener('wheel', onUserGesture, { passive: true })
    node.addEventListener('touchmove', onUserGesture, { passive: true })
    node.addEventListener('keydown', onKeyDown, { passive: true })
  })
  onUnmounted(() => {
    cancelSmooth()
    const node = el.value
    if (!node) return
    node.removeEventListener('scroll', onScroll)
    node.removeEventListener('wheel', onUserGesture)
    node.removeEventListener('touchmove', onUserGesture)
    node.removeEventListener('keydown', onKeyDown)
  })

  return { stuck, scrollToBottom, follow }
}
