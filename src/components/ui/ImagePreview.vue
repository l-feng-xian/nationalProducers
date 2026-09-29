<script setup lang="ts">
/**
 * 全站统一的图片预览宿主（App.vue 挂一个，状态见 useImagePreview）。
 *
 * 外观与交互沿用原「数据管理 / 图片」的放大预览：原生 `<dialog showModal>`（白拿焦点陷阱、
 * Esc、::backdrop）、滚轮 / 双击 / 双指缩放、拖拽平移、从缩略图形变出入场。
 * 在此基础上加了多图：左右按钮、←/→ 键、未放大时横向滑动切换，顶部计数与下载。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/icons/AppIcon.vue'
import { useObjectUrl } from '@/composables/useObjectUrl'
import { useBackClose } from '@/composables/useBackClose'
import { useImagePreview, PREVIEW_MORPH_NAME } from '@/composables/useImagePreview'
import { useToast } from '@/composables/useToast'
import { blobsRepo } from '@/db/repositories'
import { downloadBlob, safeFileName } from '@/utils/download'

const preview = useImagePreview()
const state = preview.state
const toast = useToast()

const current = computed(() => state.items[state.index])
const count = computed(() => state.items.length)
const { url: blobUrl } = useObjectUrl(computed(() => current.value?.blobId))
const src = computed(() => current.value?.url ?? blobUrl.value)
// 相邻两张预取进 useObjectUrl 的缓存，切过去时首帧就有图
useObjectUrl(computed(() => state.items[state.index - 1]?.blobId))
useObjectUrl(computed(() => state.items[state.index + 1]?.blobId))

const dlg = ref<HTMLDialogElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)

// ── 缩放 / 平移 ──
const MIN_SCALE = 1
const MAX_SCALE = 8
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
/** 未放大时横向滑动的跟手位移 */
const swipeX = ref(0)
const pct = computed(() => Math.round(scale.value * 100))
const imgStyle = computed(() => ({
  transform: `translate(${tx.value + swipeX.value}px, ${ty.value}px) scale(${scale.value})`,
  ...(preview.stageMorph.value ? { viewTransitionName: PREVIEW_MORPH_NAME } : {}),
}))

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}
function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  swipeX.value = 0
}

/** 平移限制在「图片不会被拖离舞台」的范围内（contain 居中，每侧余量 = (显示-舞台)/2） */
function clampPan() {
  const el = stage.value
  const im = imgEl.value
  if (!el || !im) return
  const maxX = Math.max(0, (im.offsetWidth * scale.value - el.clientWidth) / 2)
  const maxY = Math.max(0, (im.offsetHeight * scale.value - el.clientHeight) / 2)
  tx.value = clamp(tx.value, -maxX, maxX)
  ty.value = clamp(ty.value, -maxY, maxY)
}

/** 以视口点 (px,py) 为锚点缩放到 next —— 光标 / 双指中心下的那一点保持不动 */
function zoomAt(px: number, py: number, next: number) {
  const el = stage.value
  if (!el) return
  const ns = clamp(next, MIN_SCALE, MAX_SCALE)
  const s = scale.value
  if (ns === s) return
  const r = el.getBoundingClientRect()
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const vx = (px - cx - tx.value) / s
  const vy = (py - cy - ty.value) / s
  tx.value += (s - ns) * vx
  ty.value += (s - ns) * vy
  scale.value = ns
  if (ns === MIN_SCALE) {
    tx.value = 0
    ty.value = 0
  } else clampPan()
}
function zoomBy(factor: number) {
  const el = stage.value
  if (!el) return
  const r = el.getBoundingClientRect()
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, scale.value * factor)
}
function onWheel(e: WheelEvent) {
  zoomAt(e.clientX, e.clientY, scale.value * Math.exp(-e.deltaY * 0.0015))
}
function onDblClick(e: MouseEvent) {
  if (scale.value > MIN_SCALE) reset()
  else zoomAt(e.clientX, e.clientY, 2)
}

// ── 指针：一指拖动（放大时平移 / 未放大时横滑切图），两指捏合 ──
const pointers = new Map<number, { x: number; y: number }>()
let pinchDist = 0
let pinchBase = 1
/** 拖动过就吞掉这次 click，否则松手落在背景上会误触「点背景关闭」 */
let dragged = false
/** 横滑切图的起点；贴屏幕边缘起手的不算（让位给安卓的边缘返回手势） */
let swipe: { x: number; t: number } | null = null
const EDGE = 24

function onPointerDown(e: PointerEvent) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
    pinchBase = scale.value
    swipe = null
    swipeX.value = 0
  }
  if (pointers.size === 1) {
    dragged = false
    // ⚠️ 只在放大时立刻捕获：Chrome 里 click 会派发给捕获者（舞台），
    // 未放大时一捕获，单击图片就变成「点背景关闭」。横滑确认后再捕获（见 move）
    if (scale.value > MIN_SCALE) (e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    const nearEdge = e.clientX < EDGE || e.clientX > window.innerWidth - EDGE
    swipe =
      scale.value <= MIN_SCALE && count.value > 1 && !nearEdge
        ? { x: e.clientX, t: e.timeStamp }
        : null
  }
}

