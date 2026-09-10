import { ref } from 'vue'

export type ToastKind = 'info' | 'success' | 'error' | 'warning'
export interface Toast {
  id: number
  kind: ToastKind
  text: string
}

const items = ref<Toast[]>([])
let seq = 0

function push(kind: ToastKind, text: string, ms = 4000) {
  const id = ++seq
  items.value.push({ id, kind, text })
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
    dismiss: (id: number) => {
      items.value = items.value.filter((t) => t.id !== id)
    },
  }
}
