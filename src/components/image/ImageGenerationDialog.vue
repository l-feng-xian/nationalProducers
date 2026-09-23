<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { RouterLink } from 'vue-router'
import { ImagePlus, X } from '@/components/icons'
import { useSettingsStore } from '@/stores/settings'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { blobsRepo } from '@/db/repositories'
import { generateImage } from '@/services/image/generate'
import { toPlain } from '@/utils/plain'
import type { CharacterImageReference, GeneratedImage, ImageReferenceInput } from '@/types/image'

const props = defineProps<{
  title: string
  initialPrompt: string
  applyLabel: string
  apply: (image: GeneratedImage) => Promise<void>
  references?: CharacterImageReference[]
  requireReferences?: boolean
  /** 提供时：用已配置的 LLM 生成画面提示词。打开即自动跑一次，也可点按钮重生成。 */
  generatePrompt?: (signal: AbortSignal) => Promise<string>
}>()
const emit = defineEmits<{ close: [] }>()
const settings = useSettingsStore()
const dialog = ref<HTMLDialogElement | null>(null)
const serviceId = ref(
  settings.activeImageService?.id ?? settings.settings.imageModelServices[0]?.id ?? '',
)
const service = computed(() =>
  settings.settings.imageModelServices.find((item) => item.id === serviceId.value),
)
const prompt = ref(props.initialPrompt)
const referenceProblem = computed(() => {
  if (props.requireReferences && !props.references?.length)
    return '当前对话尚未关联角色，请先选择带有封面图片的角色。'
  const missing = props.references?.filter((reference) => !reference.blobId) ?? []
  return missing.length
    ? `请先为「${missing.map((reference) => reference.name).join('、')}」设置角色封面，再生成配图。`
    : ''
})
const busy = ref(false)
const saving = ref(false)
const error = ref('')
const status = ref('')
const result = shallowRef<GeneratedImage | null>(null)
const preview = ref('')
const promptBusy = ref(false)
let controller: AbortController | null = null
let promptController: AbortController | null = null
let disposed = false
onMounted(() => {
  dialog.value?.showModal()
  // 打开即用 LLM 生成一版提示词（可编辑、可重生成）；未提供则沿用传入的初始提示词
  if (props.generatePrompt) void runGeneratePrompt()
})
onBeforeUnmount(() => {
  disposed = true
  controller?.abort()
  promptController?.abort()
  if (preview.value) URL.revokeObjectURL(preview.value)
  dialog.value?.close()
})

