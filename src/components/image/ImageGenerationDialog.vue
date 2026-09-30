<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { ChevronLeft, ChevronRight, ImagePlus, Minus, X, ZoomIn } from '@/components/icons'
import AppIcon from '@/components/icons/AppIcon.vue'
import { useBackClose } from '@/composables/useBackClose'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import { useSettingsStore } from '@/stores/settings'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { blobsRepo } from '@/db/repositories'
import { generateImage } from '@/services/image/generate'
import { maxReferencesFor } from '@/services/image/limits'
import { useImagePreview } from '@/composables/useImagePreview'
import { toPlain } from '@/utils/plain'
import type { GeneratedImage, ImageRefCandidate, ImageReferenceInput } from '@/types/image'

const props = defineProps<{
  title: string
  /** 没有 buildPrompt 时的初始提示词 */
  initialPrompt?: string
  applyLabel: string
  apply: (image: GeneratedImage) => Promise<void>
  /** 可选参考图池：角色 / 成员封面、演绎封面、本会话历史配图 */
  candidates?: ImageRefCandidate[]
  /** 默认选中的候选 id，顺序即参考图顺序 */
  defaultSelected?: string[]
  /** 至少要选一张参考图（对话配图：没有参考图人物长相无从锚定） */
  requireReferences?: boolean
  /**
   * 模板提示词。提供时：初始提示词由它按默认选择生成；用户**没手改过**提示词时，
   * 改动参考图选择会自动重建，编号说明才跟得上选择。
   */
  buildPrompt?: (refs: ImageRefCandidate[]) => string
  /** 提供时：用已配置的 LLM 生成画面提示词。打开即自动跑一次，也可点按钮重生成。 */
  generatePrompt?: (signal: AbortSignal, refs: ImageRefCandidate[]) => Promise<string>
  /** 覆盖服务默认尺寸（演绎封面要横版）；ComfyUI 忽略 */
  size?: string
  /**
   * 允许最小化：生成期间收成一个小进度条，不挡着继续聊天。
   * 最小化状态下生成完成会**自动调用 apply 保存**（用户此刻不在对话框里，没法点确认），
   * 由调用方在 apply 里弹「可点击定位」的提示。
   */
  minimizable?: boolean
  /** v-model:minimized */
  minimized?: boolean
}>()
const emit = defineEmits<{ close: []; 'update:minimized': [value: boolean] }>()
const settings = useSettingsStore()
const dialog = ref<HTMLDialogElement | null>(null)
const serviceOptions = computed(() =>
  settings.settings.imageModelServices.map((item) => ({
    value: item.id,
    label: `${item.name} · ${item.model}`,
  })),
)
const serviceId = ref(
  settings.activeImageService?.id ?? settings.settings.imageModelServices[0]?.id ?? '',
)
const service = computed(() =>
  settings.settings.imageModelServices.find((item) => item.id === serviceId.value),
)
// ── 参考图选择 ──
const pool = computed(() => props.candidates ?? [])
const maxRefs = computed(() => maxReferencesFor(service.value))
const selectedIds = ref<string[]>(
  (props.defaultSelected ?? []).filter((id) => pool.value.some((c) => c.id === id)),
)
const selected = computed(() =>
  selectedIds.value
    .map((id) => pool.value.find((c) => c.id === id))
    .filter((c): c is ImageRefCandidate => !!c),
)
const refNotice = ref('')
// 换到上限更低的服务（ComfyUI 3 张）：截断并说一声
watch(
  maxRefs,
  (max) => {
    if (selectedIds.value.length <= max) return
    selectedIds.value = selectedIds.value.slice(0, max)
    refNotice.value = `当前配置最多使用 ${max} 张参考图，已保留前 ${max} 张。`
  },
  { immediate: true },
)
const groups = computed(() =>
  (
    [
      ['character', '角色封面'],
      ['group', '演绎封面'],
      ['history', '历史配图'],
    ] as const
  )
    .map(([kind, label]) => ({ kind, label, items: pool.value.filter((c) => c.kind === kind) }))
    .filter((g) => g.items.length),
)
const pickerOpen = ref(false)
function isSelected(c: ImageRefCandidate) {
  return selectedIds.value.includes(c.id)
}
function toggleRef(c: ImageRefCandidate) {
  refNotice.value = ''
  if (isSelected(c)) selectedIds.value = selectedIds.value.filter((id) => id !== c.id)
  else if (selectedIds.value.length < maxRefs.value)
    selectedIds.value = [...selectedIds.value, c.id]
}
function clearRefs() {
  selectedIds.value = []
  refNotice.value = ''
}
function moveRef(index: number, delta: -1 | 1) {
  const j = index + delta
  if (j < 0 || j >= selectedIds.value.length) return
  const next = [...selectedIds.value]
  ;[next[index], next[j]] = [next[j]!, next[index]!]
  selectedIds.value = next
}
function togglePicker() {
  pickerOpen.value = !pickerOpen.value
}
const imagePreview = useImagePreview()
/** 已选参考图连成一组预览（跳过还没设封面的） */
function previewSelected(c: ImageRefCandidate, e: MouseEvent) {
  const withImage = selected.value.filter((x) => x.blobId)
  const items = withImage.map((x) => ({
    blobId: x.blobId,
    caption: `参考图 ${selected.value.indexOf(x) + 1} · ${x.label}`,
  }))
  void imagePreview.open(
    items,
    withImage.indexOf(c),
    (e.currentTarget as HTMLElement).querySelector('img'),
  )
}
function previewCandidate(c: ImageRefCandidate, e: MouseEvent) {
  if (!c.blobId) return
  const img = (e.currentTarget as HTMLElement).closest('.ref-cand')?.querySelector('img')
  void imagePreview.open([{ blobId: c.blobId, caption: c.label }], 0, img)
}

