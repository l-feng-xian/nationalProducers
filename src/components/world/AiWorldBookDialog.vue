<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { LoaderCircle, Sparkles } from '@/components/icons'
import { useBackClose } from '@/composables/useBackClose'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import { useSettingsStore } from '@/stores/settings'
import { useCharactersStore } from '@/stores/characters'
import { useWorldsStore } from '@/stores/worlds'
import {
  generateWorldBook,
  toWorldEntry,
  type GeneratedWorldBook,
  type WorldGenMode,
} from '@/services/worldinfo/generate'
import { toPlain } from '@/utils/plain'

/**
 * AI 生成世界书。
 *  - 角色世界书：选一个角色，用它的基础信息 + 补充描述生成；保存后自动关联到该角色
 *  - 全局世界书：只用描述生成；新建时可顺手设为全局启用
 * 生成结果先预览、勾选，再落库。可以新建一本，也可以追加到当前打开的那本（会避开已有条目）。
 */
const props = defineProps<{ currentBookId?: string | undefined }>()
const emit = defineEmits<{ close: []; done: [bookId: string] }>()
const settings = useSettingsStore()
const chars = useCharactersStore()
const worlds = useWorldsStore()

const dialog = ref<HTMLDialogElement | null>(null)
const mode = ref<WorldGenMode>('character')
const characterId = ref('')
const description = ref('')
const target = ref<'new' | 'append'>(props.currentBookId ? 'append' : 'new')
const makeGlobal = ref(true)
const busy = ref(false)
const saving = ref(false)
const error = ref('')
const result = ref<GeneratedWorldBook | null>(null)
const picked = ref<boolean[]>([])
let controller: AbortController | null = null

const currentBook = computed(() => worlds.byId(props.currentBookId))
const character = computed(() => chars.byId(characterId.value))
const pickedCount = computed(() => picked.value.filter(Boolean).length)
const canGenerate = computed(
  () =>
    settings.isConfigured &&
    !busy.value &&
    (mode.value === 'character' ? !!character.value : !!description.value.trim()),
)
/** 追加时把已有条目标题告诉模型，避免重复 */
const existingTitles = computed(() =>
  target.value === 'append' && currentBook.value
    ? Object.values(currentBook.value.entries)
        .map((e) => e.comment || e.key[0] || '')
        .filter(Boolean)
    : [],
)

// 换了模式 / 目标，旧的预览就不作数了
watch([mode, characterId, target], () => {
  result.value = null
  picked.value = []
  error.value = ''
})

onMounted(() => {
  dialog.value?.showModal()
  if (!chars.loaded) void chars.load()
  if (!worlds.loaded) void worlds.load()
})
onBeforeUnmount(() => {
  controller?.abort()
  controller = null
  dialog.value?.close()
})

