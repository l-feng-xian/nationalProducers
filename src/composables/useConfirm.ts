/**
 * 应用内二次确认 —— 与 useToast 同一套「模块级单例 + 全局宿主」的思路。
 *
 * 为什么不用原生 confirm()：它会把整个 JS 世界挂起（rAF、流式输出全部暂停），
 * 样式也和应用完全脱节。这里换成 CbxConfirmHost 渲染的应用内弹窗，
 * 调用方拿到 Promise，await 之后才继续 —— 用法与原生一致，替换零负担。
 *
 * 删除类操作一律走它：danger 默认 true（确认钮红色）。
 */
import { ref } from 'vue'

export interface ConfirmOptions {
  /** 标题，默认「确认删除」 */
  title?: string
  /** 正文说明，应写清后果（删什么、连带删什么、能否撤销） */
  text: string
  /** 确认按钮文案，默认「删除」 */
  confirmText?: string
  /** 取消按钮文案，默认「取消」 */
  cancelText?: string
  /** 危险操作：确认钮红色。默认 true */
  danger?: boolean
}

interface ConfirmState {
  title: string
  text: string
  confirmText: string
  cancelText: string
  danger: boolean
  resolve: (ok: boolean) => void
}

const state = ref<ConfirmState | null>(null)

/**
 * 弹出确认框。点「确认」resolve(true)，其余一切途径（取消、点遮罩、Esc）
 * 都 resolve(false)。已有弹窗未关时再开新的，旧的按取消结算。
 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  state.value?.resolve(false)
  return new Promise((resolve) => {
    state.value = {
      title: opts.title ?? '确认删除',
      text: opts.text,
      confirmText: opts.confirmText ?? '删除',
      cancelText: opts.cancelText ?? '取消',
      danger: opts.danger ?? true,
      resolve,
    }
  })
}

export function useConfirm() {
  return {
    state,
    /** 宿主专用：结算并关掉当前弹窗 */
    settle(ok: boolean) {
      state.value?.resolve(ok)
      state.value = null
    },
  }
}