// ── 提示词 ──
/** 最近一次「自动」得出的提示词（模板或 AI）。与之不同 = 用户手改过，选择变化时不再覆盖 */
const autoPrompt = ref(
  props.buildPrompt ? props.buildPrompt(selected.value) : (props.initialPrompt ?? ''),
)
const prompt = ref(autoPrompt.value)
const promptStale = ref(false)
watch(selectedIds, () => {
  if (!props.buildPrompt) return
  if (prompt.value === autoPrompt.value) {
    autoPrompt.value = props.buildPrompt(selected.value)
    prompt.value = autoPrompt.value
    promptStale.value = false
  } else promptStale.value = true
})

const referenceProblem = computed(() => {
  if (props.requireReferences && !selected.value.length)
    return pool.value.length
      ? '请至少选择一张参考图，用来锁定人物长相。'
      : '当前对话尚未关联角色，请先选择带有封面图片的角色。'
  const missing = selected.value.filter((c) => !c.blobId)
  return missing.length
    ? `请先为「${missing.map((c) => c.name).join('、')}」设置角色封面，或取消选择它。`
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
  if (!props.minimized) dialog.value?.showModal()
  // 打开即用 LLM 生成一版提示词（可编辑、可重生成）；未提供则沿用传入的初始提示词
  if (props.generatePrompt) void runGeneratePrompt()
})
onBeforeUnmount(() => {
  disposed = true
  controller?.abort()
  promptController?.abort()
  if (preview.value) URL.revokeObjectURL(preview.value)
  if (elapsedTimer) clearInterval(elapsedTimer)
  dialog.value?.close()
})

