<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Eye, EyeOff, X } from 'lucide-vue-next'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { newImageModelService, type ImageModelService } from '@/types/image'
import { validateImageService } from '@/services/image/generate'
import { listModels } from '@/services/provider/openaiCompatible'
import { toPlain } from '@/utils/plain'

const props = defineProps<{ service: ImageModelService | null }>()
const emit = defineEmits<{ close: [] }>()
const settings = useSettingsStore()
const toast = useToast()
const draft = ref(props.service ? toPlain(props.service) : newImageModelService())
const dialog = ref<HTMLDialogElement | null>(null)
const apiKey = ref('')
const showKey = ref(false)
const loadingKey = ref(true)
const keyError = ref('')
const saving = ref(false)
const fetching = ref(false)
const error = ref('')
const status = ref('')
const models = ref<string[]>([])
let controller: AbortController | null = null
let disposed = false

onMounted(async () => {
  dialog.value?.showModal()
  try {
    if (props.service) apiKey.value = await settings.getApiKey(props.service.secretRef)
  } catch {
    keyError.value = '读取密钥失败，请关闭后重试'
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
  () => [draft.value.baseUrl, draft.value.proxyPrefix, apiKey.value],
  () => {
    if (loadingKey.value) return
    controller?.abort()
    models.value = []
    status.value = ''
  },
  { flush: 'sync' },
)
function close() {
  if (!saving.value) emit('close')
}

async function fetchModels() {
  if (fetching.value || loadingKey.value || keyError.value) return
  error.value = ''
  status.value = ''
  models.value = []
  try {
    validateImageService({ ...draft.value, model: draft.value.model || 'placeholder' })
  } catch (cause) {
    error.value = String((cause as Error).message)
    return
  }
  fetching.value = true
  const ctl = new AbortController()
  controller = ctl
  try {
    const result = await listModels(
      {
        baseUrl: draft.value.baseUrl.trim(),
        proxyPrefix: draft.value.proxyPrefix.trim(),
        apiKey: apiKey.value.trim(),
      },
      ctl.signal,
    )
    if (disposed || ctl.signal.aborted) return
    const adjusted = result.baseUrl !== draft.value.baseUrl.trim().replace(/\/+$/, '')
    controller = null
    draft.value.baseUrl = result.baseUrl
    models.value = result.models.map((item) => item.id)
    status.value = `已拉取 ${models.value.length} 个模型${adjusted ? '，接口地址已补全 /v1，请保存配置' : ''}。请选择支持文生图的模型；也可以手动填写。`
  } catch (cause) {
    if (!disposed && !ctl.signal.aborted)
      error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    fetching.value = false
  }
}

async function save() {
  if (saving.value || loadingKey.value || keyError.value || fetching.value) return
  error.value = ''
  try {
    validateImageService(draft.value)
    if (!draft.value.name.trim()) throw new Error('请填写配置名称')
    saving.value = true
    const service = toPlain(draft.value)
    for (const key of ['name', 'baseUrl', 'model', 'proxyPrefix', 'size', 'quality'] as const)
      service[key] = service[key].trim()
    await settings.saveImageModelService(service, apiKey.value)
    toast.success('文生图配置已保存')
    emit('close')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="image-dialog"
      aria-labelledby="image-model-title"
      @cancel.prevent="close"
    >
      <form class="image-form" @submit.prevent="save">
        <header class="image-head">
          <h2 id="image-model-title">{{ service ? '编辑文生图配置' : '添加文生图配置' }}</h2>
          <button
            type="button"
            class="cbx-icon-btn"
            aria-label="关闭"
            :disabled="saving"
            @click="close"
          >
            <X :size="18" />
          </button>
        </header>
        <div class="image-body cbx-scroll">
          <p class="image-note">支持 OpenAI Images 兼容接口，生成角色封面与对话配图。</p>
          <fieldset class="image-fields" :disabled="saving || fetching">
            <label class="cbx-field">
              <span class="cbx-field__label">配置名称</span>
              <input
                v-model="draft.name"
                class="cbx-input"
                required
                maxlength="100"
                autofocus
                placeholder="例如：角色插画"
              />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">接口地址（baseURL）</span>
              <input
                v-model="draft.baseUrl"
                class="cbx-input"
                aria-label="接口地址（baseURL）"
                type="url"
                required
                placeholder="https://你的服务地址/v1"
              />
              <span class="cbx-field__hint"
                >填写接口根地址。封面生成使用 /images/generations，对话参考图生成使用
                /images/edits，需选择支持该接口的模型。</span
              >
            </label>
            <div class="cbx-field">
              <label class="cbx-field__label" for="image-api-key">API Key</label>
              <div class="image-controls">
                <input
                  id="image-api-key"
                  v-model="apiKey"
                  class="cbx-input"
                  :type="showKey ? 'text' : 'password'"
                  :disabled="loadingKey || !!keyError"
                  autocomplete="off"
                  placeholder="仅保存在本机"
                />
                <button
                  type="button"
                  class="cbx-icon-btn"
                  :aria-label="showKey ? '隐藏密钥' : '显示密钥'"
                  @click="showKey = !showKey"
                >
                  <EyeOff v-if="showKey" :size="18" /><Eye v-else :size="18" />
                </button>
              </div>
            </div>
            <label class="cbx-field">
              <span class="cbx-field__label">文生图模型</span>
              <input
                v-model="draft.model"
                class="cbx-input"
                list="image-model-list"
                required
                placeholder="填写服务商提供的模型名"
              />
              <datalist id="image-model-list">
                <option v-for="id in models" :key="id" :value="id" />
              </datalist>
            </label>
            <button
              type="button"
              class="cbx-btn cbx-btn--soft"
              :disabled="loadingKey || !!keyError"
              @click="fetchModels"
            >
              {{ fetching ? '拉取中…' : '拉取模型列表' }}
            </button>
            <div class="image-grid params">
              <label class="cbx-field">
                <span class="cbx-field__label">默认尺寸</span>
                <input
                  v-model="draft.size"
                  class="cbx-input"
                  list="image-size-list"
                  placeholder="留空使用模型默认值"
                />
                <datalist id="image-size-list">
                  <option value="1024x1024" />
                  <option value="1024x1536" />
                  <option value="1536x1024" />
                  <option value="1024x1792" />
                  <option value="1792x1024" />
                  <option value="auto" />
                </datalist>
              </label>
              <label class="cbx-field">
                <span class="cbx-field__label">画质</span>
                <input
                  v-model="draft.quality"
                  class="cbx-input"
                  list="image-quality-list"
                  placeholder="留空使用模型默认值"
                />
                <datalist id="image-quality-list">
                  <option value="auto" />
                  <option value="standard" />
                  <option value="hd" />
                  <option value="low" />
                  <option value="medium" />
                  <option value="high" />
                </datalist>
              </label>
            </div>
            <label class="cbx-field">
              <span class="cbx-field__label">返回格式</span>
              <select v-model="draft.responseFormat" class="cbx-input" aria-label="返回格式">
                <option value="">模型默认</option>
                <option value="b64_json">Base64</option>
                <option value="url">图片链接</option>
              </select>
              <span class="cbx-field__hint"
                >尺寸、画质和返回格式需由所选模型支持。图片链接需允许跨域下载。</span
              >
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">参考图格式</span>
              <select v-model="draft.referenceMode" class="cbx-input" aria-label="参考图格式">
                <option value="">自动（首次探测后记住）</option>
                <option value="multipart">multipart · OpenAI 标准</option>
                <option value="json">JSON image_urls · xAI / grok-imagine</option>
              </select>
              <span class="cbx-field__hint"
                >对话参考图生成的请求格式。自动会先按 multipart 发送、被拒后改用 JSON
                并记住可用格式；已知服务格式时固定它，避免多余的探测请求。</span
              >
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">代理地址（可选）</span>
              <input
                v-model="draft.proxyPrefix"
                class="cbx-input"
                aria-label="代理地址（可选）"
                placeholder="例如 /llm 或自建代理地址"
              />
              <span class="cbx-field__hint"
                >替换接口的域名，保留路径。/llm 需要先配置开发代理。</span
              >
            </label>
          </fieldset>
          <p v-if="keyError || error" class="image-error" role="alert">{{ keyError || error }}</p>
          <p v-if="status" class="image-note" role="status">{{ status }}</p>
        </div>
        <footer class="image-footer">
          <button type="button" class="cbx-btn cbx-btn--ghost" :disabled="saving" @click="close">
            取消
          </button>
          <button
            type="submit"
            class="cbx-btn cbx-btn--primary"
            :disabled="saving || fetching || loadingKey || !!keyError"
          >
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped src="@/assets/styles/image-dialog.css"></style>
<style scoped>
.params {
  margin-top: 16px;
}
</style>
