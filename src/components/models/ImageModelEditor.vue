<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useBackClose } from '@/composables/useBackClose'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'
import { useSettingsStore } from '@/stores/settings'
import { useToast } from '@/composables/useToast'
import { newImageModelService, type ImageModelService } from '@/types/image'
import { validateImageService } from '@/services/image/generate'
import { validateComfyService, listComfyModels } from '@/services/image/comfyui'
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
const comfyModels = ref<{ unets: string[]; clips: string[]; vaes: string[] }>({
  unets: [],
  clips: [],
  vaes: [],
})
let controller: AbortController | null = null
let disposed = false

// 切到本地 ComfyUI 时补上开箱即用的默认地址/Qwen 三件套（本机已部署）
watch(
  () => draft.value.backend,
  (backend) => {
    if (backend === 'comfyui') {
      if (!draft.value.baseUrl.trim()) draft.value.baseUrl = 'http://127.0.0.1:8188'
      if (!draft.value.model.trim()) draft.value.model = 'Qwen-Image-2.1-Q4.gguf'
      if (!draft.value.clipName.trim()) draft.value.clipName = 'qwen3vl_8b_w4a8.safetensors'
      if (!draft.value.vaeName.trim()) draft.value.vaeName = 'qwen_image_2.1_vae_bf16.safetensors'
    }
    models.value = []
    comfyModels.value = { unets: [], clips: [], vaes: [] }
    controller?.abort()
    status.value = ''
  },
)

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
// 手机上是整页：返回键 = 关闭
useBackClose(close)

