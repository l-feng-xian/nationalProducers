/**
 * 全站统一的图片预览（ImagePreview.vue 的开关）。模块级单例：任何组件调用
 * `useImagePreview().open(items, index, sourceEl)` 即可，App.vue 里只挂一个宿主。
 *
 * 外观沿用原「数据管理 / 图片」的放大预览，并加了多图切换。
 *
 * ## 缩略图 → 大图的形变
 * `startViewTransition(cb)` 要把造成 DOM 变化的那次状态变更整个包进回调；
 * `view-transition-name` 同一时刻又必须全文档唯一。所以名字要在回调**内部**交接：
 * 旧态挂在源元素（缩略图）上，状态一变立刻摘掉、改挂到大图上，新态才拍得到落点。
 * 源元素由调用方传进来，这里直接改它的行内样式 —— 调用方不用为每张缩略图绑一套样式。
 */
import { nextTick, reactive, ref } from 'vue'
import { useViewTransition } from './useViewTransition'

export interface PreviewItem {
  /** 已入库的图片 */
  blobId?: string
  /** 还没入库的图片（例如刚生成的结果），直接给 URL */
  url?: string
  caption?: string
}

/** 与 base.css 里 ::view-transition-*(cbx-blob-morph) 的规则对应 */
export const PREVIEW_MORPH_NAME = 'cbx-blob-morph'

const state = reactive({
  open: false,
  items: [] as PreviewItem[],
  index: 0,
})
/** 大图此刻是否持有 morph 名 */
const stageMorph = ref(false)
/** 打开时的源元素与起始下标：切到别的图之后关闭，不再形变回缩略图（对不上） */
let source: { el: HTMLElement; index: number } | null = null

function setName(el: HTMLElement | null | undefined, on: boolean) {
  if (el) el.style.viewTransitionName = on ? PREVIEW_MORPH_NAME : ''
}

async function open(items: PreviewItem[], index = 0, sourceEl?: HTMLElement | null) {
  const list = items.filter((i) => i.blobId || i.url)
  if (!list.length) return
  const start = Math.min(Math.max(0, index), list.length - 1)
  const vt = useViewTransition()
  const el = vt.supported && sourceEl?.isConnected ? sourceEl : null
  source = sourceEl ? { el: sourceEl, index: start } : null
  setName(el, true)
  await vt.run(() => {
    state.items = list
    state.index = start
    state.open = true
    // 交接：同一次 DOM 更新里缩略图卸名、大图挂名
    if (el) {
      setName(el, false)
      stageMorph.value = true
    }
  })
  stageMorph.value = false
}

async function close() {
  if (!state.open) return
  const vt = useViewTransition()
  const el =
    vt.supported && source?.el.isConnected && source.index === state.index ? source.el : null
  if (el) {
    stageMorph.value = true
    await nextTick()
  }
  await vt.run(() => {
    state.open = false
    if (el) {
      stageMorph.value = false
      setName(el, true)
    }
  })
  setName(el, false)
  source = null
}

function go(delta: number) {
  const n = state.items.length
  if (n < 2) return
  const next = state.index + delta
  if (next < 0 || next >= n) return
  state.index = next
}

export function useImagePreview() {
  return { state, stageMorph, open, close, go }
}
