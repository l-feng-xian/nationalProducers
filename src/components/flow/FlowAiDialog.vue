<script setup lang="ts">
/**
 * AI 生成流程草稿：描述剧情线 → 预览阶段与规则 → 替换或追加到当前配置。
 * 不直接落盘：通过 apply 交回 FlowEditor，由它走同一个 update:config。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { LoaderCircle, Sparkles } from '@/components/icons'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'
import { useBackClose } from '@/composables/useBackClose'
import { useSettingsStore } from '@/stores/settings'
import { generateFlow, type GeneratedFlow } from '@/services/flow/generate'
import { FLOW_ACTION_LABEL, type FlowConfig } from '@/types/flow'
import type { StatusField } from '@/types/status'
import { toPlain } from '@/utils/plain'

const props = defineProps<{
  fields: StatusField[]
  brief?: string
  people?: string[]
  isGroup?: boolean
  /** 当前已有规则或阶段：才给「追加」选项 */
  hasExisting: boolean
}>()
const emit = defineEmits<{ close: []; apply: [cfg: FlowConfig, mode: 'replace' | 'append'] }>()
const settings = useSettingsStore()

const dialog = ref<HTMLDialogElement | null>(null)
const description = ref('')
const target = ref<'replace' | 'append'>(props.hasExisting ? 'append' : 'replace')
const busy = ref(false)
const error = ref('')
const result = ref<GeneratedFlow | null>(null)
let controller: AbortController | null = null

const canGenerate = computed(
  () => settings.isConfigured && !busy.value && !!description.value.trim(),
)
const stageName = (id: string | undefined) =>
  result.value?.config.stages?.find((s) => s.id === id)?.name ?? '?'

onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => {
  controller?.abort()
  dialog.value?.close()
})
function cancel() {
  controller?.abort()
  controller = null
  busy.value = false
}
function close() {
  cancel()
  emit('close')
}
useBackClose(close)