async function fetchModels() {
  if (fetching.value || loadingKey.value || keyError.value) return
  error.value = ''
  status.value = ''
  models.value = []
  if (draft.value.backend === 'comfyui') {
    if (!draft.value.baseUrl.trim()) {
      error.value = '请先填写 ComfyUI 服务器地址'
      return
    }
    fetching.value = true
    const ctl = new AbortController()
    controller = ctl
    try {
      const result = await listComfyModels(
        { baseUrl: draft.value.baseUrl.trim(), proxyPrefix: draft.value.proxyPrefix.trim() },
        ctl.signal,
      )
      if (disposed || ctl.signal.aborted) return
      comfyModels.value = result
      status.value = `已连接。拉取到 DiT ${result.unets.length} · 编码器 ${result.clips.length} · VAE ${result.vaes.length}，可从下拉选择。`
    } catch (cause) {
      if (!disposed && !ctl.signal.aborted)
        error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      fetching.value = false
    }
    return
  }
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
    if (draft.value.backend === 'comfyui') validateComfyService(draft.value)
    else validateImageService(draft.value)
    if (!draft.value.name.trim()) throw new Error('请填写配置名称')
    saving.value = true
    const service = toPlain(draft.value)
    for (const key of ['name', 'baseUrl', 'model', 'proxyPrefix'] as const)
      service[key] = service[key].trim()
    if (service.backend === 'comfyui') {
      service.clipName = service.clipName.trim()
      service.vaeName = service.vaeName.trim()
      service.sampler = service.sampler.trim()
      service.scheduler = service.scheduler.trim()
      service.negativePrompt = service.negativePrompt.trim()
    } else {
      service.size = service.size.trim()
      service.quality = service.quality.trim()
    }
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
      class="image-dialog cbx-page"
      aria-labelledby="image-model-title"
      @cancel.prevent="close"
    >
      <form class="image-form" @submit.prevent="save">
        <header class="image-head cbx-page-head">
          <h2 id="image-model-title">{{ service ? '编辑文生图配置' : '添加文生图配置' }}</h2>
          <CbxDialogClose :disabled="saving" @click="close" />
        </header>
        <div class="image-body cbx-scroll cbx-page-body">
          <p class="image-note">
            {{
              draft.backend === 'comfyui'
                ? '连接本机 ComfyUI，用 Qwen-Image-2.1 生成角色封面与对话配图（文生图 + 原生参考图编辑）。'
                : '支持 OpenAI Images 兼容接口，生成角色封面与对话配图。'
            }}
          </p>
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
              <span class="cbx-field__label">后端类型</span>
              <select v-model="draft.backend" class="cbx-input" aria-label="后端类型">
                <option value="openai">OpenAI Images 兼容（云端）</option>
                <option value="comfyui">本地 ComfyUI（Qwen-Image-2.1）</option>
              </select>
              <span class="cbx-field__hint">
                可调用本机或局域网里另一台电脑上的 ComfyUI。App（电脑 /
                安卓）直连；网页开发版经开发服务器中转， 手机上的网页版也能用。
              </span>
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">{{
                draft.backend === 'comfyui' ? '服务器地址' : '接口地址（baseURL）'
              }}</span>
              <input
                v-model="draft.baseUrl"
                class="cbx-input"
                :aria-label="draft.backend === 'comfyui' ? '服务器地址' : '接口地址（baseURL）'"
                type="url"
                required
                :placeholder="
                  draft.backend === 'comfyui' ? 'http://127.0.0.1:8188' : 'https://你的服务地址/v1'
                "
              />
              <span class="cbx-field__hint">{{
                draft.backend === 'comfyui'
                  ? '本机填 http://127.0.0.1:8188；在手机或另一台设备上，填运行 ComfyUI 的电脑的局域网地址（如 http://192.168.1.10:8188），且那台电脑的 ComfyUI 要用 --listen 0.0.0.0 启动。点下方「测试连接并拉取模型」即可验证。'
                  : '填写接口根地址。封面生成使用 /images/generations，对话参考图生成使用 /images/edits，需选择支持该接口的模型。'
              }}</span>
            </label>
            <template v-if="draft.backend === 'openai'">
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
                    <span class="icon-swap"
                      ><Transition name="icon-swap"
                        ><AppIcon
                          :key="String(showKey)"
                          :name="showKey ? 'EyeOff' : 'Eye'"
                          :active="showKey" /></Transition
                    ></span>
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
            </template>
            <template v-else>
              <label class="cbx-field">
                <span class="cbx-field__label">DiT · 扩散主干（GGUF）</span>
                <input
                  v-model="draft.model"
                  class="cbx-input"
                  list="comfy-unet-list"
                  required
                  placeholder="Qwen-Image-2.1-Q4.gguf"
                />
                <datalist id="comfy-unet-list">
                  <option v-for="id in comfyModels.unets" :key="id" :value="id" />
                </datalist>
                <span class="cbx-field__hint"
                  >放在 models/unet/ 下的 Qwen-Image-2.1 GGUF 文件。</span
                >
              </label>
              <label class="cbx-field">
                <span class="cbx-field__label">文本编码器</span>
                <input
                  v-model="draft.clipName"
                  class="cbx-input"
                  list="comfy-clip-list"
                  required
                  placeholder="qwen3vl_8b_w4a8.safetensors"
                />
                <datalist id="comfy-clip-list">
                  <option v-for="id in comfyModels.clips" :key="id" :value="id" />
                </datalist>
                <span class="cbx-field__hint"
                  >放在 models/text_encoders/ 下的 Qwen 文本编码器。</span
                >
              </label>
              <label class="cbx-field">
                <span class="cbx-field__label">VAE</span>
                <input
                  v-model="draft.vaeName"
                  class="cbx-input"
                  list="comfy-vae-list"
                  required
                  placeholder="qwen_image_2.1_vae_bf16.safetensors"
                />
                <datalist id="comfy-vae-list">
                  <option v-for="id in comfyModels.vaes" :key="id" :value="id" />
                </datalist>
                <span class="cbx-field__hint">放在 models/vae/ 下的 Qwen-Image-2.1 VAE。</span>
              </label>
              <button type="button" class="cbx-btn cbx-btn--soft" @click="fetchModels">
                {{ fetching ? '连接中…' : '测试连接并拉取模型' }}
              </button>
              <div class="image-grid params">
                <label class="cbx-field">
                  <span class="cbx-field__label">分辨率（方图）</span>
                  <input
                    v-model.number="draft.resolution"
                    class="cbx-input"
                    type="number"
                    min="256"
                    max="2048"
                    step="32"
                  />
                </label>
                <label class="cbx-field">
                  <span class="cbx-field__label">步数</span>
                  <input
                    v-model.number="draft.steps"
                    class="cbx-input"
                    type="number"
                    min="1"
                    max="100"
                    step="1"
                  />
                </label>
                <label class="cbx-field">
                  <span class="cbx-field__label">CFG</span>
                  <input
                    v-model.number="draft.cfg"
                    class="cbx-input"
                    type="number"
                    min="0"
                    max="30"
                    step="0.5"
                  />
                </label>
              </div>
              <span class="cbx-field__hint"
                >Qwen 原生只出方图，尺寸由「分辨率」单值决定（32 的倍数，原生 1024，越大越慢）；步数
                12 已够（引导蒸馏模型），CFG 固定 1。</span
              >
              <div class="image-grid params">
                <label class="cbx-field">
                  <span class="cbx-field__label">采样器</span>
                  <input
                    v-model="draft.sampler"
                    class="cbx-input"
                    list="comfy-sampler-list"
                    placeholder="euler"
                  />
                  <datalist id="comfy-sampler-list">
                    <option value="euler" />
                    <option value="euler_ancestral" />
                    <option value="dpmpp_2m" />
                    <option value="dpmpp_2m_sde" />
                    <option value="dpmpp_sde" />
                  </datalist>
                </label>
                <label class="cbx-field">
                  <span class="cbx-field__label">调度器</span>
                  <input
                    v-model="draft.scheduler"
                    class="cbx-input"
                    list="comfy-scheduler-list"
                    placeholder="simple"
                  />
                  <datalist id="comfy-scheduler-list">
                    <option value="simple" />
                    <option value="normal" />
                    <option value="karras" />
                    <option value="sgm_uniform" />
                    <option value="beta" />
                  </datalist>
                </label>
                <label class="cbx-field">
                  <span class="cbx-field__label">图生图强度</span>
                  <input
                    v-model.number="draft.denoise"
                    class="cbx-input"
                    type="number"
                    min="0.1"
                    max="1"
                    step="0.05"
                  />
                </label>
              </div>
              <label class="cbx-field">
                <span class="cbx-field__label">负面提示词</span>
                <input
                  v-model="draft.negativePrompt"
                  class="cbx-input"
                  placeholder="blurry, low quality, distorted, watermark, text"
                />
                <span class="cbx-field__hint"
                  >CFG=1 时负面提示词不生效（保留供高级用途）。图生图强度：Qwen 编辑默认
                  1.0（靠参考图 reference_latents 保人物）；降低会更贴近原图但改动更弱。</span
                >
              </label>
            </template>
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
        <footer class="image-footer cbx-page-foot">
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
