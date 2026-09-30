<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ChevronDown, LoaderCircle, PlugZap, RefreshCw, Save } from '@/components/icons'
import { useBackClose } from '@/composables/useBackClose'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { chatOnce, listModels } from '@/services/provider/openaiCompatible'
import {
  PROVIDER_PRESETS,
  familyOf,
  presetForUrl,
  supportsThinkingToggle,
} from '@/services/provider/compat'
import { thinkingField, type ProviderConfig } from '@/types/provider'
import { defaultSettings, type ModelService } from '@/types/settings'
import { toPlain } from '@/utils/plain'

const props = defineProps<{ service: ModelService | null }>()
const emit = defineEmits<{ close: [] }>()
const settings = useSettingsStore()
const toast = useToast()
const id = props.service?.id ?? crypto.randomUUID()
const draft = ref<ModelService>(
  props.service
    ? toPlain(props.service)
    : {
        id,
        name: '',
        provider: { ...defaultSettings().provider, secretRef: `model-service:${id}` },
      },
)
// 老记录没有 thinking 字段（toPlain 拷的是原值）：补默认
draft.value.provider.thinking ??= 'auto'
const THINKING_OPTIONS = [
  { value: 'auto', label: '默认（由服务商决定）' },
  { value: 'off', label: '关闭：直接回复，更快更省' },
  { value: 'on', label: '开启：先推理再回复' },
]
const presetOptions = computed(() => [
  { value: '', label: '自定义 / 中转服务' },
  ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label })),
])

const dialog = ref<HTMLDialogElement | null>(null)

/**
 * 服务商预设。选中时填地址 / 模型 / 上下文；名称只在还没填、或还是上一个预设名时覆盖，
 * 免得把用户自己起的名字冲掉。「自定义」= 不动任何字段。
 */
const presetId = ref(presetForUrl(draft.value.provider.baseUrl)?.id ?? '')
const preset = computed(() => PROVIDER_PRESETS.find((p) => p.id === presetId.value))
const family = computed(() => familyOf(draft.value.provider.baseUrl))
const thinkingSupported = computed(() => supportsThinkingToggle(family.value))
function applyPreset() {
  const next = preset.value
  if (!next) return
  const p = draft.value.provider
  const prevName = PROVIDER_PRESETS.find((x) => x.label === draft.value.name.trim())
  if (!draft.value.name.trim() || prevName) draft.value.name = next.label
  p.baseUrl = next.baseUrl
  p.model = next.model
  p.contextWindow = next.contextWindow
  feedback.value = null
}
// 手改地址后，预设下拉跟着回显（改成自建中转就显示「自定义」）
watch(
  () => draft.value.provider.baseUrl,
  (url) => {
    const found = presetForUrl(url)
    if ((found?.id ?? '') !== presetId.value) presetId.value = found?.id ?? ''
  },
)
const apiKey = ref('')
const showKey = ref(false)
const loadingKey = ref(true)
const keyError = ref('')
const saving = ref(false)
const testing = ref(false)
const loadingModels = ref(false)
const pickerOpen = ref(false)
const typing = ref(false)
const feedback = ref<{ kind: 'success' | 'error' | 'warning'; text: string } | null>(null)
const modelIds = ref(draft.value.provider.modelCache?.ids ?? [])
const picker = ref<HTMLElement | null>(null)
const filteredModels = computed(() => {
  const query = draft.value.provider.model.trim().toLowerCase()
  return typing.value && query
    ? modelIds.value.filter((model) => model.toLowerCase().includes(query))
    : modelIds.value
})
let controller: AbortController | null = null
let disposed = false

onMounted(async () => {
  dialog.value?.showModal()
  try {
    if (props.service) apiKey.value = await settings.getApiKey(props.service.provider.secretRef)
  } catch (error) {
    keyError.value = `读取密钥失败：${errorText(error)}`
  } finally {
    loadingKey.value = false
  }
})

onBeforeUnmount(() => {
  disposed = true
  controller?.abort()
  dialog.value?.close()
})

watch(
  () => [draft.value.provider.baseUrl, draft.value.provider.proxyPrefix, apiKey.value],
  () => {
    if (loadingKey.value) return
    controller?.abort()
    modelIds.value = []
    pickerOpen.value = false
    delete draft.value.provider.modelCache
  },
  { flush: 'sync' },
)

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function config(): ProviderConfig {
  const p = draft.value.provider
  return {
    baseUrl: p.baseUrl.trim(),
    ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    ...(p.proxyPrefix.trim() ? { proxyPrefix: p.proxyPrefix.trim() } : {}),
    headers: p.extraHeaders,
    ...thinkingField(p.thinking),
  }
}

