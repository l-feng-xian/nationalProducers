<script setup lang="ts">
/**
 * 单个条件的表单（阶段连线用）。受控：改动 emit patch，由父级落盘。
 */
import { computed } from 'vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import { conditionOpPatch, conditionSourcePatch } from '@/services/flow/edit'
import { FLOW_OP_LABEL, FLOW_SOURCE_LABEL, type FlowCondition, type FlowStage } from '@/types/flow'
import type { StatusField } from '@/types/status'

const props = defineProps<{
  condition: FlowCondition
  fields: StatusField[]
  people: string[]
  stages: FlowStage[]
  isGroup?: boolean
}>()
const emit = defineEmits<{ patch: [p: Partial<FlowCondition>]; remove: [] }>()

const c = computed(() => props.condition)
const val = (e: Event) => (e.target as HTMLInputElement | HTMLSelectElement).value
const whoOptions = computed<{ value: string; label: string }[]>(() => [
  {
    value: '{{char}}',
    label: props.isGroup ? '{{char}}（本轮发言者 / 卡主本人）' : '{{char}}（角色）',
  },
  { value: '{{user}}', label: '{{user}}（用户）' },
  ...props.people.map((n) => ({ value: n, label: n })),
])
const sourceOptions = computed(() =>
  (Object.keys(FLOW_SOURCE_LABEL) as (keyof typeof FLOW_SOURCE_LABEL)[]).map((k) => ({
    value: k,
    label: FLOW_SOURCE_LABEL[k],
  })),
)
const opOptions = computed(() =>
  (Object.keys(FLOW_OP_LABEL) as (keyof typeof FLOW_OP_LABEL)[]).map((k) => ({
    value: k,
    label: FLOW_OP_LABEL[k],
  })),
)
const stageOptions = computed(() =>
  props.stages.map((st) => ({ value: st.id, label: st.name || '未命名阶段' })),
)
const keyList = computed(() =>
  c.value.source === 'scene'
    ? props.fields.filter((f) => f.scope === 'scene')
    : props.fields.filter((f) => f.scope !== 'scene'),
)
const isNumber = computed(() =>
  props.fields.some((f) => f.key === c.value.key && f.kind === 'number'),
)
/** 字段候选：可自由输入，所以列表只作提示 */
const keyOptions = computed(() =>
  keyList.value.map((f) => ({
    value: f.key,
    label: f.key,
    hint: f.kind === 'number' ? '数值' : f.kind === 'list' ? '列表' : '文本',
  })),
)
</script>

<template>
  <div class="form">
    <label class="cbx-field">
      <span class="cbx-field__label">取值来源</span>
      <CbxSelect
        :model-value="c.source"
        :options="sourceOptions"
        label="取值来源"
        @change="(v) => emit('patch', conditionSourcePatch(c, v as FlowCondition['source']))"
      />
    </label>
    <label v-if="c.source === 'person'" class="cbx-field">
      <span class="cbx-field__label">谁</span>
      <CbxSelect
        :model-value="c.who ?? '{{char}}'"
        :options="whoOptions"
        label="人物"
        @change="(v) => emit('patch', { who: v })"
      />
    </label>
    <label
      v-if="c.source === 'person' || c.source === 'scene' || c.source === 'var'"
      class="cbx-field"
    >
      <span class="cbx-field__label">{{ c.source === 'var' ? '变量名' : '字段' }}</span>
      <CbxSelect
        v-if="c.source === 'var'"
        :model-value="c.key ?? ''"
        :options="[]"
        label="变量名"
        placeholder="变量名"
        free
        @change="(v) => emit('patch', { key: v })"
      />
      <CbxSelect
        v-else
        :model-value="c.key ?? ''"
        :options="keyOptions"
        label="字段"
        placeholder="选一个字段，或直接输入"
        free
        @change="(v) => emit('patch', { key: v })"
      />
    </label>
    <label class="cbx-field">
      <span class="cbx-field__label">比较</span>
      <CbxSelect
        :model-value="c.op"
        :options="opOptions"
        label="比较方式"
        @change="(v) => emit('patch', conditionOpPatch(c, v as FlowCondition['op']))"
      />
    </label>
    <label v-if="c.source === 'stage'" class="cbx-field">
      <span class="cbx-field__label">阶段</span>
      <CbxSelect
        :model-value="c.value"
        :options="stageOptions"
        label="比较阶段"
        placeholder="请选择阶段"
        @change="(v) => emit('patch', { value: v })"
      />
    </label>
    <label v-else class="cbx-field">
      <span class="cbx-field__label">值</span>
      <input
        class="cbx-input"
        :value="c.value"
        :inputmode="isNumber || c.source === 'turn' ? 'decimal' : undefined"
        aria-label="比较值"
        @change="emit('patch', { value: val($event).trim() })"
      />
    </label>
    <button type="button" class="cbx-btn cbx-btn--ghost del" @click="emit('remove')">
      删除此条件
    </button>
  </div>
</template>

<style scoped>
.form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3);
  background: var(--cbx-bg-hover);
  border-radius: var(--cbx-radius-md);
}
.del {
  grid-column: 1 / -1;
  justify-self: end;
  color: var(--cbx-error);
}
@media (max-width: 767px) {
  .form {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
