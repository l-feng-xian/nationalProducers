<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { LoaderCircle, Sparkles, X } from '@/components/icons'
import { useSettingsStore } from '@/stores/settings'
import { generateCharacter, type GeneratedCharacterData } from '@/services/character/generate'
import { toPlain } from '@/utils/plain'

defineProps<{ hasContent: boolean }>()
const emit = defineEmits<{ close: []; generated: [data: GeneratedCharacterData] }>()
const description = defineModel<string>({ required: true })
const settings = useSettingsStore()
const dialog = ref<HTMLDialogElement | null>(null)
const busy = ref(false)
const error = ref('')
const status = ref('')
const serviceName = computed(
  () =>
    settings.settings.modelServices.find(
      (service) => service.id === settings.settings.activeModelServiceId,
    )?.name ?? '当前服务',
)
let controller: AbortController | null = null

onMounted(() => dialog.value?.showModal())
onBeforeUnmount(() => {
  controller?.abort()
  controller = null
  dialog.value?.close()
})

function cancel() {
  controller?.abort()
  controller = null
  busy.value = false
  status.value = '已取消生成'
}

function close() {
  cancel()
  emit('close')
}

async function generate() {
  if (busy.value || !description.value.trim() || !settings.isConfigured) return
  const ctl = new AbortController()
  controller = ctl
  busy.value = true
  error.value = ''
  status.value = '正在生成角色资料…'
  // 固定本次请求使用的配置与密钥引用，避免切换服务导致混用。
  const provider = toPlain(settings.settings.provider)
  const prompt = description.value
  try {
    const apiKey = await settings.getApiKey(provider.secretRef)
    ctl.signal.throwIfAborted()
    const data = await generateCharacter({
      description: prompt,
      provider,
      apiKey,
      signal: ctl.signal,
    })
    if (controller !== ctl || ctl.signal.aborted) return
    emit('generated', data)
  } catch (cause) {
    if (controller !== ctl || ctl.signal.aborted) return
    error.value = cause instanceof Error ? cause.message : String(cause)
    status.value = ''
  } finally {
    if (controller === ctl) {
      controller = null
      busy.value = false
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="ai-dialog"
      aria-labelledby="ai-character-title"
      @cancel.prevent="close"
    >
      <form class="ai-form" @submit.prevent="generate">
        <header class="ai-head">
          <h2 id="ai-character-title"><Sparkles :size="20" aria-hidden="true" />AI 创建角色</h2>
          <button type="button" class="cbx-icon-btn" aria-label="关闭" @click="close">
            <X :size="20" />
          </button>
        </header>
        <div class="ai-body cbx-scroll">
          <p v-if="settings.isConfigured" class="service-name">
            {{ serviceName }} · {{ settings.settings.provider.model }}
          </p>
          <p v-else class="configure-note">
            请先<RouterLink to="/models" @click="close">配置模型服务</RouterLink>，再生成角色。
          </p>
          <label class="cbx-field">
            <span class="cbx-field__label">描述你想创建的角色</span>
            <textarea
              v-model="description"
              class="cbx-textarea"
              rows="6"
              maxlength="3000"
              required
              autofocus
              :disabled="busy"
              placeholder="例如：一位经营深夜书店的年轻魔女，表面冷淡但很关心常客，喜欢收集城市里的奇闻。"
            />
          </label>
          <p class="fill-note">
            {{
              hasContent
                ? '生成后将替换当前基本信息、开场白和对话示例，可撤销填入。'
                : '生成角色名、简介、性格、场景、开场白和对话示例。'
            }}你可以继续修改后保存。
          </p>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <p v-else-if="status" class="status" role="status">{{ status }}</p>
        </div>
        <footer class="ai-footer">
          <button v-if="busy" type="button" class="cbx-btn cbx-btn--soft" @click="cancel">
            取消生成
          </button>
          <button v-else type="button" class="cbx-btn cbx-btn--ghost" @click="close">取消</button>
          <button
            type="submit"
            class="cbx-btn cbx-btn--primary"
            :disabled="busy || !description.trim() || !settings.isConfigured"
          >
            <LoaderCircle v-if="busy" :size="16" /><Sparkles v-else :size="16" />
            {{ busy ? '生成中…' : '生成并填入' }}
          </button>
        </footer>
      </form>
    </dialog>
  </Teleport>
</template>

<style scoped>
.ai-dialog {
  width: min(600px, calc(100vw - 24px));
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
.service-name,
.configure-note {
  margin: 0 0 16px;
  color: var(--cbx-text-secondary);
  font-size: var(--cbx-fs-sm);
  overflow-wrap: anywhere;
}
.fill-note,
.status,
.error {
  font-size: var(--cbx-fs-sm);
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.fill-note {
  margin: 0;
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
.ai-footer {
  border-top: 1px solid var(--cbx-border);
}

@media (max-width: 767px) {
  .ai-head,
  .ai-body,
  .ai-footer {
    padding: 12px;
  }
}
</style>
