<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  bowSignOf,
  circleLayout,
  edgeGeometry,
  hitTestNode,
  NODE_R,
  type Pt,
} from '@/utils/graphGeometry'
import type { GroupNodeLayout, GroupRelation } from '@/types/group'

/**
 * 关系图谱画布（需求 3）。
 *
 * 手势要点（桌面调试完全发现不了的坑）：
 *  - 必须 `touch-action: none`，否则移动端拖节点会变成页面滚动、双指变系统缩放
 *  - `pointercancel` 必须与 `pointerup` 走同一处理：iOS 系统手势介入时只发 cancel，
 *    不处理就会永久卡在拖拽状态
 */
const props = defineProps<{
  members: { id: string; name: string }[]
  relations: GroupRelation[]
  layout: Record<string, GroupNodeLayout>
}>()

const emit = defineEmits<{
  'update:layout': [v: Record<string, GroupNodeLayout>]
  'create-relation': [from: string, to: string]
  /** 气泡里改了字段，请父级落盘 */
  change: []
  'remove-relation': [id: string]
  'swap-relation': [r: GroupRelation]
}>()

const svgEl = ref<SVGSVGElement | null>(null)

/**
 * 画布逻辑尺寸 = 元素的 CSS 像素尺寸（由 ResizeObserver 同步）。
 *
 * 这样 viewBox 单位与屏幕像素 **1:1**，既不会有 `preserveAspectRatio` 的
 * 等比留白死区，宽度也天然铺满容器。
 * 之前是写死 720×460 + `width:100%`，容器一宽就只在中间画一条，
 * 左右留出大片点不到的空白。
 */
const W = ref(720)
const H = ref(460)
let ro: ResizeObserver | null = null

const pos = ref<Record<string, Pt>>({})
const selected = ref<string | null>(null)
/** 连线模式：从某节点拖出一条虚线到另一节点 */
const linking = ref<{ from: string; to: Pt } | null>(null)

const nameOf = computed(() => new Map(props.members.map((m) => [m.id, m.name])))

function syncLayout() {
  const next: Record<string, Pt> = {}
  const missing: string[] = []
  for (const m of props.members) {
    const p = props.layout[m.id]
    if (p) next[m.id] = clampPt(p)
    else missing.push(m.id)
  }
  if (missing.length) {
    // 新成员沿圆周补位（避免全都堆在 0,0）
    const seeded = circleLayout(
      props.members.map((m) => m.id),
      W.value,
      H.value,
    )
    for (const id of missing) {
      const p = seeded[id]
      if (p) next[id] = p
    }
  }
  pos.value = next
}

onMounted(() => {
  const el = svgEl.value
  if (el) {
    ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect
      if (!box || box.width < 1 || box.height < 1) return
      W.value = Math.round(box.width)
      H.value = Math.round(box.height)
      // 画布变窄时（转屏、拖窗口）原来的坐标可能落到界外，拉回来
      const next: Record<string, Pt> = {}
      for (const [id, p] of Object.entries(pos.value)) next[id] = clampPt(p)
      pos.value = next
    })
    ro.observe(el)
    const r = el.getBoundingClientRect()
    if (r.width > 1) {
      W.value = Math.round(r.width)
      H.value = Math.round(r.height)
    }
  }
  syncLayout()
})
onUnmounted(() => {
  ro?.disconnect()
  ro = null
})
watch(() => [props.members.map((m) => m.id).join(','), props.layout], syncLayout, { deep: true })

const nodes = computed(() =>
  props.members.map((m) => ({ id: m.id, name: m.name, ...(pos.value[m.id] ?? { x: 0, y: 0 }) })),
)

/** 只画两端都还在的边 */
const edges = computed(() =>
  props.relations
    .map((r) => {
      const a = pos.value[r.from]
      const b = pos.value[r.to]
      if (!a || !b) return null
      const g = edgeGeometry(a, b, bowSignOf(r.from, r.to))
      return { r, ...g }
    })
    .filter((e): e is NonNullable<typeof e> => !!e),
)

/**
 * 拖拽钳制的边距。
 *
 * 节点的实际占位**比圆本身大**：右上角有 ＋ 连接柄
 * （圆心 `x+NODE_R-3, y-NODE_R+3`，r=9 → 右缘 x+NODE_R+6、上缘 y-NODE_R-6），
 * 圆下方还有名字标签（基线 `y+NODE_R+16`，再算字身下缘）。
 *
 * 只按 NODE_R 钳位的话圆是贴边了，但名字和 ＋ 会被 `.graph` 的 overflow:hidden
 * 裁掉 —— 表现为「把节点拖到边角，名字没了、也没法再从它拉出关系」。
 */
