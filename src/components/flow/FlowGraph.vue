<script setup lang="ts">
/**
 * 流程控制的节点流程图：阶段、规则、动作都是节点，连线带流动动画表示执行方向。
 *  - 点节点 / 连线 → 右侧（手机在下方）检查面板里编辑
 *  - 拖节点 → 记住位置（cfg.layout）
 *  - 从阶段右侧圆点拖到另一个阶段 → 新建阶段出口；拖到规则 → 给规则加「当前阶段」条件；
 *    从动作拖到阶段 → 该动作变成「切换到这个阶段」
 * 受控组件：每次改动整体 emit 一份新配置。
 */
import { computed, ref } from 'vue'
import { VueFlow, Handle, Position, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import '@vue-flow/core/dist/style.css'
import AppIcon from '@/components/icons/AppIcon.vue'
import FlowEdge from './FlowEdge.vue'
import FlowInspector from './FlowInspector.vue'
import { sanitizeFlow } from '@/services/flow/engine'
import {
  buildGraph,
  pruneLayout,
  stageNodeId,
  AUX_HANDLE,
  type FlowSelection,
} from '@/services/flow/graph'
import { actionText, condsText, transitionText, triggerText } from '@/services/flow/describe'
import { useWorldsStore } from '@/stores/worlds'
import { newFlowRule, type FlowConfig, type FlowLayout } from '@/types/flow'
import type { StatusField } from '@/types/status'

const props = defineProps<{
  config: FlowConfig | undefined
  fields: StatusField[]
  people: string[]
  isGroup?: boolean
}>()
const emit = defineEmits<{ 'update:config': [cfg: FlowConfig | undefined] }>()

const flowId = `flow-${Math.random().toString(36).slice(2, 8)}`
const { fitView, zoomIn, zoomOut } = useVueFlow(flowId)
const worlds = useWorldsStore()
if (!worlds.loaded) void worlds.load()

const cfg = computed(() => sanitizeFlow(props.config))
const stages = computed(() => cfg.value.stages ?? [])
const sel = ref<FlowSelection>(null)
const newId = () => crypto.randomUUID()

/** 统一提交：清掉已删节点的坐标；什么都没有了就整份清空 */
function commit(next: FlowConfig) {
  const layout = pruneLayout(next)
  const hasStages = (next.stages?.length ?? 0) > 0
  emit(
    'update:config',
    next.rules.length || hasStages
      ? {
          rules: next.rules,
          ...(hasStages ? { stages: next.stages } : {}),
          ...(layout ? { layout } : {}),
        }
      : undefined,
  )
}
const graph = computed(() => buildGraph(cfg.value))

// ── 节点摘要：模板里按 id 取对应的配置 ──
const stageOf = (id?: string) => stages.value.find((s) => s.id === id)
const ruleOf = (id?: string) => cfg.value.rules.find((r) => r.id === id)
const actionOf = (ruleId?: string, id?: string) => ruleOf(ruleId)?.actions.find((a) => a.id === id)
function loreLabel(book?: string, uid?: number): string {
  const b = worlds.byId(book)
  const e = b && typeof uid === 'number' ? b.entries[String(uid)] : undefined
  return b ? `${b.name} · ${e ? e.comment || e.key[0] || `#${uid}` : '?'}` : ''
}
const ruleSummary = (id?: string) => {
  const r = ruleOf(id)
  return r ? condsText(r.conditions, r.match, stages.value, '无条件：检查时直接成立') : ''
}
const actionSummary = (ruleId?: string, id?: string) => {
  const a = actionOf(ruleId, id)
  return a ? actionText(a, stages.value, loreLabel) : ''
}

/** 选中的东西所在的连线加粗、流动加快 */
const edges = computed(() =>
  graph.value.edges.map((e) => {
    const s = sel.value
    const active =
      !!s &&
      ((s.kind === 'transition' && e.data.transitionId === s.transitionId) ||
        ((s.kind === 'rule' || s.kind === 'action') && e.data.ruleId === s.ruleId) ||
        (s.kind === 'stage' &&
          (e.source === stageNodeId(s.stageId) || e.target === stageNodeId(s.stageId))))
    const t =
      e.data.kind === 'transition'
        ? stageOf(e.data.stageId)?.transitions.find((x) => x.id === e.data.transitionId)
        : undefined
    return {
      ...e,
      data: { ...e.data, active, ...(t ? { label: transitionText(t, stages.value) } : {}) },
    }
  }),
)

// ── 交互 ──
type NodeEvt = { node: { id: string; type?: string; data: Record<string, string | undefined> } }
function onNodeClick({ node }: NodeEvt) {
  const d = node.data
  if (node.type === 'stage' && d['stageId']) sel.value = { kind: 'stage', stageId: d['stageId'] }
  else if (node.type === 'rule' && d['ruleId']) sel.value = { kind: 'rule', ruleId: d['ruleId'] }
  else if (node.type === 'action' && d['ruleId'] && d['actionId'])
    sel.value = { kind: 'action', ruleId: d['ruleId'], actionId: d['actionId'] }
}
type EdgeEvt = { edge: { data?: { stageId?: string; transitionId?: string; ruleId?: string } } }
function onEdgeClick({ edge }: EdgeEvt) {
  const d = edge.data
  if (d?.stageId && d.transitionId)
    sel.value = { kind: 'transition', stageId: d.stageId, transitionId: d.transitionId }
  else if (d?.ruleId) sel.value = { kind: 'rule', ruleId: d.ruleId }
}

/** 拖完一个节点：把当前所有节点位置一起定下来，之后增删节点不会让已摆好的节点跳位 */
type DragEvt = {
  node?: { id: string; position: { x: number; y: number } }
  nodes?: { id: string; position: { x: number; y: number } }[]
}
function onNodeDragStop(e: DragEvt) {
  const layout: FlowLayout = {}
  for (const n of graph.value.nodes) layout[n.id] = n.position
  for (const n of e.nodes?.length ? e.nodes : e.node ? [e.node] : []) layout[n.id] = n.position
  commit({ ...cfg.value, layout })
}

/** 拖线建立关系：阶段→阶段 = 出口；阶段→规则 = 「当前阶段」条件；动作→阶段 = 切换阶段 */
function onConnect(c: { source: string; target: string }) {
  const [sk, ...sRest] = c.source.split(':')
  const [tk, tId] = c.target.split(':')
  const next = structuredClone(cfg.value)
  if (sk === 's' && tk === 's' && sRest[0] !== tId) {
    const st = next.stages?.find((s) => s.id === sRest[0])
    if (!st || !tId) return
    const t = { id: newId(), to: tId, match: 'all' as const, conditions: [] }
    st.transitions.push(t)
    commit(next)
    sel.value = { kind: 'transition', stageId: st.id, transitionId: t.id }
  } else if (sk === 's' && tk === 'r') {
    const r = next.rules.find((x) => x.id === tId)
    if (!r || !sRest[0]) return
    r.conditions.push({ id: newId(), source: 'stage', op: 'eq', value: sRest[0] })
    commit(next)
    sel.value = { kind: 'rule', ruleId: r.id }
  } else if (sk === 'a' && tk === 's') {
    const [ruleId, actionId] = sRest
    const a = next.rules.find((x) => x.id === ruleId)?.actions.find((x) => x.id === actionId)
    if (!a || !tId || !ruleId || !actionId) return
    a.kind = 'setStage'
    a.stage = tId
    commit(next)
    sel.value = { kind: 'action', ruleId, actionId }
  }
}

// ── 工具栏 ──
function addStage() {
  const s = { id: newId(), name: `阶段 ${stages.value.length + 1}`, transitions: [] }
  commit({ ...cfg.value, stages: [...stages.value, s] })
  sel.value = { kind: 'stage', stageId: s.id }
}
function addRule() {
  const r = newFlowRule(newId(), `规则 ${cfg.value.rules.length + 1}`)
  commit({ ...cfg.value, rules: [...cfg.value.rules, r] })
  sel.value = { kind: 'rule', ruleId: r.id }
}
function resetLayout() {
  const { layout: _drop, ...rest } = cfg.value
  commit(rest)
  setTimeout(() => void fitView({ padding: 0.2 }), 50)
}
const fit = () => void fitView({ padding: 0.2 })
const onPaneReady = () => setTimeout(fit, 30)
</script>
<template>
  <div class="fg">
    <div class="fg-main">
      <div class="fg-bar" role="toolbar" aria-label="流程图工具">
        <button type="button" class="cbx-btn cbx-btn--soft sm" @click="addStage">
          <AppIcon name="Plus" /> 阶段
        </button>
        <button type="button" class="cbx-btn cbx-btn--soft sm" @click="addRule">
          <AppIcon name="Plus" /> 规则
        </button>
        <span class="fg-bar__gap" />
        <button type="button" class="cbx-icon-btn" aria-label="缩小" @click="zoomOut()">−</button>
        <button type="button" class="cbx-icon-btn" aria-label="放大" @click="zoomIn()">+</button>
        <button type="button" class="cbx-btn cbx-btn--ghost sm" @click="fit">适应画布</button>
        <button type="button" class="cbx-btn cbx-btn--ghost sm" @click="resetLayout">
          重新排列
        </button>
      </div>
      <div class="fg-canvas">
        <p v-if="!graph.nodes.length" class="fg-empty">
          还没有节点。点上方「+ 阶段」或「+ 规则」开始；从阶段右侧的圆点拖到另一个阶段即可连线。
        </p>
        <VueFlow
          :id="flowId"
          :nodes="graph.nodes"
          :edges="edges"
          :min-zoom="0.3"
          :max-zoom="1.8"
          :delete-key-code="null"
          :nodes-connectable="true"
          @node-click="onNodeClick"
          @edge-click="onEdgeClick"
          @pane-click="sel = null"
          @node-drag-stop="onNodeDragStop"
          @connect="onConnect"
          @pane-ready="onPaneReady"
        >
          <Background :gap="20" :size="1" />

          <template #node-stage="{ data, selected }">
            <div
              class="fn fn--stage"
              :class="{
                'fn--sel': selected || (sel?.kind === 'stage' && sel.stageId === data.stageId),
              }"
              :aria-label="`阶段 ${stageOf(data.stageId)?.name ?? ''}`"
            >
              <Handle type="target" :position="Position.Left" />
              <span class="fn__tag">{{ data.initial ? '初始阶段' : '阶段' }}</span>
              <span class="fn__title">{{ stageOf(data.stageId)?.name || '未命名阶段' }}</span>
              <span v-if="stageOf(data.stageId)?.guide" class="fn__text">
                {{ stageOf(data.stageId)?.guide }}
              </span>
              <Handle type="source" :position="Position.Right" />
              <!-- 阶段条件从底部接出，避免横穿画布 -->
              <Handle
                :id="AUX_HANDLE.whenSource"
                type="source"
                :position="Position.Bottom"
                class="fn__aux"
              />
            </div>
          </template>

          <template #node-rule="{ data, selected }">
            <div
              class="fn fn--rule"
              :class="{
                'fn--sel': selected || (sel?.kind === 'rule' && sel.ruleId === data.ruleId),
                'fn--off': ruleOf(data.ruleId)?.enabled === false,
              }"
              :aria-label="`规则 ${ruleOf(data.ruleId)?.name ?? ''}`"
            >
              <Handle type="target" :position="Position.Left" />
              <!-- 阶段条件从顶部进入 -->
              <Handle
                :id="AUX_HANDLE.whenTarget"
                type="target"
                :position="Position.Top"
                class="fn__aux"
              />
              <span class="fn__tag"
                >规则 · {{ ruleOf(data.ruleId) ? triggerText(ruleOf(data.ruleId)!) : '' }}</span
              >
              <span class="fn__title">{{ ruleOf(data.ruleId)?.name }}</span>
              <span class="fn__text">{{ ruleSummary(data.ruleId) }}</span>
              <Handle type="source" :position="Position.Right" />
            </div>
          </template>

          <template #node-action="{ data, selected }">
            <div
              class="fn fn--action"
              :class="{
                'fn--sel':
                  selected ||
                  (sel?.kind === 'action' &&
                    sel.actionId === data.actionId &&
                    sel.ruleId === data.ruleId),
              }"
            >
              <Handle type="target" :position="Position.Left" />
              <span class="fn__tag">动作</span>
              <span class="fn__text">{{ actionSummary(data.ruleId, data.actionId) }}</span>
              <Handle type="source" :position="Position.Right" />
              <!-- 切换阶段从底部接出 -->
              <Handle
                :id="AUX_HANDLE.jumpSource"
                type="source"
                :position="Position.Bottom"
                class="fn__aux"
              />
            </div>
          </template>

          <template #edge-flow="e">
            <FlowEdge
              :id="e.id"
              :source-x="e.sourceX"
              :source-y="e.sourceY"
              :target-x="e.targetX"
              :target-y="e.targetY"
              :source-position="e.sourcePosition"
              :target-position="e.targetPosition"
              :marker-end="e.markerEnd"
              :selected="e.selected"
              :data="e.data"
              @label-click="onEdgeClick({ edge: e })"
            />
          </template>
        </VueFlow>
      </div>
      <p class="fg-legend">
        <span class="lg lg--transition">阶段出口</span>
        <span class="lg lg--chain">依次执行</span>
        <span class="lg lg--jump">切换阶段</span>
        <span class="lg lg--when">阶段条件</span>
      </p>
    </div>
    <FlowInspector
      class="fg-side"
      :config="cfg"
      :selection="sel"
      :fields="fields"
      :people="people"
      v-bind="isGroup ? { isGroup: true } : {}"
      @update:config="commit"
      @select="sel = $event"
    />
  </div>
