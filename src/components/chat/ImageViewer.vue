<script setup lang="ts">
/**
 * 对话配图的全屏查看页：多图上下滑动切换 + 双指 / 双击 / 滚轮缩放 + 放大后拖动。
 *
 * 形态上是「新页面」而不是弹窗：纯黑满屏、顶栏带返回、**手机返回键 / 手势返回即关闭**
 * （useBackClose 压一条同址历史）。刻意不做成真路由 —— 离开 /chat/:id 会卸载 ChatView，
 * 回来要重开会话、滚动位置归零，看完图回不到原处。
 *
 * 切图用三格轨道（上一张 / 当前 / 下一张），按**图片下标**做 key：切换落定时
 * 「下一张」那个 DOM 节点原地变成「当前」，位移恰好抵消，不闪、也不重新解码。
 * 只有当前格吃缩放；已放大时单指是平移，缩回 1× 才能滑动切图 —— 与系统相册一致。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from '@/components/icons/AppIcon.vue'
import { useObjectUrl } from '@/composables/useObjectUrl'
import { useBackClose } from '@/composables/useBackClose'
import { useToast } from '@/composables/useToast'
import { blobsRepo } from '@/db/repositories'
import { downloadBlob, safeFileName } from '@/utils/download'

export interface ViewerItem {
  blobId: string
  caption?: string
}

const props = defineProps<{ items: ViewerItem[]; start: number }>()
const emit = defineEmits<{ close: [] }>()
const toast = useToast()

const index = ref(Math.min(Math.max(0, props.start), Math.max(0, props.items.length - 1)))
const total = computed(() => props.items.length)
const current = computed(() => props.items[index.value])

// 三格各自持有 objectURL；缓存是集中引用计数的，切换时同一张图直接命中、不重读 IDB
const { url: prevUrl } = useObjectUrl(computed(() => props.items[index.value - 1]?.blobId))
const { url: curUrl } = useObjectUrl(computed(() => props.items[index.value]?.blobId))
const { url: nextUrl } = useObjectUrl(computed(() => props.items[index.value + 1]?.blobId))
const slides = computed(() =>
  [
    { offset: -1, url: prevUrl.value },
    { offset: 0, url: curUrl.value },
    { offset: 1, url: nextUrl.value },
  ].filter((s) => !!props.items[index.value + s.offset]),
)

const root = ref<HTMLElement | null>(null)
/** 顶栏 / 底栏显隐：单击切换，看图时可以一点就收起所有控件 */
const chrome = ref(true)

function close() {
  emit('close')
}
useBackClose(close)

// ── 滑动切图 ──
const dragY = ref(0)
/** 落定动画进行中：开 transition，且不接受新的切换 */
const settling = ref(false)
const SETTLE_MS = 260
let settleTimer: ReturnType<typeof setTimeout> | undefined

function reducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function slideStyle(offset: number) {
  return { transform: `translate3d(0, calc(${offset * 100}% + ${dragY.value}px), 0)` }
}

function animateTo(y: number, done?: () => void) {
  clearTimeout(settleTimer)
  const ms = reducedMotion() ? 0 : SETTLE_MS
  settling.value = ms > 0
  dragY.value = y
  settleTimer = setTimeout(() => {
    settling.value = false
    done?.()
  }, ms)
}

function go(dir: -1 | 1) {
  const next = index.value + dir
  if (next < 0 || next >= total.value || settling.value) {
    animateTo(0)
    return
  }
  const h = root.value?.clientHeight ?? window.innerHeight
  animateTo(-dir * h, () => {
    // 同一帧里换下标 + 归零位移：key 按下标，目标格原地接任当前格，视觉上零位移
    index.value = next
    dragY.value = 0
    reset()
  })
}

// ── 缩放 / 平移（只作用于当前格） ──
const MIN_SCALE = 1
const MAX_SCALE = 6
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const zoomed = computed(() => scale.value > 1.01)
const imgStyle = computed(() => ({
  transform: `translate3d(${tx.value}px, ${ty.value}px, 0) scale(${scale.value})`,
}))

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v))
}

function reset() {
  scale.value = 1
  tx.value = 0
  ty.value = 0
}

