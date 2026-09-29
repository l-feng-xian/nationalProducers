<script setup lang="ts">
/**
 * 角色卡 / 群聊的「状态」页签：专属字段模板 + 初始状态。两处共用。
 * 整份配置通过 update:config 交回调用方，由调用方挂到 extensions.np.status / group.status 上并落盘。
 */
import { computed } from 'vue'
import StatusFieldsEditor from './StatusFieldsEditor.vue'
import StatusEditor from '@/components/chat/StatusEditor.vue'
import { useSettingsStore } from '@/stores/settings'
import {
  configInitialStatus,
  resolveStatusFields,
  sanitizeFields,
} from '@/services/status/template'
import { toPlain } from '@/utils/plain'
import type { CharacterStatusConfig, StatusData, StatusField } from '@/types/status'

const props = defineProps<{
  config: CharacterStatusConfig | undefined
  /** 初始状态里必须出现、名字锁定的人：角色（们）+ 用户 */
  people: string[]
  userName: string
  /** 「使用专属字段」开关的文案 */
  ownLabel: string
}>()
const emit = defineEmits<{ 'update:config': [config: CharacterStatusConfig | undefined] }>()

const settings = useSettingsStore()

const ownFields = computed(() => sanitizeFields(props.config?.fields))
/** 初始状态编辑器用的字段：专属的（有的话）或全局的，只含启用的 */
const effectiveFields = computed(() => resolveStatusFields(settings.settings.status, props.config))
const initial = computed(() => configInitialStatus(props.config))

/**
 * 字段或人员变了就重建初始状态表单（它只在挂载时读一次数据）。
 * 输入初始状态本身不会改这个 key，所以打字时不会被重置。
 */
const editorKey = computed(
  () =>
    `${props.people.join('\u0000')}|${props.userName}|` +
    effectiveFields.value.map((f) => `${f.key}:${f.scope}:${f.kind}`).join(','),
)

function commit(patch: Partial<CharacterStatusConfig>) {
  const next: CharacterStatusConfig = { ...props.config, ...patch }
  if (!next.fields?.length) delete next.fields
  if (!next.initial) delete next.initial
  emit('update:config', next.fields || next.initial ? next : undefined)
}

function toggleOwn(e: Event) {
  const on = (e.target as HTMLInputElement).checked
  // 打开时以全局模板为起点，改起来比从零开始方便
  commit({ fields: on ? toPlain(settings.settings.status.fields) : undefined })
}
function setFields(fields: StatusField[]) {
  commit({ fields })
}
function setInitial(data: StatusData) {
  const empty =
    !Object.keys(data.scene).length && data.people.every((p) => !Object.keys(p.fields).length)
  commit({ initial: empty ? undefined : data })
}
</script>

<template>
  <div class="sce">
    <section class="sce-sec">
      <h4>状态字段</h4>
      <label class="cbx-switch sce-switch">
        <input type="checkbox" :checked="ownFields.length > 0" @change="toggleOwn" />
        <span class="cbx-switch__track" />
        <span>{{ ownLabel }}</span>
      </label>
      <p v-if="!ownFields.length" class="sce-note">
        当前使用「设置 → 角色状态」里的全局字段：{{
          effectiveFields.map((f) => f.key).join('、') || '（无启用字段）'
        }}
      </p>
      <StatusFieldsEditor v-else :model-value="ownFields" @update:model-value="setFields" />
    </section>

    <section class="sce-sec">
      <h4>初始状态</h4>
      <p class="sce-note"><slot name="initial-hint" /></p>
      <StatusEditor
        :key="editorKey"
        live
        :data="initial"
        :fields="effectiveFields"
        :user-name="userName"
        :locked-people="people"
        @update="setInitial"
      />
    </section>
  </div>
</template>

<style scoped>
.sce {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-6);
}
.sce-sec h4 {
  margin-bottom: var(--cbx-space-2);
  font-size: var(--cbx-fs-md);
  font-weight: var(--cbx-fw-medium);
}
.sce-switch {
  gap: var(--cbx-space-2);
  font-size: var(--cbx-fs-sm);
  min-height: var(--cbx-tap-min);
  margin-bottom: var(--cbx-space-2);
}
.sce-note {
  max-width: var(--cbx-read-w);
  margin-bottom: var(--cbx-space-3);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.7;
}
</style>