</template>

<style scoped>
.fg {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 340px;
  gap: var(--cbx-space-3);
  align-items: start;
}
.fg-main {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  min-width: 0;
}
.fg-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--cbx-space-2);
}
.fg-bar__gap {
  flex: 1;
}
.sm {
  height: 32px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.fg-canvas {
  position: relative;
  height: 560px;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg-secondary);
  overflow: hidden;
}
.fg-empty {
  position: absolute;
  inset: 0;
  z-index: 5;
  display: grid;
  place-items: center;
  margin: 0;
  padding: var(--cbx-space-4);
  text-align: center;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-tertiary);
  pointer-events: none;
}
.fg-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-3);
  margin: 0;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
}
.lg::before {
  content: '';
  display: inline-block;
  width: 18px;
  height: 0;
  margin-right: 6px;
  vertical-align: middle;
  border-top: 2px dashed currentColor;
}
.lg--transition::before {
  color: var(--cbx-brand);
}
.lg--chain::before {
  color: var(--cbx-warning-hover, #d97706);
}
.lg--jump::before {
  color: var(--cbx-error, #dc2626);
}
.lg--when::before {
  color: var(--cbx-text-tertiary, #94a3b8);
  border-top-style: dotted;
}
.fn {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 200px;
  padding: 8px 12px;
  color: var(--cbx-text);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-left: 4px solid var(--fn-color);
  border-radius: var(--cbx-radius-md);
  box-shadow: var(--cbx-shadow-sm, 0 1px 2px rgb(0 0 0 / 8%));
  cursor: pointer;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.fn--stage {
  --fn-color: var(--cbx-brand);
}
.fn--rule {
  --fn-color: var(--cbx-success, #16a34a);
}
.fn--action {
  --fn-color: var(--cbx-warning-hover, #d97706);
  width: 210px;
}
.fn--sel {
  border-color: var(--fn-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--fn-color) 25%, transparent);
}
.fn--off {
  opacity: 0.5;
}
.fn__tag {
  font-size: 11px;
  color: var(--cbx-text-tertiary);
}
.fn__title {
  font-weight: var(--cbx-fw-medium);
  font-size: var(--cbx-fs-sm);
  overflow-wrap: anywhere;
}
.fn__text {
  font-size: var(--cbx-fs-xs);
  line-height: 1.5;
  color: var(--cbx-text-secondary);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.fn :deep(.vue-flow__handle) {
  width: 12px;
  height: 12px;
  background: var(--fn-color);
  border: 2px solid var(--cbx-bg);
}
/* 辅助锚点（切换阶段 / 阶段条件）小一号，和主连接点区分开 */
.fn :deep(.fn__aux.vue-flow__handle) {
  width: 9px;
  height: 9px;
  border-width: 1.5px;
}
.fn :deep(.vue-flow__handle-bottom) {
  bottom: -5px;
}
.fn :deep(.vue-flow__handle-top) {
  top: -5px;
}
@media (max-width: 1100px) {
  .fg {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 767px) {
  .fg-canvas {
    height: 60vh;
    min-height: 360px;
  }
  .sm {
    height: var(--cbx-tap-min, 40px);
  }
  .fn :deep(.vue-flow__handle) {
    width: 18px;
    height: 18px;
  }
}
</style>
