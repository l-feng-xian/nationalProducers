<script setup lang="ts">
/**
 * 节点流程图的检查面板：按当前选中的节点 / 连线显示对应表单。
 * 受控：每次改动 emit 整份新配置，由 FlowGraph 统一提交（顺带清理坐标）。
 */
import { computed } from 'vue'
import AppIcon from '@/components/icons/AppIcon.vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import FlowConditionForm from './FlowConditionForm.vue'
import FlowActionForm from './FlowActionForm.vue'
import { condText, transitionText } from '@/services/flow/describe'
import { dropStageRefs } from '@/services/flow/edit'
import type { FlowSelection } from '@/services/flow/graph'
import {
  FLOW_ACTION_LABEL,
  FLOW_MODE_LABEL,
  type FlowAction,
  type FlowActionKind,
  type FlowCondition,
  type FlowConfig,
  type FlowRule,
  type FlowStage,
  type FlowTransition,
} from '@/types/flow'
import type { StatusField } from '@/types/status'

const props = defineProps<{
  config: FlowConfig
  selection: FlowSelection
  fields: StatusField[]
  people: string[]
  isGroup?: boolean
}>()
const emit = defineEmits<{ 'update:config': [cfg: FlowConfig]; select: [s: FlowSelection] }>()

const newId = () => crypto.randomUUID()
const MATCH_OPTIONS = [
  { value: 'all', label: '全部满足（且）' },
  { value: 'any', label: '任一满足（或）' },
]
const TRIGGER_OPTIONS = [
  { value: 'afterReply', label: '每条 AI 回复后' },
  { value: 'everyN', label: '每 N 条 AI 回复' },
]
const val = (e: Event) =>
  (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
const num = (e: Event) => {
  const n = Number(val(e))
  return Number.isFinite(n) ? n : undefined
}
const stages = computed(() => props.config.stages ?? [])
const actionKinds = Object.keys(FLOW_ACTION_LABEL) as FlowActionKind[]

const stage = computed(() => {
  const s = props.selection
  return s && (s.kind === 'stage' || s.kind === 'transition')
    ? stages.value.find((x) => x.id === s.stageId)
    : undefined
})
const transition = computed(() => {
  const s = props.selection
  return s?.kind === 'transition'
    ? stage.value?.transitions.find((t) => t.id === s.transitionId)
    : undefined
})
const rule = computed(() => {
  const s = props.selection
  return s && (s.kind === 'rule' || s.kind === 'action')
    ? props.config.rules.find((r) => r.id === s.ruleId)
    : undefined
})
const action = computed(() => {
  const s = props.selection
  return s?.kind === 'action' ? rule.value?.actions.find((a) => a.id === s.actionId) : undefined
})
const stageIndex = computed(() => stages.value.findIndex((s) => s.id === stage.value?.id))

function newCondition(): FlowCondition {
  const person = props.fields.filter((f) => f.scope !== 'scene')
  return {
    id: newId(),
    source: 'person',
    who: '{{char}}',
    key: (person.find((f) => f.kind === 'number') ?? person[0])?.key ?? '',
    op: 'gte',
    value: '',
  }
}

// ── 阶段 ──
function patchStage(p: Partial<FlowStage>) {
  const id = stage.value?.id
  emit('update:config', {
    ...props.config,
    stages: stages.value.map((s) => (s.id === id ? { ...s, ...p } : s)),
  })
}
function makeInitial() {
  const s = stage.value
  if (!s) return
  emit('update:config', {
    ...props.config,
    stages: [s, ...stages.value.filter((x) => x.id !== s.id)],
  })
}
function removeStage() {
  const id = stage.value?.id
  if (!id) return
  // 除了指向它的连线，还要清掉「切换到这个阶段」的动作和「当前阶段 = 它」的条件：
  // 留着不会报错，只会在触发时静默失效（见 services/flow/edit.ts）
  emit('update:config', dropStageRefs(props.config, id))
  emit('select', null)
}
function addTransition() {
  const s = stage.value
  const to = stages.value.find((x) => x.id !== s?.id)?.id
  if (!s || !to) return
  const t: FlowTransition = { id: newId(), to, match: 'all', conditions: [newCondition()] }
  patchStage({ transitions: [...s.transitions, t] })
  emit('select', { kind: 'transition', stageId: s.id, transitionId: t.id })
}

// ── 阶段出口 ──
function patchTransition(p: Partial<FlowTransition>) {
  const s = stage.value
  const id = transition.value?.id
  if (!s || !id) return
  patchStage({ transitions: s.transitions.map((t) => (t.id === id ? { ...t, ...p } : t)) })
}
function removeTransition() {
  const s = stage.value
  const id = transition.value?.id
  if (!s || !id) return
  patchStage({ transitions: s.transitions.filter((t) => t.id !== id) })
  emit('select', { kind: 'stage', stageId: s.id })
}
function moveTransition(d: -1 | 1) {
  const s = stage.value
  const t = transition.value
  if (!s || !t) return
  const i = s.transitions.findIndex((x) => x.id === t.id)
  const j = i + d
  if (j < 0 || j >= s.transitions.length) return
  const next = [...s.transitions]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  patchStage({ transitions: next })
}
const transitionIndex = computed(
  () => stage.value?.transitions.findIndex((t) => t.id === transition.value?.id) ?? -1,
)

// ── 规则 ──
function patchRule(p: Partial<FlowRule>) {
  const id = rule.value?.id
  emit('update:config', {
    ...props.config,
    rules: props.config.rules.map((r) => (r.id === id ? { ...r, ...p } : r)),
  })
}
function removeRule() {
  const id = rule.value?.id
  if (!id) return
  emit('update:config', { ...props.config, rules: props.config.rules.filter((r) => r.id !== id) })
  emit('select', null)
}
function addAction(kind: FlowActionKind) {
  const r = rule.value
  if (!r) return
  const a: FlowAction = { id: newId(), kind, ...(kind === 'guide' ? { turns: 1 } : {}) }
  patchRule({ actions: [...r.actions, a] })
  emit('select', { kind: 'action', ruleId: r.id, actionId: a.id })
}

// ── 动作 ──
function patchAction(p: Partial<FlowAction>) {
  const r = rule.value
  const id = action.value?.id
  if (!r || !id) return
  patchRule({ actions: r.actions.map((a) => (a.id === id ? { ...a, ...p } : a)) })
}
function removeAction() {
  const r = rule.value
  const id = action.value?.id
  if (!r || !id) return
  patchRule({ actions: r.actions.filter((a) => a.id !== id) })
  emit('select', { kind: 'rule', ruleId: r.id })
}
function moveAction(d: -1 | 1) {
  const r = rule.value
  const a = action.value
  if (!r || !a) return
  const i = r.actions.findIndex((x) => x.id === a.id)
  const j = i + d
  if (j < 0 || j >= r.actions.length) return
  const next = [...r.actions]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  patchRule({ actions: next })
}
const actionIndex = computed(
  () => rule.value?.actions.findIndex((a) => a.id === action.value?.id) ?? -1,
)
const targetStageOptions = computed(() =>
  stages.value
    .filter((x) => x.id !== stage.value?.id)
    .map((x) => ({ value: x.id, label: x.name || '未命名阶段' })),
)
const modeOptions = computed(() =>
  (Object.keys(FLOW_MODE_LABEL) as (keyof typeof FLOW_MODE_LABEL)[]).map((k) => ({
    value: k,
    label: FLOW_MODE_LABEL[k],
  })),
)

// ── 条件（规则或出口共用） ──
type CondOwner = { conditions: FlowCondition[] }
function patchConds(owner: CondOwner, next: FlowCondition[], isRule: boolean) {
  if (isRule) patchRule({ conditions: next })
  else patchTransition({ conditions: next })
  void owner
}
function addCond(owner: CondOwner, isRule: boolean) {
  patchConds(owner, [...owner.conditions, newCondition()], isRule)
}
function patchCond(owner: CondOwner, id: string, p: Partial<FlowCondition>, isRule: boolean) {
  patchConds(
    owner,
    owner.conditions.map((c) => (c.id === id ? { ...c, ...p } : c)),
    isRule,
  )
}
function removeCond(owner: CondOwner, id: string, isRule: boolean) {
  patchConds(
    owner,
    owner.conditions.filter((c) => c.id !== id),
    isRule,
  )
}
const nameOf = (id: string) => stages.value.find((s) => s.id === id)?.name || '未命名阶段'
</script>
<template>
  <aside class="fi" aria-label="节点设置">
    <div v-if="!stage && !rule" class="fi-empty">
      <p>点流程图上的节点或连线，在这里编辑。</p>
      <ul>
        <li>阶段：剧情分段，身处该阶段时每轮注入它的引导</li>
        <li>规则：每条 AI 回复后检查条件，成立就依次执行右边的动作</li>
        <li>从阶段右侧圆点拖到另一个阶段 = 新建出口；拖到规则 = 规则只在该阶段生效</li>
        <li>从动作拖到阶段 = 该动作改成「切换到这个阶段」</li>
      </ul>
    </div>

    <!-- 阶段 -->
    <section v-if="stage && !transition" class="fi-sec">
      <header class="fi-head">
        <span class="fi-kind fi-kind--stage">{{ stageIndex === 0 ? '初始阶段' : '阶段' }}</span>
        <button type="button" class="cbx-icon-btn" aria-label="删除阶段" @click="removeStage">
          <AppIcon name="Trash2" tone="danger" />
        </button>
      </header>
      <label class="cbx-field">
        <span class="cbx-field__label">阶段名称</span>
        <input
          class="cbx-input"
          :value="stage.name"
          aria-label="阶段名称"
          @change="patchStage({ name: val($event).trim() })"
        />
      </label>
      <label class="cbx-field">
        <span class="cbx-field__label">阶段引导（身处该阶段时每轮注入）</span>
        <textarea
          class="cbx-textarea"
          rows="3"
          :value="stage.guide ?? ''"
          aria-label="阶段引导"
          placeholder="例如：{{char}}开始主动分享过去，但仍回避谈论家人"
          @change="patchStage({ guide: val($event) })"
        />
      </label>
      <button
        v-if="stageIndex > 0"
        type="button"
        class="cbx-btn cbx-btn--ghost sm"
        @click="makeInitial"
      >
        设为初始阶段
      </button>
      <div class="fi-list">
        <span class="fi-list__tag">出口（按顺序检查，第一条成立的生效）</span>
        <p v-if="!stage.transitions.length" class="fi-note">没有出口：停留在这个阶段</p>
        <button
          v-for="t in stage.transitions"
          :key="t.id"
          type="button"
          class="fi-item"
          @click="emit('select', { kind: 'transition', stageId: stage.id, transitionId: t.id })"
        >
          → {{ nameOf(t.to) }}：{{ transitionText(t, stages) }}
        </button>
        <button v-if="stages.length > 1" type="button" class="fi-add" @click="addTransition">
          <AppIcon name="Plus" /> 添加出口
        </button>
      </div>
    </section>
    <!-- 阶段出口（连线） -->
    <section v-if="stage && transition" class="fi-sec">
      <header class="fi-head">
        <button
          type="button"
          class="cbx-btn cbx-btn--ghost sm"
          @click="emit('select', { kind: 'stage', stageId: stage.id })"
        >
          ← {{ stage.name || '未命名阶段' }}
        </button>
        <span class="fi-kind fi-kind--transition">阶段出口</span>
        <button
          type="button"
          class="cbx-icon-btn"
          aria-label="上移出口"
          :disabled="transitionIndex <= 0"
          @click="moveTransition(-1)"
        >
          <AppIcon name="ArrowUp" />
        </button>
        <button
          type="button"
          class="cbx-icon-btn"
          aria-label="下移出口"
          :disabled="transitionIndex >= stage.transitions.length - 1"
          @click="moveTransition(1)"
        >
          <AppIcon name="ArrowDown" />
        </button>
        <button type="button" class="cbx-icon-btn" aria-label="删除出口" @click="removeTransition">
          <AppIcon name="Trash2" tone="danger" />
        </button>
      </header>
      <label class="cbx-field">
        <span class="cbx-field__label">进入阶段</span>
        <CbxSelect
          :model-value="transition.to"
          :options="targetStageOptions"
          label="目标阶段"
          @change="(v) => patchTransition({ to: v })"
        />
      </label>
      <label class="cbx-field">
        <span class="cbx-field__label">多个条件时</span>
        <CbxSelect
          :model-value="transition.match"
          :options="MATCH_OPTIONS"
          label="出口条件组合"
          @change="(v) => patchTransition({ match: v === 'any' ? 'any' : 'all' })"
        />
      </label>
      <p v-if="!transition.conditions.length" class="fi-note">还没有条件：这条出口不会自动切换</p>
      <FlowConditionForm
        v-for="c in transition.conditions"
        :key="c.id"
        :condition="c"
        :fields="fields"
        :people="people"
        :stages="stages"
        v-bind="isGroup ? { isGroup: true } : {}"
        @patch="(p) => patchCond(transition!, c.id, p, false)"
        @remove="removeCond(transition!, c.id, false)"
      />
      <button type="button" class="fi-add" @click="addCond(transition, false)">
        <AppIcon name="Plus" /> 添加条件
      </button>
    </section>
    <!-- 规则 -->
    <section v-if="rule && !action" class="fi-sec">
      <header class="fi-head">
        <label class="cbx-switch" :title="rule.enabled ? '已启用' : '已停用'">
          <input
            type="checkbox"
            :checked="rule.enabled"
            :aria-label="`启用 ${rule.name}`"
            @change="patchRule({ enabled: ($event.target as HTMLInputElement).checked })"
          />
          <span class="cbx-switch__track" />
        </label>
        <span class="fi-kind fi-kind--rule">规则</span>
        <button type="button" class="cbx-icon-btn" aria-label="删除规则" @click="removeRule">
          <AppIcon name="Trash2" tone="danger" />
        </button>
      </header>
      <label class="cbx-field">
        <span class="cbx-field__label">规则名称</span>
        <input
          class="cbx-input"
          :value="rule.name"
          aria-label="规则名称"
          @change="patchRule({ name: val($event).trim() })"
        />
      </label>
      <div class="fi-grid">
        <label class="cbx-field">
          <span class="cbx-field__label">检查时机</span>
          <CbxSelect
            :model-value="rule.trigger.kind"
            :options="TRIGGER_OPTIONS"
            label="检查时机"
            @change="
              (v) =>
                patchRule({
                  trigger: v === 'everyN' ? { kind: 'everyN', n: 3 } : { kind: 'afterReply' },
                })
            "
          />
        </label>
        <label v-if="rule.trigger.kind === 'everyN'" class="cbx-field">
          <span class="cbx-field__label">N</span>
          <input
            class="cbx-input"
            type="number"
            min="1"
            inputmode="numeric"
            :value="rule.trigger.n ?? 1"
            aria-label="间隔条数"
            @change="patchRule({ trigger: { kind: 'everyN', n: Math.max(1, num($event) ?? 1) } })"
          />
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">触发方式</span>
          <CbxSelect
            :model-value="rule.mode"
            :options="modeOptions"
            label="触发方式"
            @change="(v) => patchRule({ mode: v as FlowRule['mode'] })"
          />
        </label>
        <label v-if="rule.mode === 'always'" class="cbx-field">
          <span class="cbx-field__label">冷却（条 AI 回复）</span>
          <input
            class="cbx-input"
            type="number"
            min="0"
            inputmode="numeric"
            :value="rule.cooldown ?? 0"
            aria-label="冷却轮数"
            @change="patchRule({ cooldown: Math.max(0, num($event) ?? 0) })"
          />
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">多个条件时</span>
          <CbxSelect
            :model-value="rule.match"
            :options="MATCH_OPTIONS"
            label="条件组合"
            @change="(v) => patchRule({ match: v === 'any' ? 'any' : 'all' })"
          />
        </label>
      </div>
      <div class="fi-list">
        <span class="fi-list__tag">条件</span>
        <p v-if="!rule.conditions.length" class="fi-note">无条件：检查时直接成立</p>
        <FlowConditionForm
          v-for="c in rule.conditions"
          :key="c.id"
          :condition="c"
          :fields="fields"
          :people="people"
          :stages="stages"
          v-bind="isGroup ? { isGroup: true } : {}"
          @patch="(p) => patchCond(rule!, c.id, p, true)"
          @remove="removeCond(rule!, c.id, true)"
        />
        <button type="button" class="fi-add" @click="addCond(rule, true)">
          <AppIcon name="Plus" /> 添加条件
        </button>
      </div>
      <div class="fi-list">
        <span class="fi-list__tag">动作（依次执行）</span>
        <p v-if="!rule.actions.length" class="fi-note">还没有动作</p>
        <button
          v-for="a in rule.actions"
          :key="a.id"
          type="button"
          class="fi-item"
          @click="emit('select', { kind: 'action', ruleId: rule.id, actionId: a.id })"
        >
          {{ FLOW_ACTION_LABEL[a.kind] }}
        </button>
        <div class="fi-adds">
          <button
            v-for="k in actionKinds"
            :key="k"
            type="button"
            class="fi-add"
            @click="addAction(k)"
          >
            <AppIcon name="Plus" /> {{ FLOW_ACTION_LABEL[k] }}
          </button>
        </div>
      </div>
      <p v-if="rule.conditions.length" class="fi-note">
        条件：{{
          rule.conditions
            .map((c) => condText(c, stages))
            .join(rule.match === 'any' ? ' 或 ' : ' 且 ')
        }}
      </p>
    </section>
    <!-- 动作 -->
    <section v-if="rule && action" class="fi-sec">
      <header class="fi-head">
        <button
          type="button"
          class="cbx-btn cbx-btn--ghost sm"
          @click="emit('select', { kind: 'rule', ruleId: rule.id })"
        >
          ← {{ rule.name || '规则' }}
        </button>
        <span class="fi-kind fi-kind--action">动作 {{ actionIndex + 1 }}</span>
        <button
          type="button"
          class="cbx-icon-btn"
          aria-label="上移动作"
          :disabled="actionIndex <= 0"
          @click="moveAction(-1)"
        >
          <AppIcon name="ArrowUp" />
        </button>
        <button
          type="button"
          class="cbx-icon-btn"
          aria-label="下移动作"
          :disabled="actionIndex >= rule.actions.length - 1"
          @click="moveAction(1)"
        >
          <AppIcon name="ArrowDown" />
        </button>
      </header>
      <FlowActionForm
        :action="action"
        :fields="fields"
        :people="people"
        :stages="stages"
        v-bind="isGroup ? { isGroup: true } : {}"
        @patch="patchAction"
        @remove="removeAction"
      />
    </section>
  </aside>
</template>
<style scoped>
.fi {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
  min-width: 0;
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg);
}
.fi-empty p,
.fi-empty ul {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  line-height: 1.7;
  color: var(--cbx-text-secondary);
}
.fi-empty ul {
  padding-left: 1.2em;
  margin-top: var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.fi-sec {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.fi-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.fi-kind {
  flex: 1;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--fi-color);
}
.fi-kind--stage,
.fi-kind--transition {
  --fi-color: var(--cbx-brand);
}
.fi-kind--rule {
  --fi-color: var(--cbx-success, #16a34a);
}
.fi-kind--action {
  --fi-color: var(--cbx-warning-hover, #d97706);
}
.fi-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--cbx-space-2);
}
.fi-list {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  padding-top: var(--cbx-space-2);
  border-top: 1px solid var(--cbx-border);
}
.fi-list__tag {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
}
.fi-note {
  margin: 0;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  overflow-wrap: anywhere;
}
.fi-item {
  width: 100%;
  min-height: 36px;
  padding: 6px 10px;
  text-align: left;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text);
  background: var(--cbx-bg-secondary);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  cursor: pointer;
  overflow-wrap: anywhere;
}
.fi-item:hover,
.fi-item:focus-visible {
  border-color: var(--cbx-brand);
}
.fi-adds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.fi-add {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  padding: 0 10px;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-brand);
  background: transparent;
  border: 1px dashed var(--cbx-brand);
  border-radius: var(--cbx-radius-md);
  cursor: pointer;
}
.sm {
  height: 30px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
@media (max-width: 767px) {
  .fi-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .fi-add,
  .sm {
    min-height: var(--cbx-tap-min, 40px);
  }
}
</style>
