<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  bowSignOf,
  circleLayout,
  edgeGeometry,
  hitTestNode,
  NODE_R,
  type Pt,
} from '@/utils/graphGeometry'
import type { GraphEdge, GraphEdgePatch, GraphLayoutMap, GraphNode } from '@/types/relationGraph'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'
import { useBackClose } from '@/composables/useBackClose'
import { DRAWER_MQ, useMediaQuery } from '@/composables/useDrawerSwipe'

/**
 * 通用关系图谱画布。
 *
 * 手势要点（桌面调试完全发现不了的坑）：
 *  - 必须 `touch-action: none`，否则移动端拖节点会变成页面滚动、双指变系统缩放
 *  - `pointercancel` 必须与 `pointerup` 走同一处理：iOS 系统手势介入时只发 cancel，
 *    不处理就会永久卡在拖拽状态
 *
 * ## 受控组件
 * ⚠️ 这个画布**永不直接修改 props.edges 里的对象**。
 * 旧版 `RelationGraph` 的 `editing` 直接持有 props 里的那个对象引用、
 * 用 `v-model` 写它 —— 画布悄悄改父级数据，导致父级的 watch / 脏标记 / 撤销
 * 全部失效，也没法做只读画布。现在改成：打开时拷一份本地草稿，
 * 输入时 emit `patch-edge`，失焦时 emit `commit-edge`，由父级决定怎么落。
 */
const props = withDefaults(
  defineProps<{
    nodes: GraphNode[]
    edges: GraphEdge[]
    layout: GraphLayoutMap
    selectedEdgeId?: string | null
    selectedNodeId?: string | null
    /**
     * `popover` = 画布自带就地编辑气泡（群聊沿用）；
     * `none` = 只发选中事件，父级自管侧面板（无限世界用）。
     */
    editorMode?: 'popover' | 'none'
    readonly?: boolean
    /** 桌面画布高度，CSS 长度值 */
    height?: string
    /**
     * 窄屏画布高度。
     *
     * ⚠️ 必须与 height 分开，且两者都只能经 CSS 自定义属性下发。
     * 直接写 `:style="{ height }"` 的话，内联样式优先级高于 `@media` 规则，
     * 窄屏那条 62vh 会被静默压掉 —— 表现为「手机上画布只有 460px 高、
     * 节点挤成一团」，而桌面完全正常。
     */
    mobileHeight?: string
  }>(),
  {
    selectedEdgeId: null,
    selectedNodeId: null,
    editorMode: 'popover',
    readonly: false,
    height: '460px',
    mobileHeight: '62vh',
  },
)