/** 图片按 contain 居中，放大后每侧可平移的余量 = (显示尺寸 - 视口尺寸) / 2 */
function clampPan() {
  const el = root.value
  const im = el?.querySelector<HTMLImageElement>('.viewer__img--current')
  if (!el || !im) return
  const maxX = Math.max(0, (im.offsetWidth * scale.value - el.clientWidth) / 2)
  const maxY = Math.max(0, (im.offsetHeight * scale.value - el.clientHeight) / 2)
  tx.value = clamp(tx.value, -maxX, maxX)
  ty.value = clamp(ty.value, -maxY, maxY)
}

/** 以视口点 (px,py) 为锚点缩放：手指 / 光标下的那一点保持不动 */
function zoomAt(px: number, py: number, next: number) {
  const el = root.value
  if (!el) return
  const ns = clamp(next, MIN_SCALE, MAX_SCALE)
  const s = scale.value
  if (ns === s) return
  const r = el.getBoundingClientRect()
  const vx = (px - (r.left + r.width / 2) - tx.value) / s
  const vy = (py - (r.top + r.height / 2) - ty.value) / s
  tx.value += (s - ns) * vx
  ty.value += (s - ns) * vy
  scale.value = ns
  if (ns === MIN_SCALE) reset()
  else clampPan()
}

function zoomBy(factor: number) {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  zoomAt(r.left + r.width / 2, r.top + r.height / 2, scale.value * factor)
}

function onWheel(e: WheelEvent) {
  zoomAt(e.clientX, e.clientY, scale.value * Math.exp(-e.deltaY * 0.0015))
}

// ── 指针手势：统一处理鼠标与触摸 ──
const pointers = new Map<number, { x: number; y: number }>()
let pinchDist = 0
let pinchBase = 1
let startX = 0
let startY = 0
let startAt = 0
/** 本次按下以来移动过（超出点按容差），就不算点按 */
let moved = false
/** 本次手势是否在拖动轨道（1× 时的纵向滑动） */
let swiping = false
/** 本次手势里捏合过：松开一指后剩下那指只平移，不能误触发切图 */
let pinched = false
/** 用最近一段位移估算松手速度，快速一甩也能切图 */
let lastY = 0
let lastT = 0
let velocity = 0
let lastTap = { at: 0, x: 0, y: 0 }
let tapTimer: ReturnType<typeof setTimeout> | undefined
const TAP_SLOP = 8
const DOUBLE_TAP_MS = 280

function onPointerDown(e: PointerEvent) {
  if ((e.target as Element).closest('button')) return
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
  try {
    // 手指滑出视口也继续收到 move / up；指针已失效时会抛 NotFoundError，忽略即可
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  } catch {
    /* ignore */
  }
  if (pointers.size === 1) {
    startX = e.clientX
    startY = lastY = e.clientY
    startAt = lastT = e.timeStamp
    moved = false
    swiping = false
    pinched = false
    velocity = 0
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinchDist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
    pinchBase = scale.value
    moved = true
    pinched = true
    // 第二根手指落下：放弃正在进行的滑动切图，回到原位
    if (swiping) {
      swiping = false
      animateTo(0)
    }
  }
}

function onPointerMove(e: PointerEvent) {
  const prev = pointers.get(e.pointerId)
  if (!prev) return
  const cur = { x: e.clientX, y: e.clientY }
  pointers.set(e.pointerId, cur)
  if (!moved && Math.hypot(cur.x - startX, cur.y - startY) > TAP_SLOP) moved = true

  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()]
    if (pinchDist > 0) {
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      zoomAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, pinchBase * (d / pinchDist))
    }
    return
  }

  const dx = cur.x - prev.x
  const dy = cur.y - prev.y
  if (zoomed.value) {
    tx.value += dx
    ty.value += dy
    clampPan()
    return
  }
  if (settling.value || !moved || pinched) return
  // 只认纵向为主的拖动；横向手势留给系统（安卓侧边返回）
  if (!swiping) {
    if (Math.abs(cur.y - startY) < Math.abs(cur.x - startX)) return
    swiping = true
  }
  // 首尾继续拖：阻尼，给出「到头了」的手感
  const atEdge =
    (index.value === 0 && dragY.value + dy > 0) ||
    (index.value === total.value - 1 && dragY.value + dy < 0)
  dragY.value += atEdge ? dy * 0.35 : dy
  const dt = e.timeStamp - lastT
  if (dt > 0) velocity = (e.clientY - lastY) / dt
  lastY = e.clientY
  lastT = e.timeStamp
}

