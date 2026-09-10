<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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
  'edit-relation': [r: GroupRelation]
  'create-relation': [from: string, to: string]
}>()

const svgEl = ref<SVGSVGElement | null>(null)
const W = 720
const H = 460

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
    if (p) next[m.id] = { x: p.x, y: p.y }
    else missing.push(m.id)
  }
  if (missing.length) {
    // 新成员沿圆周补位（避免全都堆在 0,0）
    const seeded = circleLayout(
      props.members.map((m) => m.id),
      W,
      H,
    )
    for (const id of missing) {
      const p = seeded[id]
      if (p) next[id] = p
    }
  }
  pos.value = next
}

onMounted(syncLayout)
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

// ── pointer 状态机 ──
type Mode = { kind: 'none' } | { kind: 'node'; id: string; dx: number; dy: number }
let mode: Mode = { kind: 'none' }
let rafId = 0

function toLocal(ev: PointerEvent): Pt {
  const el = svgEl.value
  if (!el) return { x: 0, y: 0 }
  const r = el.getBoundingClientRect()
  // viewBox 与实际像素尺寸可能不同，按比例换算
  return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H }
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
    next[m.id] = {
      x: Math.max(NODE_R, Math.min(W - NODE_R, p.x - m.dx)),
      y: Math.max(NODE_R, Math.min(H - NODE_R, p.y - m.dy)),
    }
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
    W,
    H,
  )
  emit('update:layout', toLayout())
}

function startLink(id: string) {
  const p = pos.value[id]
  if (p) linking.value = { from: id, to: { x: p.x + 60, y: p.y } }
}

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
        拖动头像调整位置 · 点节点上的 ＋ 拉出一条关系（也可按住 Shift 拖拽）· 点连线编辑
      </span>
      <button class="cbx-btn cbx-btn--ghost sm" @click="relayout">重新排布</button>
    </div>

    <svg
      ref="svgEl"
      class="graph__svg"
      :viewBox="`0 0 ${W} ${H}`"
      preserveAspectRatio="xMidYMid meet"
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
          @click.stop="emit('edit-relation', e.r)"
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
  </div>
</template>

<style scoped>
.graph {
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
  width: 100%;
  height: 420px;
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

@media (max-width: 767px) {
  .graph__svg {
    height: 55vh;
  }
  .graph__hint {
    display: none;
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