const PAD_L = NODE_R
const PAD_R = NODE_R + 6
const PAD_T = NODE_R + 6
const PAD_B = NODE_R + 22

/** 把坐标钳进当前画布可视范围（画布尺寸会随容器变化） */
function clampPt(p: Pt): Pt {
  return {
    x: Math.max(PAD_L, Math.min(Math.max(PAD_L, W.value - PAD_R), p.x)),
    y: Math.max(PAD_T, Math.min(Math.max(PAD_T, H.value - PAD_B), p.y)),
  }
}

// ── pointer 状态机 ──
type Mode = { kind: 'none' } | { kind: 'node'; id: string; dx: number; dy: number }
let mode: Mode = { kind: 'none' }
let rafId = 0

/**
 * 屏幕坐标 → viewBox 坐标。
 *
 * 现在 viewBox 与 CSS 像素 1:1，理论上手算也对得上，但仍然坚持用
 * `getScreenCTM()`：它是浏览器给出的真实变换矩阵，viewBox、
 * preserveAspectRatio、外层 CSS transform 全部算在内。
 *
 * ⚠️ 别改回「(clientX - rect.left) / rect.width * W」那种手算等比换算。
 * 它只在「元素宽高比恰好等于 viewBox」时才成立，一旦哪天给画布加了
 * aspect-ratio、max-width 或者外层缩放，坐标就会整体偏移并被拉伸，
 * 表现为**节点跑离光标、怎么拖都拖不住** —— 这个 bug 真出现过。
 */
function toLocal(ev: PointerEvent): Pt {
  const el = svgEl.value
  if (!el) return { x: 0, y: 0 }
  const ctm = el.getScreenCTM()
  if (!ctm) return { x: 0, y: 0 }
  const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(ctm.inverse())
  return { x: p.x, y: p.y }
}

function onPointerDown(ev: PointerEvent) {
  const p = toLocal(ev)
  const hit = hitTestNode(p, nodes.value)
  if (!hit) {
    selected.value = null
    return
  }
  svgEl.value?.setPointerCapture(ev.pointerId)
  selected.value = hit
  const n = pos.value[hit]
  if (!n) return
  // Shift / 长按连接柄 → 连线模式；否则拖动
  if (ev.shiftKey) linking.value = { from: hit, to: p }
  else mode = { kind: 'node', id: hit, dx: p.x - n.x, dy: p.y - n.y }
}

function onPointerMove(ev: PointerEvent) {
  if (linking.value) {
    const p = toLocal(ev)
    linking.value = { from: linking.value.from, to: p }
    return
  }
  if (mode.kind !== 'node') return
  const m = mode
  const p = toLocal(ev)
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    const next = { ...pos.value }
    next[m.id] = clampPt({ x: p.x - m.dx, y: p.y - m.dy })
    pos.value = next
  })
}

/** pointerup 与 pointercancel 必须走同一处理 */
function onPointerUp(ev: PointerEvent) {
  if (linking.value) {
    const p = toLocal(ev)
    const target = hitTestNode(p, nodes.value)
    const from = linking.value.from
    linking.value = null
    if (target && target !== from) emit('create-relation', from, target)
    return
  }
  if (mode.kind === 'node') {
    mode = { kind: 'none' }
    emit('update:layout', toLayout())
  }
}

function toLayout(): Record<string, GroupNodeLayout> {
  const out: Record<string, GroupNodeLayout> = {}
  for (const [id, p] of Object.entries(pos.value))
    out[id] = { x: Math.round(p.x), y: Math.round(p.y) }
  return out
}

function relayout() {
  pos.value = circleLayout(
    props.members.map((m) => m.id),
    W.value,
    H.value,
  )
  emit('update:layout', toLayout())
}

function startLink(id: string) {
  const p = pos.value[id]
  if (p) linking.value = { from: id, to: { x: p.x + 60, y: p.y } }
}

// ── 就地编辑气泡 ──
/**
 * 正在编辑的关系。直接持有 props.relations 里的那个对象引用 ——
 * 它就是父级草稿里的同一个对象，v-model 改它即改草稿，
 * 再 emit('change') 让父级落盘。
 */
const editing = ref<GroupRelation | null>(null)
/** 气泡锚点（画布坐标；viewBox 与 CSS 像素 1:1，可直接当 left/top 用） */
const anchor = ref<Pt>({ x: 0, y: 0 })