function onPointerUp(e: PointerEvent) {
  if (!pointers.delete(e.pointerId)) return
  if (pointers.size >= 1) {
    // 捏合松开一指：剩下那指以当前位置为新起点继续平移
    pinchDist = 0
    return
  }
  pinchDist = 0
  if (swiping) {
    swiping = false
    const h = root.value?.clientHeight ?? window.innerHeight
    // 拖过 18% 屏高，或者快速一甩（>0.45px/ms）就切
    if (dragY.value < -h * 0.18 || velocity < -0.45) go(1)
    else if (dragY.value > h * 0.18 || velocity > 0.45) go(-1)
    else animateTo(0)
    return
  }
  if (e.type === 'pointercancel' || moved || e.timeStamp - startAt > 400) return
  onTap(e.clientX, e.clientY, e.timeStamp)
}

/** 单击切换控件显隐（延迟到双击窗口之后），双击在点击处放大 / 还原 */
function onTap(x: number, y: number, at: number) {
  if (at - lastTap.at < DOUBLE_TAP_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) {
    clearTimeout(tapTimer)
    lastTap = { at: 0, x: 0, y: 0 }
    if (zoomed.value) reset()
    else zoomAt(x, y, 2.5)
    return
  }
  lastTap = { at, x, y }
  clearTimeout(tapTimer)
  tapTimer = setTimeout(() => (chrome.value = !chrome.value), DOUBLE_TAP_MS)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') close()
  else if (e.key === 'ArrowDown' || e.key === 'PageDown') go(1)
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') go(-1)
  else if (e.key === '+' || e.key === '=') zoomBy(1.5)
  else if (e.key === '-') zoomBy(1 / 1.5)
  else if (e.key === '0') reset()
  else return
  e.preventDefault()
}

async function save() {
  const item = current.value
  if (!item) return
  const blob = await blobsRepo.get(item.blobId)
  if (!blob) {
    toast.error('配图已丢失')
    return
  }
  const ext = blob.type.split('/')[1] || 'png'
  const at = await downloadBlob(blob, safeFileName('对话配图', ext, '对话配图'))
  if (at) toast.success(`已保存到 ${at}`)
}

