<script setup lang="ts">
/**
 * 状态字段模板编辑：设置页（全局模板）与角色编辑页（角色覆盖）共用。
 * 每次改动都整体 emit 一份新数组，调用方负责落盘。
 */
import { computed } from 'vue'
import { ArrowDown, ArrowUp, Plus, Trash2 } from '@/components/icons'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import {
  STATUS_SCOPE_LABEL,
  type StatusField,
  type StatusFieldKind,
  type StatusScope,
} from '@/types/status'

const props = defineProps<{ modelValue: StatusField[] }>()
const emit = defineEmits<{ 'update:modelValue': [fields: StatusField[]] }>()

const KIND_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'list', label: '列表' },
  { value: 'number', label: '数值' },
]
const scopeOptions = computed(() =>
  (Object.keys(STATUS_SCOPE_LABEL) as StatusScope[]).map((k) => ({
    value: k,
    label: STATUS_SCOPE_LABEL[k],
  })),
)

function commit(next: StatusField[]) {
  emit('update:modelValue', next)
}
function patch(i: number, p: Partial<StatusField>) {
  commit(props.modelValue.map((f, j) => (j === i ? { ...f, ...p } : f)))
}
function move(i: number, d: -1 | 1) {
  const j = i + d
  if (j < 0 || j >= props.modelValue.length) return
  const next = [...props.modelValue]
  ;[next[i], next[j]] = [next[j]!, next[i]!]
  commit(next)
}
function remove(i: number) {
  commit(props.modelValue.filter((_, j) => j !== i))
}
function add() {
  let n = props.modelValue.length + 1
  while (props.modelValue.some((f) => f.key === `字段${n}`)) n++
  commit([...props.modelValue, { key: `字段${n}`, scope: 'person', kind: 'text', enabled: true }])
}

function onKey(i: number, e: Event) {
  const v = (e.target as HTMLInputElement).value.trim()
  // 键名同时是 JSON 键，空了或与别的字段重名都会让快照对不上 —— 直接退回原值
  if (!v || props.modelValue.some((f, j) => j !== i && f.key === v)) {
    ;(e.target as HTMLInputElement).value = props.modelValue[i]!.key
    return
  }
  patch(i, { key: v })
}
function onHint(i: number, e: Event) {
  const v = (e.target as HTMLInputElement).value.trim()
  patch(i, v ? { hint: v } : { hint: '' })
}
function setScope(i: number, v: string) {
  patch(i, { scope: v in STATUS_SCOPE_LABEL ? (v as StatusScope) : 'person' })
}
function setKind(i: number, v: string) {
  const kind: StatusFieldKind = v === 'list' || v === 'number' ? v : 'text'
  // 换成非数值类型时丢掉上下限，免得残留字段混进导出
  if (kind === 'number') patch(i, { kind })
  else {
    const { min: _min, max: _max, ...rest } = props.modelValue[i]!
    commit(props.modelValue.map((f, j) => (j === i ? { ...rest, kind } : f)))
  }
}
/** 上下限：留空 = 不限 */
function onBound(i: number, which: 'min' | 'max', e: Event) {
  const raw = (e.target as HTMLInputElement).value.trim()
  const n = raw === '' ? undefined : Number(raw)
  const { [which]: _old, ...rest } = props.modelValue[i]!
  const next: StatusField = n !== undefined && Number.isFinite(n) ? { ...rest, [which]: n } : rest
  commit(props.modelValue.map((f, j) => (j === i ? next : f)))
}
function onEnabled(i: number, e: Event) {
  patch(i, { enabled: (e.target as HTMLInputElement).checked })
}
</script>