/** 调用外部提供的 LLM 提示词生成器，填入「画面描述」。失败静默保留原提示词。 */
async function runGeneratePrompt() {
  if (!props.generatePrompt || promptBusy.value || busy.value || saving.value) return
  promptController?.abort()
  const ctl = new AbortController()
  promptController = ctl
  promptBusy.value = true
  error.value = ''
  status.value = 'AI 正在根据内容生成提示词…'
  try {
    const text = await props.generatePrompt(ctl.signal)
    if (disposed || ctl.signal.aborted) return
    if (text.trim()) prompt.value = text.trim()
    status.value = '提示词已生成，可调整后再出图。'
  } catch (cause) {
    if (disposed || ctl.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : String(cause)
    status.value = ''
  } finally {
    if (promptController === ctl) {
      promptController = null
      promptBusy.value = false
    }
  }
}
function cancel() {
  controller?.abort()
  controller = null
  busy.value = false
  status.value = '已取消生成'
}
function close() {
  if (!saving.value) {
    cancel()
    emit('close')
  }
}
async function generate() {
  if (
    busy.value ||
    saving.value ||
    !service.value ||
    !prompt.value.trim() ||
    referenceProblem.value
  )
    return
  const snapshot = toPlain(service.value)
  const text = prompt.value
  const referenceSnapshot = toPlain(props.references ?? [])
  const ctl = new AbortController()
  controller = ctl
  busy.value = true
  error.value = ''
  status.value = '正在生成图片，请稍候…'
  try {
    const references: ImageReferenceInput[] = []
    for (const reference of referenceSnapshot) {
      ctl.signal.throwIfAborted()
      const blob = reference.blobId ? await blobsRepo.get(reference.blobId) : undefined
      if (!blob) throw new Error(`无法读取「${reference.name}」的角色封面，请重新设置封面后再试`)
      references.push({ name: reference.name, blob })
    }
    const apiKey = await settings.getApiKey(snapshot.secretRef)
    ctl.signal.throwIfAborted()
    const image = await generateImage({
      service: snapshot,
      apiKey,
      prompt: text,
      references,
      signal: ctl.signal,
    })
    if (disposed || controller !== ctl || ctl.signal.aborted) return
    // 回写参考图格式缓存：下次同服务生成不再先白跑一趟被拒的请求。
    if (image.referenceMode)
      await settings.patchImageReferenceMode(snapshot.id, image.referenceMode)
    if (preview.value) URL.revokeObjectURL(preview.value)
    result.value = image
    preview.value = URL.createObjectURL(image.blob)
    status.value = '图片已生成，确认后保存。'
  } catch (cause) {
    if (disposed || controller !== ctl || ctl.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : String(cause)
    status.value = ''
  } finally {
    if (controller === ctl) {
      controller = null
      busy.value = false
    }
  }
}
async function apply() {
  if (!result.value || busy.value || saving.value) return
  saving.value = true
  error.value = ''
  try {
    await props.apply(result.value)
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
      aria-labelledby="generate-image-title"
      @cancel.prevent="close"
    >
      <form class="image-form" @submit.prevent="generate">
        <header class="image-head">
          <h2 id="generate-image-title">{{ title }}</h2>
          <button
            type="button"
            class="cbx-icon-btn"
            aria-label="关闭"
            :disabled="saving"
            @click="close"
          >
            <X :size="20" />
          </button>
        </header>
        <div class="image-body cbx-scroll">
          <p v-if="!settings.settings.imageModelServices.length" class="image-note">
            请先到<RouterLink to="/models" @click="close">模型管理添加文生图配置</RouterLink>。
          </p>
          <label v-else class="cbx-field">
            <span class="cbx-field__label">文生图配置</span>
            <select
              v-model="serviceId"
              class="cbx-input"
              aria-label="文生图配置"
              :disabled="busy || saving"
            >
              <option
                v-for="item in settings.settings.imageModelServices"
                :key="item.id"
                :value="item.id"
              >
                {{ item.name }} · {{ item.model }}
              </option>
            </select>
            <span class="cbx-field__hint"
              >{{ service?.size || '模型默认尺寸' }} ·
              {{ service?.quality || '模型默认画质' }}</span
            >
          </label>
          <section
            v-if="requireReferences || references?.length"
            class="reference-section"
            aria-label="角色参考图"
          >
            <span class="cbx-field__label">角色参考图</span>
            <div class="reference-list">
              <figure
                v-for="(reference, index) in references"
                :key="reference.characterId"
                class="reference-card"
              >
                <CbxAvatar :blob-id="reference.blobId" :name="`${reference.name}的参考图`" card />
                <figcaption>
                  图 {{ index + 1 }} · {{ reference.name
                  }}<span v-if="!reference.blobId">未设置封面</span>
                </figcaption>
              </figure>
            </div>
            <p v-if="referenceProblem" class="image-error" role="alert">
              {{ referenceProblem }}
              <RouterLink to="/characters" @click="close">管理角色</RouterLink>
            </p>
            <p v-else class="cbx-field__hint">
              使用这些封面保持人物一致性，请选择支持参考图的图片模型。
            </p>
          </section>
          <label class="cbx-field">
            <span class="cbx-field__label prompt-label">
              画面描述
              <button
                v-if="generatePrompt"
                type="button"
                class="cbx-btn cbx-btn--soft prompt-gen"
                :disabled="busy || saving || promptBusy"
                @click.stop="runGeneratePrompt"
              >
                <ImagePlus :size="14" />{{ promptBusy ? '生成中…' : 'AI 生成提示词' }}
              </button>
            </span>
            <textarea
              v-model="prompt"
              class="cbx-textarea"
              aria-label="画面描述"
              rows="8"
              maxlength="16000"
              required
              :disabled="busy || saving || promptBusy"
            />
            <span class="cbx-field__hint">{{
              generatePrompt
                ? '已由 AI 根据内容生成，可手动调整或点上方按钮重新生成。'
                : requireReferences
                  ? '已填入当前消息内容，可调整场景和动作后生成。'
                  : '已根据当前内容填入，可调整画风、构图或细节后生成。'
            }}</span>
          </label>
          <figure v-if="preview" class="preview">
            <img :src="preview" alt="生成图片预览" />
            <figcaption>{{ result?.serviceName }} · {{ result?.model }}</figcaption>
          </figure>
          <p v-if="error" class="image-error" role="alert">{{ error }}</p>
          <p v-if="status" class="image-note" role="status">{{ status }}</p>
        </div>
        <footer class="image-footer">
          <button v-if="busy" type="button" class="cbx-btn cbx-btn--soft" @click="cancel">
            取消生成
          </button>
          <button
            v-else
            type="button"
            class="cbx-btn cbx-btn--ghost"
            :disabled="saving"
            @click="close"
          >
            关闭
          </button>
          <div class="image-controls">
            <button
              type="submit"
              class="cbx-btn cbx-btn--soft"
              :disabled="busy || saving || !service || !prompt.trim() || !!referenceProblem"
            >
              <ImagePlus :size="16" />{{ busy ? '生成中…' : result ? '重新生成图片' : '生成图片' }}
            </button>
            <button
              v-if="result"
              type="button"
              class="cbx-btn cbx-btn--primary"
              :disabled="busy || saving"
              @click="apply"
            >
              {{ saving ? '保存中…' : applyLabel }}
            </button>
          </div>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped src="@/assets/styles/image-dialog.css"></style>
<style scoped>
.prompt-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.prompt-gen {
  padding: 2px 10px;
  min-height: 0;
  font-size: var(--cbx-fs-xs);
}
.reference-section {
  margin-bottom: 20px;
}
.reference-list {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.reference-card {
  margin: 0;
  width: 88px;
}
.reference-card :deep(.cbx-avatar) {
  width: 88px;
  height: 112px;
  object-fit: contain;
  background: var(--cbx-bg-secondary);
}
.reference-card figcaption {
  overflow-wrap: anywhere;
}
.reference-card span {
  display: block;
  color: var(--cbx-error);
}
.preview {
  margin: 0;
  text-align: center;
}
.preview img {
  display: block;
  max-width: 100%;
  max-height: 440px;
  margin: 0 auto;
  border-radius: var(--cbx-radius-sm);
  object-fit: contain;
}
figcaption {
  margin-top: 8px;
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-xs);
}
</style>
