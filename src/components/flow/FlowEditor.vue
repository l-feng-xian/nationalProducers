<script setup lang="ts">
/**
 * 流程控制编辑器：节点流程图（FlowGraph）+ AI 生成流程。
 * 阶段、规则、动作都是图上的节点，连线带流动动画；点节点在检查面板里编辑。
 * 受控组件：每次改动整体 emit 一份新配置，调用方负责落盘。
 */
import { computed, ref } from 'vue'
import FlowGraph from './FlowGraph.vue'
import FlowAiDialog from './FlowAiDialog.vue'
import { Sparkles } from '@/components/icons'
import { sanitizeFlow } from '@/services/flow/engine'
import type { FlowConfig } from '@/types/flow'
import type { StatusField } from '@/types/status'

const props = defineProps<{
  config: FlowConfig | undefined
  /** 当前生效的状态字段（给条件 / 动作的字段下拉用） */
  fields: StatusField[]
  /** 可选的人名（不含宏）；{{char}} / {{user}} 总会提供 */
  people: string[]
  isGroup?: boolean
  /** AI 生成流程时给模型的角色摘要（角色卡页传入） */
  brief?: string
}>()
const emit = defineEmits<{ 'update:config': [cfg: FlowConfig | undefined] }>()

const cfg = computed(() => sanitizeFlow(props.config))
const aiOpen = ref(false)
const hasExisting = computed(
  () => cfg.value.rules.length > 0 || (cfg.value.stages?.length ?? 0) > 0,
)

/**
 * 替换：整体换掉（旧坐标作废，按新配置自动排版）；
 * 追加：规则与阶段接在后面，已摆好的节点位置保留，新节点自动排。
 */
function applyAi(next: FlowConfig, mode: 'replace' | 'append') {
  const cur = cfg.value
  const merged: FlowConfig =
    mode === 'replace' || !hasExisting.value
      ? { rules: next.rules, ...(next.stages?.length ? { stages: next.stages } : {}) }
      : {
          rules: [...cur.rules, ...next.rules],
          stages: [...(cur.stages ?? []), ...(next.stages ?? [])],
          ...(cur.layout ? { layout: cur.layout } : {}),
        }
  const hasStages = (merged.stages?.length ?? 0) > 0
  if (!hasStages) delete merged.stages
  emit('update:config', merged.rules.length || hasStages ? merged : undefined)
  aiOpen.value = false
}
</script>

<template>
  <div class="flow">
    <div class="flow-bar">
      <button type="button" class="cbx-btn cbx-btn--soft" @click="aiOpen = true">
        <Sparkles :size="16" aria-hidden="true" /> AI 生成流程
      </button>
    </div>
    <FlowAiDialog
      v-if="aiOpen"
      :fields="fields"
      :people="people"
      :has-existing="hasExisting"
      v-bind="{ ...(brief ? { brief } : {}), ...(isGroup ? { isGroup: true } : {}) }"
      @close="aiOpen = false"
      @apply="applyAi"
    />
    <FlowGraph
      :config="config"
      :fields="fields"
      :people="people"
      v-bind="isGroup ? { isGroup: true } : {}"
      @update:config="emit('update:config', $event)"
    />
  </div>
</template>

<style scoped>
.flow {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}
.flow-bar {
  display: flex;
  justify-content: flex-end;
}
</style>
