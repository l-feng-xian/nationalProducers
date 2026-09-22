<script setup lang="ts">
/**
 * 图片放大预览：滚轮 / 双指缩放、拖拽平移、工具条按钮，配 View Transitions 形变出入场。
 *
 * 用原生 `<dialog showModal>` 而不是自造遮罩：白拿焦点陷阱、Esc 关闭与 ::backdrop。
 * 图片本体仍走 useObjectUrl 的集中缓存 —— 和缩略图是同一个 blobId，命中缓存后
 * 不会为「放大」再建一次 objectURL。
 *
 * 开合动画由 useBlobPreview 驱动（它要把状态变更包进 startViewTransition），
 * 这里只负责：把 dialog 在**同一轮 flush 内**打开，好让过渡拍得到新态。
 */
import { computed, onBeforeUnmount, ref, watch, type StyleValue } from 'vue'
import AppIcon from '@/components/icons/AppIcon.vue'
import { useObjectUrl } from '@/composables/useObjectUrl'

/** morphStyle 由 useBlobPreview 交接过来：轮到大图持名时才是有值的 */
const props = defineProps<{
  blobId: string | null
  caption?: string
  morphStyle?: StyleValue
}>()
const emit = defineEmits<{ close: [] }>()

const idRef = computed(() => props.blobId ?? undefined)
const { url } = useObjectUrl(idRef)
const dlg = ref<HTMLDialogElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const imgEl = ref<HTMLImageElement | null>(null)

// ── 缩放 / 平移 ──
const MIN_SCALE = 1
const MAX_SCALE = 8
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const pct = computed(() => Math.round(scale.value * 100))
const imgStyle = computed(() => ({
  transform: `translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
}))

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

/**
 * 把平移限制在「图片不会被拖离舞台」的范围内。
 * 图片按 contain 居中布局，所以放大后每侧能移动的余量是 (显示尺寸-舞台尺寸)/2。
 */
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
  // 图片在舞台里居中，未变换时的中心就是舞台中心；transform-origin 默认也是中心
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
  } else {
    clampPan()
  }
}

/** 工具条按钮：以舞台中心为锚点按档位缩放 */
function zoomBy(factor: number) {
  const el = stage.value
  if (!el) return
  const r = el.getBoundingClientRect()
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, scale.value * factor)
}

function onWheel(e: WheelEvent) {
  // 指数曲线：触控板的小增量和鼠标滚轮的大增量都线性可控
  zoomAt(e.clientX, e.clientY, scale.value * Math.exp(-e.deltaY * 0.0015))
}

function onDblClick(e: MouseEvent) {
  if (scale.value > MIN_SCALE) reset()
  else zoomAt(e.clientX, e.clientY, 2)
}

// 指针：一指拖动（已放大时），两指捏合。用 PointerEvent 统一鼠标与触摸
const pointers = new Map<number, { x: number; y: number }>()
let pinchDist = 0
let pinchBase = 1
/** 拖动过就吞掉这次 click，否则松手落在背景上会误触「点背景关闭」 */
let dragged = false

function onPointerDown(e: PointerEvent) {
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
    pinchBase = scale.value
  }
  if (pointers.size === 1 && scale.value > MIN_SCALE) {
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
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
  if (scale.value <= MIN_SCALE) return
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
}

function close() {
  emit('close')
}

/** 只有点在背景（dialog 自身或舞台空白处）才关闭；点图片、工具条不关 */
function onBackdrop(e: MouseEvent) {
  if (dragged) {
    dragged = false
    return
  }
  const t = e.target as Node
  if (t === dlg.value || t === stage.value) close()
}

/**
 * flush:'post' 是刻意的：过渡回调里只等一个 nextTick 就要拍新态，
 * dialog 必须在**那一轮 flush 内**就 showModal 进 top layer。
 * 用默认的 'pre' + 再 await 一次 nextTick 的话，新态拍到的还是 display:none 的 dialog，
 * 形变就没有落点、只剩旧图淡出。
 */
watch(
  () => props.blobId,
  (id) => {
    if (!id) {
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
      v-if="blobId"
      ref="dlg"
      class="lightbox"
      aria-label="图片预览"
      @cancel.prevent="close"
      @click="onBackdrop"
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
          v-if="url"
          ref="imgEl"
          class="lightbox__img"
          :class="{ 'lightbox__img--zoomed': scale > 1 }"
          :style="[imgStyle, morphStyle]"
          :src="url"
          alt="图片预览"
          draggable="false"
        />
        <p v-else class="lightbox__loading">正在读取图片…</p>
      </div>

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
        <p v-if="caption" class="lightbox__cap">{{ caption }}</p>
      </div>

      <button type="button" class="lightbox__x" aria-label="关闭预览" @click="close">
        <AppIcon name="X" />
      </button>
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
/**
 * 舞台铺满整个弹层，工具条与说明**浮在上层**，不从布局里切走一块。
 *
 * 原先是 flex 纵向布局：舞台只占「视口高度减去底栏」，放大之后图片会在底栏上沿
 * 被硬切出一条横边，下面露出压暗的页面 —— 看上去就是图被截断了。
 * 现在 inset:0 铺满，唯一的边界是视口本身。
 */
.lightbox__stage {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  /* 自己接管捏合与拖动，交给浏览器会变成页面缩放 */
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
.lightbox__foot {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3);
  /* 浮层本身不吃指针事件：底部这条带子上照样能拖图、点空白关闭，只有控件可点 */
  pointer-events: none;
  /* 浅色图片压到底部时，工具条与说明文字仍要读得清 */
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
  /* 触控区不小于 44px，见 design-system 的移动端约定 */
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
}
.lightbox__x {
  position: fixed;
  top: var(--cbx-space-3);
  right: var(--cbx-space-3);
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
@media (hover: hover) {
  .lightbox__x:hover {
    background: rgba(0, 0, 0, 0.75);
  }
}
.lightbox__btn:focus-visible,
.lightbox__pct:focus-visible,
.lightbox__x:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
</style>