function validEndpoint() {
  try {
    const url = new URL(draft.value.provider.baseUrl.trim())
    if (url.protocol === 'http:' || url.protocol === 'https:') return true
  } catch {
    /* 统一显示字段错误。 */
  }
  feedback.value = { kind: 'error', text: '请填写有效的 HTTP 或 HTTPS 接口地址' }
  return false
}

async function fetchModels() {
  if (!validEndpoint()) return
  const ctl = new AbortController()
  controller = ctl
  loadingModels.value = true
  feedback.value = null
  try {
    const result = await listModels(config(), ctl.signal)
    if (disposed || ctl.signal.aborted) return
    const adjusted = result.baseUrl !== draft.value.provider.baseUrl.trim().replace(/\/+$/, '')
    // 同步地址会触发清缓存 watcher；请求已经结束，先解除其取消目标。
    controller = null
    draft.value.provider.baseUrl = result.baseUrl
    modelIds.value = result.models.map((model) => model.id)
    draft.value.provider.modelCache = { at: Date.now(), ids: modelIds.value }
    typing.value = false
    pickerOpen.value = modelIds.value.length > 0
    feedback.value = result.models.length
      ? {
          kind: 'success',
          text: `已拉取 ${modelIds.value.length} 个模型${adjusted ? '，接口地址已补全 /v1，请保存配置' : ''}`,
        }
      : { kind: 'warning', text: '接口没有返回任何模型' }
  } catch (error) {
    if (!disposed && !ctl.signal.aborted) feedback.value = { kind: 'error', text: errorText(error) }
  } finally {
    loadingModels.value = false
  }
}

async function testConnection() {
  if (!validEndpoint()) return
  if (!draft.value.provider.model.trim()) {
    feedback.value = { kind: 'error', text: '请先填写模型名' }
    return
  }
  const ctl = new AbortController()
  controller = ctl
  testing.value = true
  feedback.value = null
  try {
    const output = await chatOnce(
      config(),
      {
        model: draft.value.provider.model.trim(),
        messages: [{ role: 'user', content: '说"连接成功"四个字' }],
        stream: false,
        maxTokens: 32,
      },
      ctl.signal,
      60_000,
    )
    if (!disposed && !ctl.signal.aborted)
      feedback.value = { kind: 'success', text: `连接成功：${output.slice(0, 40)}` }
  } catch (error) {
    if (!disposed && !ctl.signal.aborted) feedback.value = { kind: 'error', text: errorText(error) }
  } finally {
    testing.value = false
  }
}

async function save() {
  if (saving.value || loadingKey.value || keyError.value || !validEndpoint()) return
  draft.value.name = draft.value.name.trim()
  const p = draft.value.provider
  p.baseUrl = p.baseUrl.trim()
  p.model = p.model.trim()
  p.proxyPrefix = p.proxyPrefix.trim()
  if (!draft.value.name || !p.model) {
    feedback.value = { kind: 'error', text: '请填写服务名称与模型名' }
    return
  }
  saving.value = true
  try {
    await settings.saveModelService(draft.value, apiKey.value)
    toast.success('模型服务已保存')
    emit('close')
  } catch (error) {
    feedback.value = { kind: 'error', text: errorText(error) }
  } finally {
    saving.value = false
  }
}

function close() {
  if (!saving.value) emit('close')
}
// 手机上是整页：返回键 = 关闭
useBackClose(close)

function pickModel(model: string) {
  draft.value.provider.model = model
  pickerOpen.value = false
  typing.value = false
}

function filterModels() {
  typing.value = true
  pickerOpen.value = modelIds.value.length > 0
}

function openPicker() {
  typing.value = false
  pickerOpen.value = modelIds.value.length > 0
}

function togglePicker() {
  typing.value = false
  pickerOpen.value = !pickerOpen.value
}

