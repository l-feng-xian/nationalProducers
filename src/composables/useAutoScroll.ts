import { onMounted, onUnmounted, ref, type Ref } from 'vue'

/**
 * 消息列表贴底。
 *
 * 关键：只有**真实用户手势**（wheel / touchmove）才解除吸附。
 * 程序滚动会触发 scroll 事件，若不加抑制窗口，流式期间自己滚自己会立刻取消吸附。
 */
export function useAutoScroll(el: Ref<HTMLElement | null>) {
  const stuck = ref(true)
  let suppressUntil = 0

  function isNearBottom(node: HTMLElement, slack = 80): boolean {
    return node.scrollHeight - node.scrollTop - node.clientHeight <= slack
  }

  function scrollToBottom(smooth = false) {
    const node = el.value
    if (!node) return
    suppressUntil = Date.now() + 150
    node.scrollTo({ top: node.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    stuck.value = true
  }

  function onUserGesture() {
    const node = el.value
    if (!node) return
    stuck.value = isNearBottom(node)
  }

  function onScroll() {
    if (Date.now() < suppressUntil) return
    const node = el.value
    if (!node) return
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
  })
  onUnmounted(() => {
    const node = el.value
    if (!node) return
    node.removeEventListener('scroll', onScroll)
    node.removeEventListener('wheel', onUserGesture)
    node.removeEventListener('touchmove', onUserGesture)
  })

  return { stuck, scrollToBottom, follow }
}
