import { ref } from 'vue'

export type ToastKind = 'info' | 'success' | 'error' | 'warning'
/** 可点击的提示：点整条提示即执行（例如「定位到配图」），执行后提示消失 */
export interface ToastAction {
  label: string
  run: () => void
}
export interface Toast {
  id: number
  kind: ToastKind
  text: string
  action?: ToastAction
}

const items = ref<Toast[]>([])
let seq = 0

function push(kind: ToastKind, text: string, ms = 4000, action?: ToastAction) {
  const id = ++seq
  items.value.push({ id, kind, text, ...(action ? { action } : {}) })
  setTimeout(() => {
    items.value = items.value.filter((t) => t.id !== id)
  }, ms)
}

export function useToast() {
  return {
    items,
    info: (t: string) => push('info', t),
    success: (t: string) => push('success', t),
    error: (t: string) => push('error', t, 6000),
    warning: (t: string) => push('warning', t),
    /** 带操作的提示停留更久（默认 8 秒）：用户多半正在做别的事，得给够时间去点 */
    action: (kind: ToastKind, text: string, action: ToastAction, ms = 8000) =>
      push(kind, text, ms, action),
    dismiss: (id: number) => {
      items.value = items.value.filter((t) => t.id !== id)
    },
  }
}