// ── 最小化 ──
// 收起 = 关掉模态 <dialog>（页面恢复可交互），组件本身不卸载，生成请求照常进行
watch(
  () => props.minimized,
  (min) => {
    const d = dialog.value
    if (!d) return
    if (min && d.open) d.close()
    else if (!min && !d.open) d.showModal()
  },
  { flush: 'post' },
)
function minimize() {
  emit('update:minimized', true)
}
function restore() {
  emit('update:minimized', false)
}
function cancelFromPill() {
  cancel()
  emit('close')
}
/** 进度条上的已用时间 */
const elapsed = ref(0)
let elapsedTimer: ReturnType<typeof setInterval> | null = null
watch(busy, (b) => {
  if (elapsedTimer) clearInterval(elapsedTimer)
  elapsedTimer = null
  if (!b) return
  const t0 = Date.now()
  elapsed.value = 0
  elapsedTimer = setInterval(() => (elapsed.value = Math.round((Date.now() - t0) / 1000)), 1000)
})
const pillText = computed(() =>
  busy.value
    ? `正在生成配图… ${elapsed.value}s`
    : saving.value
      ? '正在保存配图…'
      : error.value
        ? '配图生成失败'
        : result.value
          ? '配图已生成'
          : '生成配图',
)

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
    const text = await props.generatePrompt(ctl.signal, toPlain(selected.value))
    if (disposed || ctl.signal.aborted) return
    if (text.trim()) {
      prompt.value = text.trim()
      autoPrompt.value = prompt.value
      promptStale.value = false
    }
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
// 手机上是整页：返回键 = 关闭。最小化时不占历史层（返回键交还给页面）
useBackClose(close, () => !props.minimized)
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
  const referenceSnapshot = toPlain(selected.value)
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
      if (!blob)
        throw new Error(
          reference.kind === 'history'
            ? `无法读取参考图「${reference.label}」，它可能已被删除，请取消选择后再试`
            : `无法读取「${reference.name}」的角色封面，请重新设置封面后再试`,
        )
      references.push({ name: reference.name, blob })
    }
    const apiKey = await settings.getApiKey(snapshot.secretRef)
    ctl.signal.throwIfAborted()
    const image = await generateImage({
      service: snapshot,
      apiKey,
      prompt: text,
      references,
      ...(props.size ? { size: props.size } : {}),
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
    // 最小化期间用户在做别的事：直接保存，由 apply 那边弹可点击的提示
    if (props.minimized) queueMicrotask(() => void apply())
  } catch (cause) {
    if (disposed || controller !== ctl || ctl.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : String(cause)
    status.value = ''
    // 失败不另弹提示：最小化进度条本身变成红色「生成失败 · 展开」，两者叠在顶部会互相遮挡
  } finally {
    if (controller === ctl) {
      controller = null
      busy.value = false
    }
  }
}
function openResult(e: MouseEvent) {
  if (!preview.value) return
  const caption = `${result.value?.serviceName ?? ''} · ${result.value?.model ?? ''}`
  const img = (e.currentTarget as HTMLElement).querySelector('img')
  void imagePreview.open([{ url: preview.value, caption }], 0, img)
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
      class="image-dialog cbx-page"
      aria-labelledby="generate-image-title"
      @cancel.prevent="close"
    >
      <form class="image-form" @submit.prevent="generate">
        <header class="image-head cbx-page-head">
          <h2 id="generate-image-title">{{ title }}</h2>
          <CbxDialogClose :disabled="saving" @click="close" />
        </header>
        <div class="image-body cbx-scroll cbx-page-body">
          <p v-if="!settings.settings.imageModelServices.length" class="image-note">
            请先到<RouterLink to="/models" @click="close">模型管理添加文生图配置</RouterLink>。
          </p>
          <label v-else class="cbx-field">
            <span class="cbx-field__label">文生图配置</span>
            <CbxSelect
              v-model="serviceId"
              :options="serviceOptions"
              label="文生图配置"
              :disabled="busy || saving"
            />
            <span class="cbx-field__hint"
              >{{ service?.size || '模型默认尺寸' }} ·
              {{ service?.quality || '模型默认画质' }}</span
            >
          </label>
          <section
            v-if="requireReferences || pool.length"
            class="reference-section"
            aria-label="参考图"
          >
            <div class="reference-head">
              <span class="cbx-field__label"
                >参考图 <span class="ref-count">{{ selected.length }} / {{ maxRefs }}</span></span
              >
              <div class="reference-head__tools">
                <span class="reference-head__hint">
                  {{
                    selected.length
                      ? '点击图片可预览，使用箭头调整顺序'
                      : '先选择一张图片锁定人物或场景'
                  }}
                </span>
                <button
                  v-if="selected.length"
                  type="button"
                  class="ref-clear"
                  :disabled="busy"
                  @click="clearRefs"
                >
                  清空
                </button>
              </div>
            </div>
            <ol v-if="selected.length" class="ref-list">
              <li v-for="(c, index) in selected" :key="c.id" class="ref-card">
                <button
                  type="button"
                  class="ref-thumb"
                  :aria-label="`预览参考图 ${index + 1}`"
                  :disabled="!c.blobId"
                  @click="previewSelected(c, $event)"
                >
                  <CbxAvatar :blob-id="c.blobId" :name="`${c.name}的参考图`" card />
                </button>
                <span class="ref-cap"
                  >图 {{ index + 1 }} · {{ c.label
                  }}<span v-if="!c.blobId" class="ref-missing">未设置封面</span></span
                >
                <span class="ref-ops">
                  <button
                    type="button"
                    class="ref-op"
                    :aria-label="`把参考图 ${index + 1} 前移`"
                    :disabled="index === 0 || busy"
                    @click="moveRef(index, -1)"
                  >
                    <ChevronLeft :size="14" />
                  </button>
                  <button
                    type="button"
                    class="ref-op"
                    :aria-label="`移除参考图 ${index + 1}`"
                    :disabled="busy"
                    @click="toggleRef(c)"
                  >
                    <X :size="14" />
                  </button>
                  <button
                    type="button"
                    class="ref-op"
                    :aria-label="`把参考图 ${index + 1} 后移`"
                    :disabled="index === selected.length - 1 || busy"
                    @click="moveRef(index, 1)"
                  >
                    <ChevronRight :size="14" />
                  </button>
                </span>
              </li>
            </ol>
            <p v-else class="cbx-field__hint">还没有选择参考图。</p>

            <div v-if="pool.length" class="cbx-collapse ref-picker">
              <button
                type="button"
                class="cbx-collapse__head"
                :aria-expanded="pickerOpen"
                @click="togglePicker"
              >
                添加 / 更换参考图<span class="ref-hint">封面、演绎封面与本会话的历史配图</span>
              </button>
              <div v-if="pickerOpen" class="cbx-collapse__body">
                <div v-for="g in groups" :key="g.kind" class="ref-group">
                  <span class="ref-group__title">{{ g.label }}</span>
                  <div class="ref-grid">
                    <div
                      v-for="c in g.items"
                      :key="c.id"
                      class="ref-cand"
                      :class="{ 'ref-cand--on': isSelected(c) }"
                    >
                      <button
                        type="button"
                        class="ref-cand__pick"
                        :aria-pressed="isSelected(c)"
                        :aria-label="`${isSelected(c) ? '取消选择' : '选择'} ${c.label}`"
                        :disabled="busy || (!isSelected(c) && selected.length >= maxRefs)"
                        @click="toggleRef(c)"
                      >
                        <CbxAvatar :blob-id="c.blobId" :name="c.name" card />
                        <span class="ref-cand__badge" aria-hidden="true">{{
                          isSelected(c) ? selectedIds.indexOf(c.id) + 1 : '+'
                        }}</span>
                        <span class="ref-cand__cap">{{ c.label }}</span>
                      </button>
                      <button
                        v-if="c.blobId"
                        type="button"
                        class="ref-cand__zoom"
                        :aria-label="`预览 ${c.label}`"
                        @click="previewCandidate(c, $event)"
                      >
                        <ZoomIn :size="14" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <p v-if="referenceProblem" class="image-error" role="alert">
              {{ referenceProblem }}
              <RouterLink to="/characters" @click="close">管理角色</RouterLink>
            </p>
            <p v-else-if="refNotice" class="cbx-field__hint">{{ refNotice }}</p>
            <p v-else class="cbx-field__hint">
              按顺序作为「参考图
              1、2……」发送，用来保持人物长相、延续场景与服装。请选择支持参考图的图片模型。
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
            <span v-if="promptStale" class="cbx-field__hint">
              参考图已变化，提示词里的「参考图 N」编号可能对不上，可点「AI 生成提示词」重新生成。
            </span>
            <span v-else class="cbx-field__hint">{{
              generatePrompt
                ? '已由 AI 根据内容生成，可手动调整或点上方按钮重新生成。'
                : requireReferences
                  ? '已填入当前消息内容，可调整场景和动作后生成。'
                  : '已根据当前内容填入，可调整画风、构图或细节后生成。'
            }}</span>
          </label>
          <figure v-if="preview" class="preview">
            <button
              type="button"
              class="preview__btn"
              aria-label="放大查看生成结果"
              @click="openResult"
            >
              <img :src="preview" alt="生成图片预览" />
            </button>
            <figcaption>{{ result?.serviceName }} · {{ result?.model }}</figcaption>
          </figure>
          <p v-if="error" class="image-error" role="alert">{{ error }}</p>
          <p v-if="status" class="image-note" role="status">{{ status }}</p>
        </div>
        <footer class="image-footer cbx-page-foot">
          <span v-if="busy" class="image-controls">
            <button type="button" class="cbx-btn cbx-btn--soft" @click="cancel">取消生成</button>
            <button
              v-if="minimizable"
              type="button"
              class="cbx-btn cbx-btn--ghost min-btn"
              title="收起到聊天页顶部，继续聊天；生成完成后自动保存并提示"
              @click="minimize"
            >
              <Minus :size="16" />最小化
            </button>
          </span>
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

  <!-- 最小化后的进度条：浮在顶栏下方，任何页面都看得到，不挡输入框与底部标签栏 -->
  <Teleport v-if="minimized" to="body">
    <div class="gen-pill" :class="{ 'gen-pill--error': !!error && !busy }" role="status">
      <AppIcon
        :name="busy || saving ? 'LoaderCircle' : error ? 'TriangleAlert' : 'Check'"
        :size="16"
        :class="{ 'gen-pill__spin': busy || saving }"
      />
      <span class="gen-pill__text">{{ pillText }}</span>
      <button type="button" class="gen-pill__btn" @click="restore">展开</button>
      <button v-if="busy" type="button" class="gen-pill__btn" @click="cancelFromPill">取消</button>
    </div>
  </Teleport>
</template>

<style scoped src="@/assets/styles/image-dialog.css"></style>
<style scoped>
/*
 * 最小化 = dialog.close()。浏览器靠 UA 样式 dialog:not([open]){display:none} 藏起关着的 dialog，
 * 但手机上的整页规则（base.css `:root .cbx-page.cbx-page`）写了 display —— 作者样式压过 UA 样式，
 * 关着的对话框照样铺满全屏、吞掉所有点击（桌面没这条规则，所以只在手机上坏）。
 */
.image-dialog:not([open]) {
  display: none !important;
}
.min-btn {
  gap: 4px;
}
.gen-pill {
  position: fixed;
  top: calc(var(--cbx-topbar-h) + var(--cbx-space-3) + env(safe-area-inset-top, 0px));
  left: 50%;
  z-index: 150;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  max-width: calc(100% - 24px);
  padding: 4px 6px 4px var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg);
  box-shadow: var(--cbx-shadow-md);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text);
  white-space: nowrap;
}
.gen-pill--error {
  border-color: var(--cbx-error);
}
.gen-pill--error svg {
  color: var(--cbx-error);
}
.gen-pill__text {
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.gen-pill__spin {
  color: var(--cbx-brand);
  animation: gen-spin 1s linear infinite;
}
@keyframes gen-spin {
  to {
    transform: rotate(360deg);
  }
}
.gen-pill__btn {
  min-height: 32px;
  padding: 0 var(--cbx-space-3);
  border: 0;
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-brand-subtle);
  color: var(--cbx-brand);
  font: inherit;
  cursor: pointer;
}
@media (max-width: 767px) {
  .gen-pill__btn {
    min-height: var(--cbx-tap-min);
  }
}
@media (prefers-reduced-motion: reduce) {
  .gen-pill__spin {
    animation: none;
  }
}
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
.reference-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 32px;
}
.reference-head__tools {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.reference-head__hint {
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-xs);
  text-align: right;
}
.ref-clear {
  flex: 0 0 auto;
  min-height: 30px;
  padding: 2px 10px;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg);
  color: var(--cbx-text-secondary);
  font: inherit;
  font-size: var(--cbx-fs-xs);
  cursor: pointer;
}
.ref-clear:hover {
  border-color: var(--cbx-brand);
  color: var(--cbx-brand);
}
.ref-clear:disabled {
  opacity: 0.5;
  cursor: default;
}
.ref-count {
  margin-left: 4px;
  font-weight: var(--cbx-fw-normal);
  color: var(--cbx-text-tertiary);
}
.ref-list {
  display: flex;
  gap: 12px;
  margin: 8px 0 12px;
  padding: 0 2px 6px;
  list-style: none;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
}
.ref-card {
  flex: 0 0 108px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  scroll-snap-align: start;
}
.ref-thumb {
  padding: 0;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg-secondary);
  cursor: zoom-in;
  overflow: hidden;
  transition:
    border-color var(--cbx-transition),
    box-shadow var(--cbx-transition);
}
.ref-thumb:hover,
.ref-thumb:focus-visible {
  border-color: var(--cbx-brand);
  box-shadow: 0 0 0 3px var(--cbx-brand-subtle);
  outline: none;
}
.ref-thumb:disabled {
  cursor: default;
}
.ref-thumb :deep(.cbx-avatar),
.ref-cand__pick :deep(.cbx-avatar) {
  width: 100%;
  height: auto;
  aspect-ratio: 3 / 4;
  object-fit: contain;
  background: var(--cbx-bg-secondary);
}
.ref-cap {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.ref-missing {
  display: block;
  color: var(--cbx-error);
}
.ref-ops {
  display: flex;
  justify-content: space-between;
}
.ref-op {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg);
  color: var(--cbx-text-secondary);
  cursor: pointer;
}
.ref-op:disabled {
  opacity: 0.4;
  cursor: default;
}
.ref-picker {
  margin: 10px 0 12px;
}
.ref-picker .cbx-collapse__head {
  min-height: 48px;
}
.ref-hint {
  margin-left: auto;
  font-size: var(--cbx-fs-xs);
  font-weight: var(--cbx-fw-normal);
  color: var(--cbx-text-tertiary);
}
.ref-group + .ref-group {
  margin-top: 12px;
}
.ref-group__title {
  display: block;
  margin-bottom: 6px;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.ref-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
  gap: 10px;
}
.ref-cand {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 4px;
  border: 1px solid transparent;
  border-radius: var(--cbx-radius-md);
  transition:
    background var(--cbx-transition),
    border-color var(--cbx-transition);
}
.ref-cand:hover {
  background: var(--cbx-bg-hover);
}
.ref-cand--on {
  border-color: var(--cbx-brand-light-hover);
  background: var(--cbx-brand-subtle);
}
.ref-cand__pick {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0;
  border: 2px solid transparent;
  border-radius: var(--cbx-radius-md);
  background: none;
  cursor: pointer;
  overflow: hidden;
  transition:
    box-shadow var(--cbx-transition),
    border-color var(--cbx-transition);
}
.ref-cand--on .ref-cand__pick {
  border-color: var(--cbx-brand);
  box-shadow: 0 0 0 2px var(--cbx-brand-subtle);
}
.ref-cand__pick:hover,
.ref-cand__pick:focus-visible {
  border-color: var(--cbx-brand);
  outline: none;
}
.ref-cand__pick:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.ref-cand__badge {
  position: absolute;
  top: 4px;
  left: 4px;
  min-width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  padding: 0 4px;
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg);
  color: var(--cbx-text-secondary);
  font-size: var(--cbx-fs-xs);
  box-shadow: var(--cbx-shadow-xs);
}
.ref-cand--on .ref-cand__badge {
  background: var(--cbx-brand);
  color: var(--cbx-text-on-brand);
}
.ref-cand__cap {
  display: block;
  min-height: 2.8em;
  padding: 0 2px;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.ref-cand__zoom {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  cursor: zoom-in;
}
.preview__btn {
  display: block;
  margin: 0 auto;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
}
@media (max-width: 767px) {
  .reference-head {
    align-items: flex-start;
  }
  .reference-head__hint {
    display: none;
  }
  .ref-card {
    flex-basis: 112px;
  }
  .ref-op,
  .ref-cand__zoom {
    width: 36px;
    height: 36px;
  }
  .ref-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .ref-cand {
    padding: 3px;
  }
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