const POP_W = 264
const POP_H = 188

/** 气泡贴着被点的那条边，但不许越出画布 */
const popStyle = computed(() => {
  const a = anchor.value
  const left = Math.max(8, Math.min(W.value - POP_W - 8, a.x - POP_W / 2))
  // 默认放在边的下方；下方放不下就翻到上方
  const below = a.y + 14
  const top = below + POP_H > H.value - 8 ? Math.max(8, a.y - POP_H - 14) : below
  return { left: `${left}px`, top: `${top}px`, width: `${POP_W}px` }
})

function openEditor(r: GroupRelation, at: Pt) {
  editing.value = r
  anchor.value = at
}
function closeEditor() {
  editing.value = null
}
/** 成员或关系被删掉后，别让气泡挂着一个已经不存在的对象 */
watch(
  () => props.relations,
  (list) => {
    const e = editing.value
    if (e && !list.some((r) => r.id === e.id)) editing.value = null
  },
  { deep: true },
)

const ghost = computed(() => {
  const l = linking.value
  if (!l) return null
  const a = pos.value[l.from]
  if (!a) return null
  return `M ${a.x} ${a.y} L ${l.to.x} ${l.to.y}`
})
</script>

<template>
  <div class="graph">
    <div class="graph__bar">
      <span class="graph__hint">
        拖动头像调整位置 ·
        <strong>从节点右上角的 ＋ 拉一条线到另一个节点即可新建关系</strong>（也可按住 Shift 拖拽）·
        点连线就地编辑
      </span>
      <button class="cbx-btn cbx-btn--ghost sm" @click="relayout">重新排布</button>
    </div>

    <!-- viewBox 与元素 CSS 像素 1:1（W/H 由 ResizeObserver 同步），
         所以不需要 preserveAspectRatio，也不会有等比留白 -->
    <svg
      ref="svgEl"
      class="graph__svg"
      :viewBox="`0 0 ${W} ${H}`"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <defs>
        <!-- 两个 marker：context-stroke 兼容性不齐，选中态单独一个 -->
        <marker
          id="rg-arrow"
          markerWidth="9"
          markerHeight="9"
          refX="8"
          refY="4.5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L9,4.5 L0,9 z" class="arrow" />
        </marker>
        <marker
          id="rg-arrow-on"
          markerWidth="9"
          markerHeight="9"
          refX="8"
          refY="4.5"
          orient="auto"
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L9,4.5 L0,9 z" class="arrow arrow--on" />
        </marker>
      </defs>

      <!-- 边 -->
      <g v-for="e in edges" :key="e.r.id">
        <!-- 透明粗描边：加大命中区域，细线很难点中 -->
        <path
          :d="e.path"
          class="edge__hit"
          @pointerdown.stop
          @click.stop="openEditor(e.r, e.label)"
        />
        <path
          :d="e.path"
          class="edge"
          :class="{ 'edge--on': selected === e.r.from || selected === e.r.to }"
          :marker-end="
            selected === e.r.from || selected === e.r.to ? 'url(#rg-arrow-on)' : 'url(#rg-arrow)'
          "
        />
        <text :x="e.label.x" :y="e.label.y" class="edge__label" text-anchor="middle">
          {{ e.r.label || '（未命名）' }}
        </text>
      </g>

      <!-- 连线中的虚线 -->
      <path v-if="ghost" :d="ghost" class="edge--ghost" />

      <!-- 节点 -->
      <g v-for="n in nodes" :key="n.id" :class="{ 'node--on': selected === n.id }" class="node">
        <circle :cx="n.x" :cy="n.y" :r="NODE_R" class="node__ring" />
        <text :x="n.x" :y="n.y + 7" text-anchor="middle" class="node__initial">
          {{ n.name.slice(0, 1) }}
        </text>
        <text :x="n.x" :y="n.y + NODE_R + 16" text-anchor="middle" class="node__label">
          {{ n.name }}
        </text>
        <!-- 连接柄 -->
        <g class="handle" @pointerdown.stop="startLink(n.id)">
          <circle :cx="n.x + NODE_R - 3" :cy="n.y - NODE_R + 3" r="9" class="handle__bg" />
          <text
            :x="n.x + NODE_R - 3"
            :y="n.y - NODE_R + 8"
            text-anchor="middle"
            class="handle__plus"
          >
            ＋
          </text>
        </g>
      </g>
    </svg>

    <!-- 就地编辑气泡：贴在被点的那条边旁边，不再跳到画布下方去找 -->
    <div v-if="editing" class="pop" :style="popStyle">
      <div class="pop__head">
        <span class="pop__title">
          {{ nameOf.get(editing.from) }} → {{ nameOf.get(editing.to) }}
        </span>
        <button class="cbx-icon-btn pop__x" title="关闭" @click="closeEditor">✕</button>
      </div>
      <input
        v-model="editing.label"
        class="cbx-input"
        placeholder="关系，如：青梅竹马"
        @change="emit('change')"
      />
      <textarea
        v-model="editing.desc"
        class="cbx-textarea pop__desc"
        rows="2"
        placeholder="补充描述（可选）"
        @change="emit('change')"
      />
      <div class="pop__ops">
        <button class="cbx-btn cbx-btn--ghost sm" @click="emit('swap-relation', editing)">
          ⇄ 交换方向
        </button>
        <button
          class="cbx-btn cbx-btn--ghost sm pop__del"
          @click="emit('remove-relation', editing.id)"
        >
          删除
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.graph {
  position: relative; /* 就地编辑气泡的定位基准 */
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  overflow: hidden;
}
.graph__bar {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border-bottom: 1px solid var(--cbx-border);
}
.graph__hint {
  flex: 1;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.sm {
  height: 28px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.graph__svg {
  display: block;
  /* 宽度铺满容器；高度给一个舒服的定值。
     viewBox 由 ResizeObserver 同步成这里的实际像素，所以无论多宽都不会留白。 */
  width: 100%;
  height: 460px;
  /* 不写这条，移动端拖节点会变成页面滚动 */
  touch-action: none;
  overscroll-behavior: contain;
  user-select: none;
  -webkit-user-select: none;
  background: var(--cbx-bg);
}

.node {
  cursor: grab;
}
.node__ring {
  fill: var(--cbx-bg-secondary);
  stroke: var(--cbx-border);
  stroke-width: 2;
}
.node--on .node__ring {
  stroke: var(--cbx-brand);
  stroke-width: 3;
}
.node__initial {
  fill: var(--cbx-text-secondary);
  font-size: 20px;
  font-weight: var(--cbx-fw-bold);
}
.node__label {
  fill: var(--cbx-text);
  font-size: 13px;
  /* 文字描边光晕，压住从下面穿过的连线 */
  stroke: var(--cbx-bg);
  stroke-width: 4px;
  paint-order: stroke fill;
}
.handle {
  cursor: crosshair;
}
.handle__bg {
  fill: var(--cbx-brand);
}
.handle__plus {
  fill: var(--cbx-text-on-brand);
  font-size: 11px;
}

.edge {
  fill: none;
  stroke: var(--cbx-border-strong);
  stroke-width: 2;
  pointer-events: none;
}
.edge--on {
  stroke: var(--cbx-brand);
  stroke-width: 3;
}
.edge__hit {
  fill: none;
  stroke: transparent;
  stroke-width: 16;
  cursor: pointer;
}
.edge--ghost {
  fill: none;
  stroke: var(--cbx-brand);
  stroke-width: 2;
  stroke-dasharray: 5 4;
  pointer-events: none;
}
.edge__label {
  fill: var(--cbx-text-secondary);
  font-size: 12px;
  stroke: var(--cbx-bg);
  stroke-width: 4px;
  paint-order: stroke fill;
  pointer-events: none;
}
.arrow {
  fill: var(--cbx-border-strong);
}
.arrow--on {
  fill: var(--cbx-brand);
}

/* —— 就地编辑气泡 —— */
.pop {
  position: absolute;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  box-shadow: var(--cbx-shadow-md);
}
.pop__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.pop__title {
  flex: 1;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pop__x {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}
.pop__desc {
  min-height: 0;
}
.pop__ops {
  display: flex;
  gap: var(--cbx-space-2);
}
.pop__ops .cbx-btn {
  flex: 1;
}
.pop__del {
  color: var(--cbx-error);
}

@media (max-width: 767px) {
  /* 竖屏给高一点，横向空间本来就少。
     viewBox 跟着实际像素走，所以随便设高度都不会产生留白死区。 */
  .graph__svg {
    height: 62vh;
  }
  .pop {
    /* 窄屏下气泡固定贴底，别在 350px 宽的画布里挤来挤去 */
    left: 8px !important;
    right: 8px;
    top: auto !important;
    bottom: 8px;
    width: auto !important;
  }
  .graph__hint {
    display: none;
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