<template>
  <div class="sfe">
    <div
      v-for="(f, i) in modelValue"
      :key="i"
      class="sfe-row"
      :class="{ 'sfe-row--off': !f.enabled }"
    >
      <label class="cbx-switch sfe-on" :title="f.enabled ? '已启用' : '已停用'">
        <input
          type="checkbox"
          :checked="f.enabled"
          :aria-label="`启用 ${f.key}`"
          @change="onEnabled(i, $event)"
        />
        <span class="cbx-switch__track" />
      </label>
      <input
        class="cbx-input sfe-key"
        :value="f.key"
        aria-label="字段名"
        @change="onKey(i, $event)"
      />
      <CbxSelect
        class="sfe-sel"
        :model-value="f.scope"
        :options="scopeOptions"
        label="范围"
        compact
        @change="(v) => setScope(i, v)"
      />
      <CbxSelect
        class="sfe-sel"
        :model-value="f.kind"
        :options="KIND_OPTIONS"
        label="类型"
        compact
        @change="(v) => setKind(i, v)"
      />
      <div v-if="f.kind === 'number'" class="sfe-range">
        <span class="sfe-range__label">取值范围</span>
        <input
          class="cbx-input sfe-num"
          type="number"
          :value="f.min ?? ''"
          placeholder="最小"
          aria-label="最小值"
          @change="onBound(i, 'min', $event)"
        />
        <input
          class="cbx-input sfe-num"
          type="number"
          :value="f.max ?? ''"
          placeholder="最大"
          aria-label="最大值"
          @change="onBound(i, 'max', $event)"
        />
        <span class="sfe-range__label">留空 = 不限</span>
      </div>
      <input
        class="cbx-input sfe-hint"
        :value="f.hint ?? ''"
        placeholder="给模型的填写提示（可选）"
        aria-label="填写提示"
        @change="onHint(i, $event)"
      />
      <div class="sfe-ops">
        <button
          type="button"
          class="cbx-btn cbx-btn--ghost sfe-icon"
          aria-label="上移"
          :disabled="i === 0"
          @click="move(i, -1)"
        >
          <ArrowUp :size="16" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="cbx-btn cbx-btn--ghost sfe-icon"
          aria-label="下移"
          :disabled="i === modelValue.length - 1"
          @click="move(i, 1)"
        >
          <ArrowDown :size="16" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="cbx-btn cbx-btn--ghost sfe-icon"
          :aria-label="`删除 ${f.key}`"
          @click="remove(i)"
        >
          <Trash2 :size="16" aria-hidden="true" />
        </button>
      </div>
    </div>
    <button type="button" class="cbx-btn cbx-btn--soft sfe-add" @click="add">
      <Plus :size="16" aria-hidden="true" />添加字段
    </button>
  </div>
</template>

<style scoped>
.sfe {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.sfe-row {
  display: grid;
  grid-template-columns: auto minmax(6em, 10em) 7.5em 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--cbx-space-2);
}
.sfe-row--off .sfe-key,
.sfe-row--off .sfe-hint {
  color: var(--cbx-text-tertiary);
}
.sfe-row .cbx-input {
  width: 100%;
  min-width: 0;
}
.sfe-ops {
  display: flex;
}
.sfe-icon {
  width: 36px;
  padding: 0;
}
.sfe-range {
  grid-column: 2 / -1;
  grid-row: 2;
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
}
.sfe-range .sfe-num {
  width: 6.5em;
}
.sfe-range__label {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.sfe-add {
  align-self: flex-start;
  gap: var(--cbx-space-1);
}
@media (max-width: 767px) {
  /* 手机：一个字段一张小卡，开关 + 名字一行，下拉一行，提示一行 */
  .sfe-row {
    grid-template-columns: auto minmax(0, 1fr) minmax(0, 1fr);
    padding: var(--cbx-space-2);
    border: 1px solid var(--cbx-border);
    border-radius: var(--cbx-radius-md);
  }
  .sfe-key {
    grid-column: 2 / -1;
  }
  .sfe-sel:first-of-type {
    grid-column: 1 / 3;
  }
  .sfe-hint,
  .sfe-ops,
  .sfe-range {
    grid-column: 1 / -1;
    grid-row: auto;
  }
  .sfe-ops {
    justify-content: flex-end;
  }
  .sfe-icon {
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
  .sfe-on {
    min-height: var(--cbx-tap-min);
  }
}
</style>