async function generate() {
  if (!canGenerate.value) return
  const ctl = new AbortController()
  controller = ctl
  busy.value = true
  error.value = ''
  result.value = null
  const provider = toPlain(settings.settings.provider)
  try {
    const apiKey = await settings.getApiKey(provider.secretRef)
    ctl.signal.throwIfAborted()
    const data = await generateFlow({
      description: description.value,
      fields: toPlain(props.fields),
      ...(props.brief ? { brief: props.brief } : {}),
      ...(props.people?.length ? { people: [...props.people] } : {}),
      ...(props.isGroup ? { isGroup: true } : {}),
      provider,
      apiKey,
      signal: ctl.signal,
    })
    if (controller !== ctl || ctl.signal.aborted) return
    result.value = data
  } catch (cause) {
    if (controller !== ctl || ctl.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (controller === ctl) {
      controller = null
      busy.value = false
    }
  }
}
function apply() {
  if (!result.value) return
  emit('apply', result.value.config, target.value)
}
</script>
<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="ai-dialog cbx-page"
      aria-labelledby="ai-flow-title"
      @cancel.prevent="close"
    >
      <form class="ai-form" @submit.prevent="result ? apply() : generate()">
        <header class="ai-head cbx-page-head">
          <h2 id="ai-flow-title"><Sparkles :size="20" aria-hidden="true" />AI 生成流程</h2>
          <CbxDialogClose @click="close" />
        </header>
        <div class="ai-body cbx-scroll cbx-page-body">
          <p v-if="!settings.isConfigured" class="note">
            请先<RouterLink to="/models" @click="close">配置模型服务</RouterLink>，再生成流程。
          </p>
          <label class="cbx-field">
            <span class="cbx-field__label">描述你想要的剧情线</span>
            <textarea
              v-model="description"
              class="cbx-textarea"
              rows="5"
              maxlength="3000"
              :disabled="busy"
              placeholder="例如：从陌生到恋人，好感度驱动，中途会有一次误会让关系倒退，最终在灯塔下告白。"
            />
          </label>
          <div v-if="hasExisting" class="cbx-field">
            <span class="cbx-field__label">生成后</span>
            <div class="seg" role="radiogroup" aria-label="生成后">
              <label class="seg__opt" :class="{ 'seg__opt--on': target === 'append' }">
                <input v-model="target" type="radio" value="append" :disabled="busy" />
                追加到现有流程
              </label>
              <label class="seg__opt" :class="{ 'seg__opt--on': target === 'replace' }">
                <input v-model="target" type="radio" value="replace" :disabled="busy" />
                替换现有流程
              </label>
            </div>
          </div>

          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <p v-else-if="busy" class="status" role="status">正在设计剧情流程，可能需要几十秒…</p>
          <!-- 预览：阶段 + 规则，确认后再交回编辑器 -->
          <div v-if="result" class="preview">
            <p v-if="result.suggestedFields.length" class="warn">
              建议到「状态」页签新增数值字段：{{
                result.suggestedFields
                  .map(
                    (f) =>
                      `${f.key}${f.min !== undefined || f.max !== undefined ? `（${f.min ?? ''}~${f.max ?? ''}）` : ''}`,
                  )
                  .join('、')
              }}。规则用到了它们，不加的话相关条件不会成立。
            </p>
            <p v-if="result.unknownKeys.length" class="warn">
              规则引用了未知字段：{{ result.unknownKeys.join('、') }}，应用后请手动检查。
            </p>
            <h3 v-if="result.config.stages?.length" class="preview__title">
              剧情阶段 · {{ result.config.stages.length }}
            </h3>
            <div v-for="(s, i) in result.config.stages ?? []" :key="s.id" class="item">
              <span class="item__title">
                {{ s.name }}
                <span v-if="i === 0" class="cbx-badge cbx-badge--brand">初始</span>
              </span>
              <span v-if="s.guide" class="item__body">{{ s.guide }}</span>
              <span v-for="t in s.transitions" :key="t.id" class="item__meta">
                → {{ stageName(t.to) }}（{{ t.conditions.length }} 个条件）
              </span>
            </div>
            <h3 v-if="result.config.rules.length" class="preview__title">
              规则 · {{ result.config.rules.length }}
            </h3>
            <div v-for="r in result.config.rules" :key="r.id" class="item">
              <span class="item__title">{{ r.name }}</span>
              <span class="item__meta">
                {{ r.conditions.length ? `${r.conditions.length} 个条件` : '无条件' }} →
                {{ r.actions.map((a) => FLOW_ACTION_LABEL[a.kind]).join('、') || '没有动作' }}
              </span>
            </div>
          </div>
        </div>
        <footer class="ai-footer cbx-page-foot">
          <button v-if="busy" type="button" class="cbx-btn cbx-btn--soft" @click="cancel">
            取消生成
          </button>
          <button
            v-else-if="result"
            type="button"
            class="cbx-btn cbx-btn--ghost"
            :disabled="!canGenerate"
            @click="generate"
          >
            重新生成
          </button>
          <button v-else type="button" class="cbx-btn cbx-btn--ghost" @click="close">取消</button>
          <button v-if="result" type="submit" class="cbx-btn cbx-btn--primary">
            {{ target === 'append' && hasExisting ? '追加到流程' : '应用到流程' }}
          </button>
          <button v-else type="submit" class="cbx-btn cbx-btn--primary" :disabled="!canGenerate">
            <LoaderCircle v-if="busy" :size="16" /><Sparkles v-else :size="16" />
            {{ busy ? '生成中…' : '生成' }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>
<style scoped>
.ai-dialog {
  width: min(680px, calc(100vw - 24px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius);
  color: var(--cbx-text);
  background: var(--cbx-bg);
  box-shadow: var(--cbx-shadow-md);
}
.ai-dialog::backdrop {
  background: var(--cbx-bg-mask);
}
.ai-form {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 34px);
}
.ai-head,
.ai-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  flex-shrink: 0;
}
.ai-head {
  border-bottom: 1px solid var(--cbx-border);
}
.ai-head h2 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--cbx-fs-lg);
}
.ai-head h2 svg {
  color: var(--cbx-brand);
}
.ai-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  min-height: 0;
}
.ai-footer {
  border-top: 1px solid var(--cbx-border);
}
.seg {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.seg__opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  font-size: var(--cbx-fs-sm);
  cursor: pointer;
}
.seg__opt--on {
  border-color: var(--cbx-brand);
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
.note,
.status,
.error,
.warn {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.note,
.status {
  color: var(--cbx-text-secondary);
}
.error {
  color: var(--cbx-error);
}
.warn {
  padding: 8px 10px;
  color: var(--cbx-text);
  background: var(--cbx-bg-hover);
  border-left: 3px solid var(--cbx-warning-hover);
  border-radius: var(--cbx-radius-md);
}
.preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--cbx-border);
}
.preview__title {
  margin: 8px 0 0;
  font-size: var(--cbx-fs-sm);
}
.item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
}
.item__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-weight: var(--cbx-fw-medium);
  font-size: var(--cbx-fs-sm);
}
.item__body,
.item__meta {
  font-size: var(--cbx-fs-xs);
  line-height: 1.6;
  color: var(--cbx-text-secondary);
  overflow-wrap: anywhere;
}
.item__meta {
  color: var(--cbx-text-tertiary);
}
@media (max-width: 767px) {
  .ai-head,
  .ai-body,
  .ai-footer {
    padding: 12px;
  }
}
</style>