function onPointerMove(e: PointerEvent) {
  const prev = pointers.get(e.pointerId)
  if (!prev) return
  const cur = { x: e.clientX, y: e.clientY }
  pointers.set(e.pointerId, cur)

  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    const d = Math.hypot(a!.x - b!.x, a!.y - b!.y)
    if (pinchDist > 0) {
      dragged = true
      zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, pinchBase * (d / pinchDist))
    }
    return
  }
  if (scale.value <= MIN_SCALE) {
    if (!swipe) return
    let dx = cur.x - swipe.x
    // 到头了还往外拉：阻尼，提示「没有更多」
    if ((dx > 0 && state.index === 0) || (dx < 0 && state.index === count.value - 1)) dx *= 0.35
    if (Math.abs(dx) > 4 && !dragged) {
      dragged = true
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    }
    swipeX.value = dx
    return
  }
  const dx = cur.x - prev.x
  const dy = cur.y - prev.y
  if (dx || dy) dragged = true
  tx.value += dx
  ty.value += dy
  clampPan()
}

function onPointerUp(e: PointerEvent) {
  pointers.delete(e.pointerId)
  if (pointers.size < 2) pinchDist = 0
  if (swipe && pointers.size === 0) {
    const dx = swipeX.value
    const v = Math.abs(dx) / Math.max(1, e.timeStamp - swipe.t)
    const width = stage.value?.clientWidth ?? window.innerWidth
    swipe = null
    if (Math.abs(dx) > width * 0.18 || (Math.abs(dx) > 30 && v > 0.45)) go(dx < 0 ? 1 : -1)
    swipeX.value = 0
  }
}

function go(delta: number) {
  preview.go(delta)
}
const hasPrev = computed(() => state.index > 0)
const hasNext = computed(() => state.index < count.value - 1)
// 切图就复位缩放
watch(
  () => state.index,
  () => reset(),
)

function close() {
  void preview.close()
}
// 手机返回键 = 关预览
useBackClose(close, () => state.open)

/** 只有点在背景（dialog 自身或舞台空白处）才关闭；点图片、工具条不关 */
function onBackdrop(e: MouseEvent) {
  if (dragged) {
    dragged = false
    return
  }
  const t = e.target as Node
  if (t === dlg.value || t === stage.value) close()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowLeft') go(-1)
  else if (e.key === 'ArrowRight') go(1)
  else if (e.key === '+' || e.key === '=') zoomBy(1.5)
  else if (e.key === '-') zoomBy(1 / 1.5)
  else if (e.key === '0') reset()
  else return
  e.preventDefault()
}

async function save() {
  const item = current.value
  if (!item) return
  let blob: Blob | undefined
  try {
    blob = item.blobId
      ? await blobsRepo.get(item.blobId)
      : item.url
        ? await (await fetch(item.url)).blob()
        : undefined
  } catch {
    blob = undefined
  }
  if (!blob) {
    toast.error('图片已丢失')
    return
  }
  const ext = blob.type.split('/')[1] || 'png'
  const at = await downloadBlob(blob, safeFileName(item.caption || '图片', ext, '图片'))
  if (at) toast.success(`已保存到 ${at}`)
}

/**
 * flush:'post'：过渡回调里只等一个 nextTick 就要拍新态，
 * dialog 必须在那一轮 flush 内就 showModal 进 top layer，形变才有落点。
 */
watch(
  () => state.open,
  (open) => {
    if (!open) {
      dlg.value?.close()
      return
    }
    reset()
    if (!dlg.value?.open) dlg.value?.showModal()
  },
  { flush: 'post' },
)
onBeforeUnmount(() => dlg.value?.close())
</script>