let restoreFocus: HTMLElement | null = null
onMounted(() => {
  restoreFocus = document.activeElement as HTMLElement | null
  void nextTick(() => root.value?.focus())
})
onBeforeUnmount(() => {
  clearTimeout(settleTimer)
  clearTimeout(tapTimer)
  restoreFocus?.focus?.({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="root"
      class="viewer"
      :class="{ 'viewer--settling': settling, 'viewer--bare': !chrome }"
      role="dialog"
      aria-modal="true"
      aria-label="图片查看"
      tabindex="-1"
      @keydown="onKeydown"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <div
        v-for="s in slides"
        :key="index + s.offset"
        class="viewer__slide"
        :style="slideStyle(s.offset)"
      >
        <!-- 同一个 img 节点从「下一张」接任「当前」，只换 class / style，不重建不重解码 -->
        <img
          v-if="s.url"
          class="viewer__img"
          :class="{
            'viewer__img--current': s.offset === 0,
            'viewer__img--zoomed': s.offset === 0 && zoomed,
          }"
          :style="s.offset === 0 ? imgStyle : undefined"
          :src="s.url"
          :alt="s.offset === 0 ? '对话配图' : ''"
          draggable="false"
        />
        <p v-else class="viewer__loading">正在读取图片…</p>
      </div>

      <header class="viewer__top">
        <button type="button" class="viewer__btn" aria-label="返回" title="返回" @click="close">
          <AppIcon name="ArrowLeft" />
        </button>
        <span v-if="total > 1" class="viewer__count" aria-live="polite"
          >{{ index + 1 }} / {{ total }}</span
        >
        <button
          type="button"
          class="viewer__btn"
          aria-label="保存图片"
          title="保存图片"
          @click="save"
        >
          <AppIcon name="Download" />
        </button>
      </header>

      <div v-if="total > 1" class="viewer__nav">
        <button
          type="button"
          class="viewer__btn"
          aria-label="上一张"
          title="上一张（↑）"
          :disabled="index === 0"
          @click="go(-1)"
        >
          <AppIcon name="ArrowUp" />
        </button>
        <button
          type="button"
          class="viewer__btn"
          aria-label="下一张"
          title="下一张（↓）"
          :disabled="index === total - 1"
          @click="go(1)"
        >
          <AppIcon name="ArrowDown" />
        </button>
      </div>

      <footer class="viewer__foot">
        <p v-if="current?.caption" class="viewer__cap">{{ current.caption }}</p>
        <div class="viewer__zoom">
          <button
            type="button"
            class="viewer__btn"
            aria-label="缩小"
            :disabled="!zoomed"
            @click="zoomBy(1 / 1.5)"
          >
            <AppIcon name="Minus" />
          </button>
          <button type="button" class="viewer__pct" aria-label="还原" @click="reset">
            {{ Math.round(scale * 100) }}%
          </button>
          <button
            type="button"
            class="viewer__btn"
            aria-label="放大"
            :disabled="scale >= MAX_SCALE"
            @click="zoomBy(1.5)"
          >
            <AppIcon name="Plus" />
          </button>
        </div>
        <p v-if="total > 1" class="viewer__hint">上下滑动切换 · 双指或双击缩放</p>
        <p v-else class="viewer__hint">双指或双击缩放</p>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 150;
  overflow: hidden;
  background: #000;
  color: #fff;
  /* 捏合 / 拖动全部自己接管，交给浏览器会变成整页缩放或滚动 */
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  overscroll-behavior: contain;
  outline: none;
  animation: viewer-in 180ms var(--cbx-ease, ease-out);
}
@keyframes viewer-in {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
}
.viewer__slide {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  will-change: transform;
}
.viewer--settling .viewer__slide {
  transition: transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.viewer__img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  -webkit-user-drag: none;
}
.viewer__img--zoomed {
  cursor: grab;
}
.viewer__loading {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: rgba(255, 255, 255, 0.7);
}

/* 控件浮在图上，不从布局里切走高度；单击整体淡出 */
.viewer__top,
.viewer__foot,
.viewer__nav {
  transition: opacity 180ms ease;
}
.viewer--bare .viewer__top,
.viewer--bare .viewer__foot,
.viewer--bare .viewer__nav {
  opacity: 0;
  pointer-events: none;
}
.viewer__top {
  position: absolute;
  inset: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cbx-space-3);
  padding: max(var(--cbx-space-2), env(safe-area-inset-top, 0px)) var(--cbx-space-2)
    var(--cbx-space-6);
  background: linear-gradient(to bottom, rgba(0, 0, 0, 0.6), transparent);
}
.viewer__count {
  font-size: var(--cbx-fs-md);
  font-variant-numeric: tabular-nums;
}
.viewer__foot {
  position: absolute;
  inset: auto 0 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-8) var(--cbx-space-4)
    max(var(--cbx-space-3), env(safe-area-inset-bottom, 0px));
  background: linear-gradient(to top, rgba(0, 0, 0, 0.6), transparent);
  pointer-events: none;
}
.viewer__foot > * {
  pointer-events: auto;
}
.viewer__cap,
.viewer__hint {
  margin: 0;
  font-size: var(--cbx-fs-xs);
  text-align: center;
  overflow-wrap: anywhere;
}
.viewer__cap {
  color: rgba(255, 255, 255, 0.9);
}
.viewer__hint {
  color: rgba(255, 255, 255, 0.6);
}
.viewer__zoom {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-1);
  padding: var(--cbx-space-1);
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.5);
}
.viewer__nav {
  position: absolute;
  right: var(--cbx-space-3);
  top: 50%;
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  transform: translateY(-50%);
}
.viewer__nav .viewer__btn {
  background: rgba(0, 0, 0, 0.5);
}
.viewer__btn,
.viewer__pct {
  min-width: 44px;
  height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: var(--cbx-radius-pill);
  background: none;
  color: #fff;
  font-family: inherit;
  font-size: var(--cbx-fs-xs);
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.viewer__btn:disabled {
  opacity: 0.35;
  cursor: default;
}
@media (hover: hover) {
  .viewer__btn:not(:disabled):hover,
  .viewer__pct:hover {
    background: rgba(255, 255, 255, 0.16);
  }
}
.viewer__btn:focus-visible,
.viewer__pct:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

/* 触屏：缩放靠双指 / 双击，切图靠滑动，按钮只留返回与保存，不遮图 */
@media (hover: none) {
  .viewer__zoom,
  .viewer__nav {
    display: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .viewer {
    animation: none;
  }
}
</style>
