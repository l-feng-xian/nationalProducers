/**
 * 数据管理图片表的「点缩略图 → 放大预览」开关，含共享元素过渡。
 *
 * 状态为什么不放在 BlobLightbox 里：`startViewTransition(cb)` 要把**造成 DOM 变化的那次
 * 状态变更**整个包进回调，而这个变更发生在表格（父组件）里，弹层自己没法事后补上。
 *
 * ⚠️ `view-transition-name` 同一时刻必须全文档唯一。缩略图和大图要当成同一个元素做形变，
 * 就得在回调内部完成**名字交接**：旧态挂在缩略图上，DOM 更新后立刻改挂到大图上再拍新态。
 * 这里沿用 MORPH_NAME 那套约定（见 constants/app.ts）：固定名 + 只给「当前参与过渡的
 * 那一个元素」条件绑定，绑 undefined 时 Vue 直接移除行内样式，天然不撞名、也不用手动清理。
 */
import { computed, nextTick, ref, type StyleValue } from 'vue'
import { useViewTransition } from './useViewTransition'

/**
 * 刻意和 MORPH_NAME('cbx-morph') 分开：那套是「同一张图两端等比」的卡片→详情过渡，
 * CSS 里给 old/new 配的是 120ms 交叉淡化。这里两端比例根本不同
 * （缩略图是 56px 见方的 cover 裁切，大图是 contain 的原图），
 * 需要另一套「裁切框连续放大」的快照规则，共用一个名字就会互相打架。
 */
export const BLOB_MORPH_NAME = 'cbx-blob-morph'

/** 名字当前归谁。null = 没有过渡在进行，两边都不带名字 */
type MorphOwner = { id: string; owner: 'thumb' | 'stage' } | null

export function useBlobPreview() {
  const id = ref<string | null>(null)
  const caption = ref('')
  const morph = ref<MorphOwner>(null)
  const vt = useViewTransition()

  /** 绑到缩略图按钮上：只有轮到它持名时才落这行内联样式，其余时候是 undefined */
  function thumbStyle(thumbId: string): StyleValue | undefined {
    const m = morph.value
    return m && m.owner === 'thumb' && m.id === thumbId
      ? { viewTransitionName: BLOB_MORPH_NAME }
      : undefined
  }
  /** 绑到弹层大图上 */
  const stageStyle = computed<StyleValue | undefined>(() =>
    morph.value?.owner === 'stage' ? { viewTransitionName: BLOB_MORPH_NAME } : undefined,
  )

  /** 先把名字落到「旧态那一端」，拍快照前必须已经在 DOM 上 */
  async function arm(target: MorphOwner) {
    if (!vt.supported) return
    morph.value = target
    await nextTick()
  }

  async function open(nextId: string, nextCaption = '') {
    await arm({ id: nextId, owner: 'thumb' })
    await vt.run(() => {
      id.value = nextId
      caption.value = nextCaption
      // 交接：同一次 DOM 更新里缩略图卸名、大图挂名，新态才拍得到形变落点
      if (morph.value) morph.value = { id: nextId, owner: 'stage' }
    })
    // run() 等的是 finished，此刻动画已收尾，名字可以收了。
    // 连点两张图时后一次会接管 morph，这里只收自己那份，别把人家的清掉。
    if (morph.value?.id === nextId) morph.value = null
  }

  async function close() {
    const current = id.value
    if (!current) return
    await arm({ id: current, owner: 'stage' })
    await vt.run(() => {
      id.value = null
      caption.value = ''
      if (morph.value) morph.value = { id: current, owner: 'thumb' }
    })
    if (morph.value?.id === current) morph.value = null
  }

  return { id, caption, thumbStyle, stageStyle, open, close }
}
