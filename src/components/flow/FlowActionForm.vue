<script setup lang="ts">
/**
 * 单个动作的表单（节点流程图的检查面板用）。受控：改动 emit patch，由父级落盘。
 */
import { computed } from 'vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import { actionKindPatch } from '@/services/flow/edit'
import { useWorldsStore } from '@/stores/worlds'
import {
  FLOW_ACTION_LABEL,
  GROUP_ONLY_ACTIONS,
  type FlowAction,
  type FlowActionKind,
  type FlowStage,
} from '@/types/flow'
import type { StatusField } from '@/types/status'

const props = defineProps<{
  action: FlowAction
  fields: StatusField[]
  people: string[]
  stages: FlowStage[]
  isGroup?: boolean
}>()
const emit = defineEmits<{ patch: [p: Partial<FlowAction>]; remove: [] }>()

const a = computed(() => props.action)
const worlds = useWorldsStore()
if (!worlds.loaded) void worlds.load()

const val = (e: Event) =>
  (e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value
const num = (e: Event) => {
  const n = Number(val(e))
  return Number.isFinite(n) ? n : undefined
}
const whoOptions = computed<{ value: string; label: string }[]>(() => [
  {
    value: '{{char}}',
    label: props.isGroup ? '{{char}}（本轮发言者 / 卡主本人）' : '{{char}}（角色）',
  },
  { value: '{{user}}', label: '{{user}}（用户）' },
  ...props.people.map((n) => ({ value: n, label: n })),
])
const memberOptions = computed(() => whoOptions.value.filter((x) => x.value !== '{{user}}'))
const actionKinds = Object.keys(FLOW_ACTION_LABEL) as FlowActionKind[]
const kindOptions = computed(() => actionKinds.map((k) => ({ value: k, label: actionLabel(k) })))
/** 状态 / 变量的修改方式 */
const statusModeOptions = [
  { value: 'set', label: '设为' },
  { value: 'add', label: '数值增加（负数为减少）' },
  { value: 'push', label: '列表加入' },
  { value: 'pull', label: '列表移除' },
]
const varModeOptions = [
  { value: 'set', label: '设为' },
  { value: 'add', label: '数值增加（负数为减少）' },
]
const tagOptions = computed(() => [{ value: 'scene', label: '场景' }, ...whoOptions.value])
const bookOptions = computed(() => worlds.items.map((b) => ({ value: b.id, label: b.name })))
const entryOptions = computed(() =>
  loreEntries.value.map((e) => ({ value: String(e.uid), label: e.label })),
)
const stageOptions = computed(() =>
  props.stages.map((st) => ({ value: st.id, label: st.name || '未命名阶段' })),
)
function actionLabel(k: FlowActionKind): string {
  const tags = [
    k === 'guide' ? '推荐' : '',
    !props.isGroup && GROUP_ONLY_ACTIONS.includes(k) ? '仅演绎' : '',
  ].filter(Boolean)
  return tags.length ? `${FLOW_ACTION_LABEL[k]}（${tags.join('，')}）` : FLOW_ACTION_LABEL[k]
}
const HINT: Record<FlowActionKind, string> = {
  guide: '把这段发展交给模型，下一轮起自然写进回复。',
  say: '不调用模型，原样插入一条消息。适合关键台词、结局文本。',
  setStatus: '直接改本轮的状态快照，侧栏会立刻显示。',
  setVar: '写入会话变量，可在提示词里用宏读取。',
  setStage: '直接跳到某个剧情阶段，不必等阶段连线的条件成立。',
  activateLore: '强制激活一条世界书条目 N 轮，不需要关键词。',
  nextSpeaker: '演绎里下一轮由此人发言，只生效一次。',
  mute: '只影响本会话，不改演绎设置。',
  unmute: '只影响本会话，不改演绎设置。',
  image: '回复生成完后打开配图面板，参考图与提示词由你确认后才生成，不会自动消耗额度。',
}
const loreEntries = computed(() => {
  const book = worlds.byId(a.value.book)
  return book
    ? Object.values(book.entries)
        .map((e) => ({ uid: e.uid, label: e.comment || e.key[0] || `#${e.uid}` }))
        .sort((x, y) => x.label.localeCompare(y.label))
    : []
})
const keyScope = computed(() => (!a.value.who || a.value.who === 'scene' ? 'scene' : 'person'))
const keyList = computed(() =>
  keyScope.value === 'scene'
    ? props.fields.filter((f) => f.scope === 'scene')
    : props.fields.filter((f) => f.scope !== 'scene'),
)
const isNumberKey = computed(() =>
  props.fields.some((f) => f.key === a.value.key && f.kind === 'number'),
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
    <label class="cbx-field full">
      <span class="cbx-field__label">动作</span>
      <CbxSelect
        :model-value="a.kind"
        :options="kindOptions"
        label="动作类型"
        @change="(v) => emit('patch', actionKindPatch(a, v as FlowActionKind))"
      />
      <span class="cbx-field__hint">{{ HINT[a.kind] }}</span>
    </label>

    <label v-if="a.kind === 'say'" class="cbx-field">
      <span class="cbx-field__label">谁来说</span>
      <CbxSelect
        :model-value="a.speaker || '{{char}}'"
        :options="memberOptions"
        label="说话人"
        @change="(v) => emit('patch', { speaker: v })"
      />
    </label>
    <label v-if="a.kind === 'guide' || a.kind === 'say'" class="cbx-field full">
      <span class="cbx-field__label">{{ a.kind === 'guide' ? '剧情引导' : '台词' }}</span>
      <textarea
        class="cbx-textarea"
        rows="3"
        :value="a.text ?? ''"
        :aria-label="a.kind === 'guide' ? '剧情引导' : '台词'"
        :placeholder="
          a.kind === 'guide'
            ? '例如：{{char}}开始主动提起过去，但仍回避谈论家人'
            : '例如：*她低下头* 谢谢你一直陪着我。'
        "
        @change="emit('patch', { text: val($event) })"
      />
    </label>
    <label v-if="a.kind === 'guide' || a.kind === 'activateLore'" class="cbx-field">
      <span class="cbx-field__label">持续轮数</span>
      <input
        class="cbx-input"
        type="number"
        min="1"
        inputmode="numeric"
        :value="a.turns ?? 1"
        aria-label="持续轮数"
        @change="emit('patch', { turns: Math.max(1, num($event) ?? 1) })"
      />
    </label>

    <template v-if="a.kind === 'setStatus'">
      <label class="cbx-field">
        <span class="cbx-field__label">改谁的状态</span>
        <CbxSelect
          :model-value="a.who || 'scene'"
          :options="tagOptions"
          label="改谁的状态"
          @change="(v) => emit('patch', { who: v, key: undefined, value: undefined })"
        />
      </label>
      <label class="cbx-field">
        <span class="cbx-field__label">方式</span>
        <CbxSelect
          :model-value="a.mode ?? 'set'"
          :options="statusModeOptions"
          label="修改方式"
          @change="(v) => emit('patch', { mode: v as FlowAction['mode'] })"
        />
      </label>
    </template>
    <label v-if="a.kind === 'setVar'" class="cbx-field">
      <span class="cbx-field__label">方式</span>
      <CbxSelect
        :model-value="a.mode === 'add' ? 'add' : 'set'"
        :options="varModeOptions"
        label="变量修改方式"
        @change="(v) => emit('patch', { mode: v === 'add' ? 'add' : 'set' })"
      />
    </label>
    <label v-if="a.kind === 'setStatus' || a.kind === 'setVar'" class="cbx-field">
      <span class="cbx-field__label">{{ a.kind === 'setVar' ? '变量名' : '字段' }}</span>
      <CbxSelect
        v-if="a.kind === 'setVar'"
        :model-value="a.key ?? ''"
        :options="[]"
        label="变量名"
        placeholder="变量名"
        free
        @change="(v) => emit('patch', { key: v })"
      />
      <CbxSelect
        v-else
        :model-value="a.key ?? ''"
        :options="keyOptions"
        label="状态字段"
        placeholder="选一个字段，或直接输入"
        free
        @change="(v) => emit('patch', { key: v })"
      />
    </label>
    <label v-if="a.kind === 'setStatus' || a.kind === 'setVar'" class="cbx-field">
      <span class="cbx-field__label">值</span>
      <input
        class="cbx-input"
        :value="a.value ?? ''"
        :inputmode="a.mode === 'add' || isNumberKey ? 'decimal' : undefined"
        :placeholder="a.mode === 'add' ? '例如：10 或 -5' : ''"
        aria-label="值"
        @change="emit('patch', { value: val($event).trim() })"
      />
    </label>

    <template v-if="a.kind === 'activateLore'">
      <label class="cbx-field">
        <span class="cbx-field__label">世界书</span>
        <CbxSelect
          :model-value="a.book ?? ''"
          :options="bookOptions"
          label="世界书"
          :placeholder="worlds.items.length ? '请选择世界书' : '还没有世界书'"
          @change="(v) => emit('patch', { book: v, uid: undefined })"
        />
      </label>
      <label class="cbx-field">
        <span class="cbx-field__label">条目</span>
        <CbxSelect
          :model-value="a.uid == null ? '' : String(a.uid)"
          :options="entryOptions"
          label="世界书条目"
          placeholder="请选择条目"
          :disabled="!a.book"
          @change="(v) => emit('patch', { uid: Number(v) })"
        />
      </label>
      <p class="note full">这本世界书需要已关联到角色、演绎、会话或全局启用，否则激活不会生效。</p>
    </template>

    <label
      v-if="a.kind === 'nextSpeaker' || a.kind === 'mute' || a.kind === 'unmute'"
      class="cbx-field"
    >
      <span class="cbx-field__label">成员</span>
      <CbxSelect
        :model-value="a.who || '{{char}}'"
        :options="memberOptions"
        label="成员"
        @change="(v) => emit('patch', { who: v })"
      />
    </label>
    <label v-if="a.kind === 'setStage'" class="cbx-field">
      <span class="cbx-field__label">切换到</span>
      <CbxSelect
        :model-value="a.stage ?? ''"
        :options="stageOptions"
        label="目标阶段"
        :placeholder="stages.length ? '请选择阶段' : '先添加阶段节点'"
        @change="(v) => emit('patch', { stage: v })"
      />
    </label>

    <button type="button" class="cbx-btn cbx-btn--ghost del" @click="emit('remove')">
      删除此动作
    </button>
  </div>
</template>

<style scoped>
.form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--cbx-space-2);
}
.full {
  grid-column: 1 / -1;
}
.note {
  margin: 0;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
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