const emit = defineEmits<{
  'update:layout': [v: GraphLayoutMap]
  'update:selectedEdgeId': [v: string | null]
  'update:selectedNodeId': [v: string | null]
  'create-edge': [from: string, to: string]
  /** 输入过程中的实时修改 */
  'patch-edge': [id: string, patch: GraphEdgePatch]
  /** 失焦/回车：请父级落盘 */
  'commit-edge': [id: string]
  /** ⚠️ 传 id 不传对象 —— 传对象就是在邀请调用方就地改属性 */
  'remove-edge': [id: string]
  'swap-edge': [id: string]
  relayout: []
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
/** 连线模式：从某节点拖出一条虚线到另一节点 */
const linking = ref<{ from: string; to: Pt } | null>(null)

const nameOf = computed(() => new Map(props.nodes.map((n) => [n.id, n.name])))

function syncLayout() {
  const next: Record<string, Pt> = {}
  const missing: string[] = []
  for (const n of props.nodes) {
    const p = props.layout[n.id]
    if (p) next[n.id] = clampPt(p)
    else missing.push(n.id)
  }
  if (missing.length) {
    // 新成员沿圆周补位（避免全都堆在 0,0）
    const seeded = circleLayout(
      props.nodes.map((n) => n.id),
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
watch(() => [props.nodes.map((n) => n.id).join(','), props.layout], syncLayout, { deep: true })

const drawNodes = computed(() =>
  props.nodes.map((n) => ({
    id: n.id,
    name: n.name,
    isUser: !!n.isUser,
    avatarUrl: n.avatarUrl,
    subtitle: n.subtitle,
    dimmed: !!n.dimmed,
    ...(pos.value[n.id] ?? { x: 0, y: 0 }),
  })),
)

/** 只画两端都还在的边 */
const drawEdges = computed(() =>
  props.edges
    .map((e) => {
      const a = pos.value[e.from]
      const b = pos.value[e.to]
      if (!a || !b) return null
      const g = edgeGeometry(a, b, bowSignOf(e.from, e.to))
      return { e, ...g }
    })
    .filter((x): x is NonNullable<typeof x> => !!x),
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
  if (props.readonly) return
  const p = toLocal(ev)
  const hit = hitTestNode(p, drawNodes.value)
  if (!hit) {
    emit('update:selectedNodeId', null)
    return
  }
  svgEl.value?.setPointerCapture(ev.pointerId)
  emit('update:selectedNodeId', hit)
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
    const target = hitTestNode(p, drawNodes.value)
    const from = linking.value.from
    linking.value = null
    if (target && target !== from) emit('create-edge', from, target)
    return
  }
  if (mode.kind === 'node') {
    mode = { kind: 'none' }
    emit('update:layout', toLayout())
  }
}

function toLayout(): GraphLayoutMap {
  const out: GraphLayoutMap = {}
  for (const [id, p] of Object.entries(pos.value))
    out[id] = { x: Math.round(p.x), y: Math.round(p.y) }
  return out
}

function relayout() {
  pos.value = circleLayout(
    props.nodes.map((n) => n.id),
    W.value,
    H.value,
  )
  emit('update:layout', toLayout())
  emit('relayout')
}

function startLink(id: string) {
  if (props.readonly) return
  const p = pos.value[id]
  if (p) linking.value = { from: id, to: { x: p.x + 60, y: p.y } }
}

// ── 就地编辑气泡（editorMode === 'popover' 时才渲染） ──
/**
 * 气泡编辑的**本地副本**。
 *
 * ⚠️ 旧实现直接持有 props.edges 里的对象、`v-model` 写它 —— 画布悄悄改父级
 * 数据。现在拷一份：输入时 emit `patch-edge`（父级实时应用，边上的标签才会
 * 跟着变），失焦时 emit `commit-edge`（父级落盘）。
 */
const draftEdge = ref<{ id: string; label: string; desc: string } | null>(null)
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

function onEdgeClick(e: GraphEdge, at: Pt) {
  emit('update:selectedEdgeId', e.id)
  if (props.editorMode !== 'popover' || props.readonly) return
  // ⚠️ desc 必须从边上取初值。初始化成空串的话，用户一输入 label
  // 就会把原有的 desc 一起覆盖成空 —— 而这在 UI 上完全看不出来。
  draftEdge.value = { id: e.id, label: e.label, desc: e.desc ?? '' }
  anchor.value = at
}

function closeEditor() {
  // 先落盘：原来只靠输入框的 change（失焦）提交，手机上按返回键关页面时
  // 输入框不会先失焦，最后一次改动就只停在内存里
  onDraftCommit()
  draftEdge.value = null
  emit('update:selectedEdgeId', null)
}

/**
 * 手机上编辑气泡改为整页（Teleport 到 body，脱离 350px 宽的画布），
 * 与其它弹框一致：左上角返回、返回键关闭。桌面仍是贴着边的小气泡。
 */
const pageMode = useMediaQuery(DRAWER_MQ)
useBackClose(
  closeEditor,
  () => !!draftEdge.value,
  () => pageMode.value,
)

function onDraftInput() {
  const d = draftEdge.value
  if (d) emit('patch-edge', d.id, { label: d.label, desc: d.desc })
}
function onDraftCommit() {
  const d = draftEdge.value
  if (d) emit('commit-edge', d.id)
}

/** 成员或关系被删掉后，别让气泡挂着一个已经不存在的对象 */
watch(
  () => props.edges,
  (list) => {
    const d = draftEdge.value
    if (d && !list.some((e) => e.id === d.id)) draftEdge.value = null
  },
  { deep: true },
)

/** 父级把选中清掉时（例如侧面板关了），气泡也要跟着关 */
watch(
  () => props.selectedEdgeId,
  (id) => {
    if (id === null) draftEdge.value = null
  },
)

const ghost = computed(() => {
  const l = linking.value
  if (!l) return null
  const a = pos.value[l.from]
  if (!a) return null
  return `M ${a.x} ${a.y} L ${l.to.x} ${l.to.y}`
})

function edgeIsOn(e: GraphEdge): boolean {
  return (
    props.selectedEdgeId === e.id ||
    props.selectedNodeId === e.from ||
    props.selectedNodeId === e.to
  )
}
</script>

<template>
  <div class="graph" :style="{ '--graph-h': height, '--graph-h-mobile': mobileHeight }">
    <div class="graph__bar">
      <span class="graph__hint"><slot name="hint" /></span>
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
        <clipPath id="rg-avatar-clip">
          <circle :cx="0" :cy="0" :r="NODE_R - 2" />
        </clipPath>
      </defs>

      <!-- 边 -->
      <g v-for="d in drawEdges" :key="d.e.id">
        <!-- 透明粗描边：加大命中区域，细线很难点中 -->
        <path
          :d="d.path"
          class="edge__hit"
          @pointerdown.stop
          @click.stop="onEdgeClick(d.e, d.label)"
        />
        <path
          :d="d.path"
          class="edge"
          :class="{ 'edge--on': edgeIsOn(d.e), [`edge--${d.e.tone}`]: !!d.e.tone }"
          :marker-end="edgeIsOn(d.e) ? 'url(#rg-arrow-on)' : 'url(#rg-arrow)'"
        />
        <text :x="d.label.x" :y="d.label.y" class="edge__label" text-anchor="middle">
          {{ d.e.label || '（未命名）' }}
        </text>
        <text
          v-if="d.e.badge"
          :x="d.label.x"
          :y="d.label.y + 13"
          class="edge__badge"
          text-anchor="middle"
        >
          {{ d.e.badge }}
        </text>
      </g>

      <!-- 连线中的虚线 -->
      <path v-if="ghost" :d="ghost" class="edge--ghost" />

      <!-- 节点 -->
      <g
        v-for="n in drawNodes"
        :key="n.id"
        :class="{
          'node--on': selectedNodeId === n.id,
          'node--me': n.isUser,
          'node--dim': n.dimmed,
        }"
        class="node"
      >
        <circle :cx="n.x" :cy="n.y" :r="NODE_R" class="node__ring" />
        <image
          v-if="n.avatarUrl"
          :href="n.avatarUrl"
          :x="n.x - NODE_R + 2"
          :y="n.y - NODE_R + 2"
          :width="(NODE_R - 2) * 2"
          :height="(NODE_R - 2) * 2"
          class="node__avatar"
          preserveAspectRatio="xMidYMid slice"
        />
        <text v-else :x="n.x" :y="n.y + 7" text-anchor="middle" class="node__initial">
          {{ n.name.slice(0, 1) }}
        </text>
        <text :x="n.x" :y="n.y + NODE_R + 16" text-anchor="middle" class="node__label">
          {{ n.name }}
        </text>
        <text
          v-if="n.subtitle"
          :x="n.x"
          :y="n.y + NODE_R + 29"
          text-anchor="middle"
          class="node__sub"
        >
          {{ n.subtitle }}
        </text>
        <!-- 连接柄 -->
        <g v-if="!readonly" class="handle" @pointerdown.stop="startLink(n.id)">
          <circle :cx="n.x + NODE_R - 3" :cy="n.y - NODE_R + 3" r="9" class="handle__bg" />
          <path
            :d="`M${n.x + NODE_R - 7} ${n.y - NODE_R + 3}h8 M${n.x + NODE_R - 3} ${n.y - NODE_R - 1}v8`"
            class="handle__plus"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </g>
      </g>
    </svg>

    <!-- 就地编辑气泡：贴在被点的那条边旁边，不再跳到画布下方去找 -->
    <Teleport to="body" :disabled="!pageMode">
      <div
        v-if="draftEdge"
        class="pop"
        :class="{ 'cbx-page': pageMode }"
        :style="pageMode ? undefined : popStyle"
        :role="pageMode ? 'dialog' : undefined"
        :aria-modal="pageMode || undefined"
      >
        <div class="pop__head cbx-page-head">
          <span class="pop__title">
            {{ nameOf.get(edges.find((e) => e.id === draftEdge!.id)?.from ?? '') }}
            <AppIcon name="ArrowRight" />
            {{ nameOf.get(edges.find((e) => e.id === draftEdge!.id)?.to ?? '') }}
          </span>
          <CbxDialogClose class="pop__x" @click="closeEditor" />
        </div>
        <div class="pop__body cbx-page-body">
          <input
            v-model="draftEdge.label"
            class="cbx-input"
            placeholder="关系，如：青梅竹马"
            @input="onDraftInput"
            @change="onDraftCommit"
          />
          <textarea
            v-model="draftEdge.desc"
            class="cbx-textarea pop__desc"
            rows="2"
            placeholder="补充描述（可选）"
            @input="onDraftInput"
            @change="onDraftCommit"
          />
          <div class="pop__ops">
            <button class="cbx-btn cbx-btn--ghost sm" @click="emit('swap-edge', draftEdge.id)">
              <AppIcon name="ArrowLeftRight" /> 交换方向
            </button>
            <button
              class="cbx-btn cbx-btn--ghost sm pop__del"
              @click="emit('remove-edge', draftEdge.id)"
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </Teleport>
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
  /* 宽度铺满容器；高度由 --graph-h 给（见 props.height 的注释：
     不能用内联 style，否则窄屏那条媒体查询压不过）。
     viewBox 由 ResizeObserver 同步成这里的实际像素，所以无论多宽都不会留白。 */
  width: 100%;
  height: var(--graph-h, 460px);
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
.node--dim {
  opacity: 0.45;
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
/* 「我」这个节点要一眼认出来 —— 画布上全是角色，混进去就分不清哪个是自己 */
.node--me .node__ring {
  fill: var(--cbx-brand-light);
  stroke: var(--cbx-brand);
  stroke-dasharray: 4 3;
}
.node--me .node__initial,
.node--me .node__label {
  fill: var(--cbx-brand);
}
.node__initial {
  fill: var(--cbx-text-secondary);
  font-size: 20px;
  font-weight: var(--cbx-fw-bold);
}
.node__avatar {
  clip-path: circle(calc(50% - 2px));
  pointer-events: none;
}
.node__label {
  fill: var(--cbx-text);
  font-size: 13px;
  /* 文字描边光晕，压住从下面穿过的连线 */
  stroke: var(--cbx-bg);
  stroke-width: 4px;
  paint-order: stroke fill;
}
.node__sub {
  fill: var(--cbx-text-tertiary);
  font-size: 11px;
  stroke: var(--cbx-bg);
  stroke-width: 3px;
  paint-order: stroke fill;
}
.handle {
  cursor: crosshair;
}
.handle__bg {
  fill: var(--cbx-brand);
}
.handle__plus {
  fill: none;
  color: var(--cbx-text-on-brand);
  transform-box: fill-box;
  transform-origin: center;
  transition: transform var(--cbx-icon-duration) var(--cbx-icon-ease);
}
@media (hover: hover) and (pointer: fine) {
  .handle:hover .handle__plus {
    transform: rotate(90deg);
  }
}
.handle:active .handle__plus {
  transform: rotate(90deg) scale(0.85);
}
@media (prefers-reduced-motion: reduce) {
  .handle__plus {
    transition: none;
  }
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
.edge--positive {
  stroke: var(--cbx-success);
}
.edge--negative {
  stroke: var(--cbx-error);
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
.edge__badge {
  fill: var(--cbx-text-tertiary);
  font-size: 10px;
  stroke: var(--cbx-bg);
  stroke-width: 3px;
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
.pop__body {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.pop__desc {
  min-height: 0;
}
/* 整页模式（手机）：内容区留白、描述框给足高度、关闭键恢复触控尺寸 */
.pop.cbx-page .pop__body {
  padding: var(--cbx-space-4);
  gap: var(--cbx-space-3);
}
.pop.cbx-page .pop__desc {
  min-height: 120px;
}
.pop.cbx-page .pop__x {
  width: var(--cbx-tap-min);
  height: var(--cbx-tap-min);
}
.pop.cbx-page .pop__head {
  border-bottom: 1px solid var(--cbx-border);
}
.pop.cbx-page .pop__title {
  font-size: var(--cbx-fs-lg);
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
    height: var(--graph-h-mobile, 62vh);
  }
  .graph__hint {
    display: none;
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