function dismissPicker(event: FocusEvent | PointerEvent) {
  const target = event instanceof FocusEvent ? event.relatedTarget : event.target
  if (!(target instanceof Node) || !picker.value?.contains(target)) pickerOpen.value = false
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="service-dialog cbx-page"
      aria-labelledby="service-editor-title"
      @cancel.prevent="close"
      @pointerdown.self="close"
    >
      <form @submit.prevent="save" @pointerdown="dismissPicker">
        <header class="editor-head cbx-page-head">
          <h2 id="service-editor-title">{{ service ? '编辑模型服务' : '添加模型服务' }}</h2>
          <CbxDialogClose :disabled="saving" @click="close" />
        </header>
        <fieldset class="editor-fields cbx-page-body" :disabled="saving">
          <label class="cbx-field">
            <span class="cbx-field__label">服务商</span>
            <CbxSelect
              v-model="presetId"
              :options="presetOptions"
              label="服务商"
              @change="applyPreset"
            />
            <span v-if="preset?.note" class="cbx-field__hint">{{ preset.note }}</span>
            <span v-if="preset?.keyUrl" class="cbx-field__hint key-url"
              >API Key 申请地址：<span class="mono">{{ preset.keyUrl }}</span></span
            >
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">服务名称</span>
            <input
              v-model="draft.name"
              class="cbx-input"
              placeholder="例如：DeepSeek"
              required
              autofocus
              maxlength="100"
            />
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">接口地址（baseURL）</span>
            <input
              v-model="draft.provider.baseUrl"
              class="cbx-input"
              aria-label="接口地址（baseURL）"
              type="url"
              placeholder="https://api.deepseek.com/v1"
              required
            />
            <span class="cbx-field__hint"
              >填写 API 根地址（通常以 /v1 结尾）。选了上面的服务商会自动填好。</span
            >
          </label>
          <div class="cbx-field">
            <label class="cbx-field__label" for="service-api-key">API Key</label>
            <div class="control-row">
              <input
                id="service-api-key"
                v-model="apiKey"
                class="cbx-input"
                :type="showKey ? 'text' : 'password'"
                :disabled="loadingKey || !!keyError"
                autocomplete="off"
                :placeholder="preset?.noKey ? '本地服务可留空' : 'sk-...'"
              />
              <button
                type="button"
                class="cbx-icon-btn"
                :title="showKey ? '隐藏密钥' : '显示密钥'"
                :aria-label="showKey ? '隐藏密钥' : '显示密钥'"
                @click="showKey = !showKey"
              >
                <span class="icon-swap"
                  ><Transition name="icon-swap"
                    ><AppIcon
                      :key="String(showKey)"
                      :name="showKey ? 'EyeOff' : 'Eye'"
                      :active="showKey" /></Transition
                ></span>
              </button>
            </div>
            <span v-if="keyError" class="field-error" role="alert">{{ keyError }}</span>
          </div>
          <div class="cbx-field">
            <label for="service-model" class="cbx-field__label">模型</label>
            <div class="control-row">
              <div
                ref="picker"
                class="picker"
                @focusout="dismissPicker"
                @keydown.esc.stop.prevent="pickerOpen = false"
              >
                <div class="control-row">
                  <input
                    id="service-model"
                    v-model="draft.provider.model"
                    class="cbx-input"
                    :placeholder="preset?.model || '点右侧按钮拉取模型列表'"
                    required
                    aria-controls="service-model-list"
                    :aria-expanded="pickerOpen"
                    @input="filterModels"
                    @keydown.down.prevent="openPicker"
                  />
                  <button
                    v-if="modelIds.length"
                    type="button"
                    class="cbx-icon-btn"
                    title="选择模型"
                    aria-label="选择模型"
                    :aria-expanded="pickerOpen"
                    @click="togglePicker"
                  >
                    <ChevronDown :size="20" />
                  </button>
                </div>
                <div v-if="pickerOpen" id="service-model-list" class="picker-panel cbx-scroll">
                  <div v-if="!filteredModels.length" class="picker-empty">
                    <span>没有匹配的模型</span>
                    <button type="button" class="cbx-btn cbx-btn--ghost" @click="typing = false">
                      显示全部
                    </button>
                  </div>
                  <button
                    v-for="model in filteredModels"
                    :key="model"
                    type="button"
                    class="picker-option"
                    :class="{ 'picker-option--active': model === draft.provider.model }"
                    @click="pickModel(model)"
                  >
                    {{ model }}
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="cbx-icon-btn"
                :disabled="loadingModels || testing || loadingKey || !!keyError"
                :title="loadingModels ? '拉取中' : '拉取模型列表'"
                :aria-label="loadingModels ? '拉取中' : '拉取模型列表'"
                @click="fetchModels"
              >
                <LoaderCircle v-if="loadingModels" :size="20" /><RefreshCw v-else :size="20" />
              </button>
            </div>
          </div>
          <label class="cbx-field">
            <span class="cbx-field__label">代理地址（可选）</span>
            <input v-model="draft.provider.proxyPrefix" class="cbx-input" placeholder="/llm" />
          </label>
          <div class="parameter-grid">
            <label class="cbx-field">
              <span class="cbx-field__label">温度</span>
              <input
                v-model.number="draft.provider.temperature"
                class="cbx-input"
                type="number"
                min="0"
                max="2"
                step="0.1"
                required
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">最大回复 token</span>
              <input
                v-model.number="draft.provider.maxTokens"
                class="cbx-input"
                type="number"
                min="1"
                step="1"
                required
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">上下文窗口</span>
              <input
                v-model.number="draft.provider.contextWindow"
                class="cbx-input"
                type="number"
                min="1"
                step="1"
                required
              />
            </label>
          </div>
          <label class="cbx-field">
            <span class="cbx-field__label">思考模式</span>
            <CbxSelect
              v-model="draft.provider.thinking"
              :options="THINKING_OPTIONS"
              label="思考模式"
              :disabled="!thinkingSupported"
            />
            <span class="cbx-field__hint">{{
              thinkingSupported
                ? '只对支持思考开关的模型生效；不支持的模型会自动忽略。'
                : '当前服务商没有统一的思考开关，按模型默认行为。'
            }}</span>
          </label>
          <label class="cbx-switch stream-switch">
            <input v-model="draft.provider.stream" type="checkbox" />
            <span class="cbx-switch__track" /><span>流式输出</span>
          </label>
          <p v-if="feedback" class="feedback" :class="`feedback--${feedback.kind}`" role="status">
            {{ feedback.text }}
          </p>
        </fieldset>
        <footer class="editor-footer cbx-page-foot">
          <button
            type="button"
            class="cbx-btn cbx-btn--soft"
            :disabled="testing || loadingModels || loadingKey || saving || !!keyError"
            @click="testConnection"
          >
            <LoaderCircle v-if="testing" :size="16" /><PlugZap v-else :size="16" />{{
              testing ? '测试中' : '测试连接'
            }}
          </button>
          <button
            type="submit"
            class="cbx-btn cbx-btn--primary"
            :disabled="saving || loadingKey || !!keyError"
          >
            <LoaderCircle v-if="saving" :size="16" /><Save v-else :size="16" />{{
              saving ? '保存中' : '保存'
            }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.service-dialog {
  width: min(600px, calc(100vw - 24px));
  max-height: calc(100dvh - 32px);
  margin: auto;
  padding: 0;
  color: var(--cbx-text);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: 8px;
  box-shadow: var(--cbx-shadow-md);
}
.service-dialog::backdrop {
  background: var(--cbx-bg-mask);
}
.editor-head,
.editor-footer,
.control-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.editor-head,
.editor-footer {
  justify-content: space-between;
  padding: 16px 20px;
}
.editor-head {
  border-bottom: 1px solid var(--cbx-border);
}
.editor-head h2 {
  margin: 0;
  font-size: var(--cbx-fs-lg);
}
.editor-fields {
  margin: 0;
  padding: 16px 20px;
  border: 0;
  min-width: 0;
}
.editor-footer {
  border-top: 1px solid var(--cbx-border);
}
.control-row > .cbx-input,
.picker {
  flex: 1;
  min-width: 0;
}
.cbx-icon-btn {
  flex-shrink: 0;
}
.parameter-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.parameter-grid .cbx-field__label {
  min-height: 20px;
}
.stream-switch {
  gap: 8px;
  font-size: var(--cbx-fs-sm);
}
.picker {
  position: relative;
}
.picker-panel {
  position: absolute;
  z-index: 1;
  top: calc(100% + 4px);
  left: 0;
  width: 100%;
  max-height: 220px;
  padding: 4px;
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  border-radius: 6px;
  box-shadow: var(--cbx-shadow-md);
}
.picker-option {
  display: block;
  width: 100%;
  padding: 10px;
  text-align: left;
  font-size: var(--cbx-fs-sm);
  overflow-wrap: anywhere;
  border: 0;
  border-radius: 4px;
  color: var(--cbx-text);
  background: transparent;
  cursor: pointer;
}
.picker-option:hover,
.picker-option:focus-visible {
  background: var(--cbx-bg-hover);
}
.picker-option--active {
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
.picker-empty {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 8px;
  font-size: var(--cbx-fs-sm);
}
.key-url .mono {
  font-family: var(--cbx-font-mono);
  user-select: all;
  overflow-wrap: anywhere;
}
.field-error {
  color: var(--cbx-error);
  font-size: var(--cbx-fs-sm);
  overflow-wrap: anywhere;
}
.feedback {
  margin: 12px 0 0;
  font-size: var(--cbx-fs-sm);
  overflow-wrap: anywhere;
}
.feedback--error {
  color: var(--cbx-error);
}
.feedback--success {
  color: var(--cbx-success);
}
.feedback--warning {
  color: var(--cbx-warning-hover);
}

@media (max-width: 480px) {
  .editor-head,
  .editor-footer,
  .editor-fields {
    padding: 12px;
  }
  .parameter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