<template>
  <Teleport to="body">
    <dialog
      v-if="state.open"
      ref="dlg"
      class="lightbox"
      aria-label="图片预览"
      @cancel.prevent="close"
      @click="onBackdrop"
      @keydown="onKey"
    >
      <div
        ref="stage"
        class="lightbox__stage"
        @wheel.prevent="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="onDblClick"
      >
        <img
          v-if="src"
          :key="state.index"
          ref="imgEl"
          class="lightbox__img"
          :class="{ 'lightbox__img--zoomed': scale > 1, 'lightbox__img--swiping': swipeX !== 0 }"
          :style="imgStyle"
          :src="src"
          :alt="current?.caption || '图片预览'"
          draggable="false"
        />
        <p v-else class="lightbox__loading">正在读取图片…</p>
      </div>

      <div class="lightbox__top">
        <span v-if="count > 1" class="lightbox__count" aria-live="polite"
          >{{ state.index + 1 }} / {{ count }}</span
        >
        <button
          type="button"
          class="lightbox__round"
          aria-label="保存图片"
          title="保存图片"
          @click="save"
        >
          <AppIcon name="Download" />
        </button>
        <button type="button" class="lightbox__round" aria-label="关闭预览" @click="close">
          <AppIcon name="X" />
        </button>
      </div>

      <template v-if="count > 1">
        <button
          type="button"
          class="lightbox__nav lightbox__nav--prev"
          aria-label="上一张"
          :disabled="!hasPrev"
          @click="go(-1)"
        >
          <AppIcon name="ChevronLeft" />
        </button>
        <button
          type="button"
          class="lightbox__nav lightbox__nav--next"
          aria-label="下一张"
          :disabled="!hasNext"
          @click="go(1)"
        >
          <AppIcon name="ChevronRight" />
        </button>
      </template>

      <div class="lightbox__foot">
        <div class="lightbox__zoom">
          <button
            type="button"
            class="lightbox__btn"
            aria-label="缩小"
            :disabled="scale <= 1"
            @click="zoomBy(1 / 1.5)"
          >
            <AppIcon name="Minus" />
          </button>
          <button type="button" class="lightbox__pct" aria-label="重置为原始大小" @click="reset">
            {{ pct }}%
          </button>
          <button
            type="button"
            class="lightbox__btn"
            aria-label="放大"
            :disabled="scale >= 8"
            @click="zoomBy(1.5)"
          >
            <AppIcon name="Plus" />
          </button>
        </div>
        <p v-if="current?.caption" class="lightbox__cap">{{ current.caption }}</p>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.lightbox {
  position: fixed;
  inset: 0;
  margin: 0;
  border: 0;
  padding: 0;
  background: transparent;
  width: 100vw;
  height: 100vh;
  max-width: 100vw;
  max-height: 100vh;
  overflow: hidden;
}
.lightbox::backdrop {
  background: rgba(0, 0, 0, 0.78);
}
/* 舞台铺满整个弹层，工具条与说明浮在上层，不从布局里切走一块（否则放大后图片被底栏硬切） */
.lightbox__stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 自己接管捏合、拖动与横滑，交给浏览器会变成页面缩放 / 滚动 */
  touch-action: none;
}
.lightbox__img {
  display: block;
  max-width: min(92vw, 1400px);
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--cbx-radius-md);
  /* 透明 PNG 在纯黑上看不出边界，垫一层底 */
  background: var(--cbx-bg-secondary);
  cursor: zoom-in;
  will-change: transform;
  transition: transform 200ms var(--cbx-ease);
}
/* 跟手期间不要过渡，否则拖动发黏 */
.lightbox__img--swiping,
.lightbox__img--zoomed {
  transition: none;
}
.lightbox__img--zoomed {
  cursor: grab;
  border-radius: 0;
}
.lightbox__img--zoomed:active {
  cursor: grabbing;
}
.lightbox__loading,
.lightbox__cap {
  margin: 0;
  font-size: var(--cbx-fs-xs);
  color: rgba(255, 255, 255, 0.85);
  text-align: center;
  overflow-wrap: anywhere;
}
.lightbox__top {
  position: fixed;
  top: max(var(--cbx-space-3), env(safe-area-inset-top, 0px));
  right: var(--cbx-space-3);
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.lightbox__count {
  padding: 0 var(--cbx-space-3);
  height: 32px;
  display: flex;
  align-items: center;
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: var(--cbx-fs-xs);
  font-variant-numeric: tabular-nums;
}
.lightbox__round,
.lightbox__nav {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: pointer;
}
.lightbox__nav {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
}
.lightbox__nav--prev {
  left: var(--cbx-space-3);
}
.lightbox__nav--next {
  right: var(--cbx-space-3);
}
.lightbox__nav:disabled {
  opacity: 0.3;
  cursor: default;
}
.lightbox__foot {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3);
  padding-bottom: max(var(--cbx-space-3), var(--cbx-safe-b));
  /* 浮层本身不吃指针事件：底部这条带子上照样能拖图、点空白关闭，只有控件可点 */
  pointer-events: none;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent);
}
.lightbox__zoom {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--cbx-space-1);
  padding: var(--cbx-space-1);
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.55);
}
.lightbox__btn,
.lightbox__pct {
  min-width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--cbx-radius-pill);
  background: none;
  color: #fff;
  font-family: inherit;
  font-size: var(--cbx-fs-xs);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.lightbox__btn:disabled {
  opacity: 0.4;
  cursor: default;
}
@media (hover: hover) {
  .lightbox__btn:not(:disabled):hover,
  .lightbox__pct:hover {
    background: rgba(255, 255, 255, 0.16);
  }
  .lightbox__round:hover,
  .lightbox__nav:not(:disabled):hover {
    background: rgba(0, 0, 0, 0.75);
  }
}
/* 触屏上靠横滑切图，左右按钮只会挡图 */
@media (hover: none) {
  .lightbox__nav {
    display: none;
  }
}
.lightbox__btn:focus-visible,
.lightbox__pct:focus-visible,
.lightbox__round:focus-visible,
.lightbox__nav:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .lightbox__img {
    transition: none;
  }
}
</style>