function cancel() {
  controller?.abort()
  controller = null
  busy.value = false
}
function close() {
  if (saving.value) return
  cancel()
  emit('close')
}
// 手机上是整页：返回键 = 关闭
useBackClose(close)
async function generate() {
  if (!canGenerate.value) return
  const ctl = new AbortController()
  controller = ctl
  busy.value = true
  error.value = ''
  result.value = null
  // 固定本次请求使用的配置，避免中途切换服务导致混用
  const provider = toPlain(settings.settings.provider)
  try {
    const apiKey = await settings.getApiKey(provider.secretRef)
    ctl.signal.throwIfAborted()
    const data = await generateWorldBook({
      mode: mode.value,
      description: description.value,
      ...(mode.value === 'character' && character.value
        ? { character: toPlain(character.value) }
        : {}),
      existingTitles: existingTitles.value,
      provider,
      apiKey,
      signal: ctl.signal,
    })
    if (controller !== ctl || ctl.signal.aborted) return
    result.value = data
    picked.value = data.entries.map(() => true)
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

function defaultName(): string {
  if (result.value?.name) return result.value.name
  if (mode.value === 'character' && character.value) return `${character.value.data.name}的世界`
  return '新世界书'
}

async function save() {
  const r = result.value
  if (!r || saving.value || !pickedCount.value) return
  saving.value = true
  error.value = ''
  try {
    const chosen = r.entries.filter((_, i) => picked.value[i])
    const book =
      target.value === 'append' && currentBook.value
        ? currentBook.value
        : await worlds.create(defaultName())
    let uid = Math.max(-1, ...Object.values(book.entries).map((e) => e.uid)) + 1
    for (const g of chosen) {
      book.entries[String(uid)] = toWorldEntry(g, uid)
      uid++
    }
    await worlds.save(book)

    // 角色世界书：关联到角色（已关联就不重复加）
    if (mode.value === 'character' && character.value) {
      const c = character.value
      if (!c.worldBookIds.includes(book.id)) {
        await chars.save({ ...toPlain(c), worldBookIds: [...c.worldBookIds, book.id] })
      }
    } else if (target.value === 'new' && makeGlobal.value) {
      const list = settings.settings.worldInfo.globalBookIds
      if (!list.includes(book.id)) {
        list.push(book.id)
        settings.touch()
      }
    }
    emit('done', book.id)
  } catch (cause) {
    error.value = `保存失败：${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="ai-dialog cbx-page"
      aria-labelledby="ai-world-title"
      @cancel.prevent="close"
    >
      <form class="ai-form" @submit.prevent="result ? save() : generate()">
        <header class="ai-head cbx-page-head">
          <h2 id="ai-world-title"><Sparkles :size="20" aria-hidden="true" />AI 生成世界书</h2>
          <CbxDialogClose :disabled="saving" @click="close" />
        </header>
        <div class="ai-body cbx-scroll cbx-page-body">
          <p v-if="!settings.isConfigured" class="configure-note">
            请先<RouterLink to="/models" @click="close">配置模型服务</RouterLink>，再生成世界书。
          </p>

          <div class="seg" role="radiogroup" aria-label="世界书类型">
            <label class="seg__opt" :class="{ 'seg__opt--on': mode === 'character' }">
              <input v-model="mode" type="radio" value="character" :disabled="busy" />
              角色世界书
            </label>
            <label class="seg__opt" :class="{ 'seg__opt--on': mode === 'global' }">
              <input v-model="mode" type="radio" value="global" :disabled="busy" />
              全局世界书
            </label>
          </div>
          <p class="fill-note">
            {{
              mode === 'character'
                ? '以所选角色的简介、性格、场景为基础，结合下方描述，生成这个角色所处的世界（地点、组织、身边人物、经历等）。保存后自动关联到该角色。'
                : '只根据下方描述生成通用的世界观设定，可被多个角色共用。'
            }}
          </p>

          <label v-if="mode === 'character'" class="cbx-field">
            <span class="cbx-field__label">关联角色</span>
            <CbxSelect
              v-model="characterId"
              :options="chars.items.map((c) => ({ value: c.id, label: c.data.name }))"
              label="关联角色"
              placeholder="请选择角色"
              :disabled="busy"
            />
            <span v-if="!chars.items.length" class="cbx-field__hint"
              >还没有角色，请先创建角色。</span
            >
          </label>

          <label class="cbx-field">
            <span class="cbx-field__label">{{
              mode === 'character' ? '补充描述（可选）' : '描述你想要的世界观'
            }}</span>
            <textarea
              v-model="description"
              class="cbx-textarea"
              rows="5"
              maxlength="3000"
              :disabled="busy"
              :placeholder="
                mode === 'character'
                  ? '例如：重点写她常去的港口酒馆、所属的佣兵公会，以及三个老熟人。'
                  : '例如：蒸汽朋克风格的浮空城邦，贵族靠以太晶石统治，地面是被遗弃的废土。'
              "
            />
          </label>

          <div class="cbx-field">
            <span class="cbx-field__label">保存到</span>
            <div class="seg" role="radiogroup" aria-label="保存到">
              <label class="seg__opt" :class="{ 'seg__opt--on': target === 'new' }">
                <input v-model="target" type="radio" value="new" :disabled="busy || saving" />
                新建一本
              </label>
              <label
                v-if="currentBook"
                class="seg__opt"
                :class="{ 'seg__opt--on': target === 'append' }"
              >
                <input v-model="target" type="radio" value="append" :disabled="busy || saving" />
                追加到「{{ currentBook.name }}」
              </label>
            </div>
          </div>
          <label v-if="mode === 'global' && target === 'new'" class="cbx-switch swopt">
            <input v-model="makeGlobal" type="checkbox" :disabled="saving" />
            <span class="cbx-switch__track" />
            <span>保存后设为全局启用</span>
          </label>

          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <p v-else-if="busy" class="status" role="status">正在生成条目，可能需要几十秒…</p>

          <!-- 预览：勾选要保存的条目 -->
          <div v-if="result" class="preview">
            <div class="preview__head">
              <span>生成了 {{ result.entries.length }} 条，已选 {{ pickedCount }} 条</span>
              <button
                type="button"
                class="cbx-btn cbx-btn--ghost sm"
                @click="picked = picked.map(() => pickedCount < picked.length)"
              >
                {{ pickedCount < picked.length ? '全选' : '全不选' }}
              </button>
            </div>
            <label
              v-for="(g, i) in result.entries"
              :key="i"
              class="item"
              :class="{ 'item--off': !picked[i] }"
            >
              <input v-model="picked[i]" type="checkbox" :disabled="saving" />
              <span class="item__main">
                <span class="item__title">
                  {{ g.title }}
                  <span v-if="g.constant" class="cbx-badge cbx-badge--warning">常驻</span>
                  <span v-else class="item__keys">{{ g.keys.join(' / ') }}</span>
                </span>
                <span class="item__body">{{ g.content }}</span>
              </span>
            </label>
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
            :disabled="saving || !canGenerate"
            @click="generate"
          >
            重新生成
          </button>
          <button v-else type="button" class="cbx-btn cbx-btn--ghost" @click="close">取消</button>
          <button
            v-if="result"
            type="submit"
            class="cbx-btn cbx-btn--primary"
            :disabled="saving || busy || !pickedCount"
          >
            <LoaderCircle v-if="saving" :size="16" />
            {{ saving ? '保存中…' : `保存 ${pickedCount} 条` }}
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
  padding: 20px;
  min-height: 0;
}
.ai-footer {
  border-top: 1px solid var(--cbx-border);
}
.configure-note {
  margin: 0 0 16px;
  color: var(--cbx-text-secondary);
  font-size: var(--cbx-fs-sm);
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
  max-width: 100%;
  overflow-wrap: anywhere;
}
.seg__opt--on {
  border-color: var(--cbx-brand);
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
.fill-note,
.status,
.error {
  font-size: var(--cbx-fs-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.fill-note {
  margin: 8px 0 16px;
  color: var(--cbx-text-tertiary);
}
.status {
  margin: 12px 0 0;
  color: var(--cbx-text-secondary);
}
.error {
  margin: 12px 0 0;
  color: var(--cbx-error);
}
.swopt {
  gap: 8px;
  font-size: var(--cbx-fs-sm);
  margin-bottom: 8px;
}
.preview {
  margin-top: 16px;
  border-top: 1px solid var(--cbx-border);
  padding-top: 12px;
}
.preview__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
}
.sm {
  height: 30px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  margin-bottom: 8px;
  cursor: pointer;
}
.item input {
  margin-top: 3px;
  flex-shrink: 0;
}
.item--off {
  opacity: 0.5;
}
.item__main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.item__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-weight: var(--cbx-fw-medium);
  font-size: var(--cbx-fs-sm);
}
.item__keys {
  font-weight: var(--cbx-fw-normal);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.item__body {
  font-size: var(--cbx-fs-xs);
  line-height: 1.6;
  color: var(--cbx-text-secondary);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 767px) {
  .ai-head,
  .ai-body,
  .ai-footer {
    padding: 12px;
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
