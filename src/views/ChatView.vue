<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ImagePlus, MessageCircle, Plus, ScanText, UsersRound } from 'lucide-vue-next'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import MessageBubble from '@/components/chat/MessageBubble.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import PromptPreview from '@/components/chat/PromptPreview.vue'
import ImageGenerationDialog from '@/components/image/ImageGenerationDialog.vue'
import { dialogueImagePrompt } from '@/services/image/prompts'
import type { CharacterImageReference, GeneratedImage } from '@/types/image'
import { useChatsStore } from '@/stores/chats'
import { useCharactersStore } from '@/stores/characters'
import { useGroupsStore } from '@/stores/groups'
import { useSettingsStore } from '@/stores/settings'
import { useGenerationStore } from '@/stores/generation'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { useToast } from '@/composables/useToast'
import { messagesRepo } from '@/db/repositories'
import { accentOf } from '@/utils/charAccent'
import { confirmDialog } from '@/composables/useConfirm'

const route = useRoute()
const router = useRouter()
const chats = useChatsStore()
const chars = useCharactersStore()
const groups = useGroupsStore()
const settings = useSettingsStore()
const gen = useGenerationStore()
const toast = useToast()
const imageTarget = ref<{
  chatId: string
  messageId: string
  prompt: string
  references: CharacterImageReference[]
} | null>(null)
const canGenerateImage = computed(() =>
  chats.messages.some((m) => !m.is_system && !m.exclude && m.mes.trim()),
)

function openImage(messageId?: string) {
  if (!chats.current || gen.busy) return
  const rows = chats.messages
  const target = messageId
    ? rows.find((m) => m.id === messageId)
    : [...rows].reverse().find((m) => !m.is_system && !m.exclude && m.mes.trim())
  if (!target || target.is_system || target.exclude || !target.mes.trim()) return
  const members = isGroup.value
    ? groupMembers.value
    : [chars.byId(chats.current.characterId)].filter((c) => !!c)
  const references = members.map((character) => ({
    characterId: character.id,
    name: character.data.name,
    blobId: character.avatarBlobId,
  }))
  imageTarget.value = {
    chatId: chats.current.id,
    messageId: target.id,
    prompt: dialogueImagePrompt(target, references),
    references,
  }
}

async function applyImage(image: GeneratedImage) {
  const target = imageTarget.value
  if (!target) throw new Error('对话已切换，请重新生成配图')
  await chats.attachImage(target.chatId, target.messageId, image)
  toast.success('配图已保存到对话')
}

watch(
  () => route.params['id'],
  () => {
    imageTarget.value = null
  },
)

const scroller = ref<HTMLElement | null>(null)
const { scrollToBottom, follow } = useAutoScroll(scroller)

const title = computed(() => chats.current?.title ?? '聊天')
const hasChat = computed(() => !!chats.current)
const isGroup = computed(() => chats.current?.kind === 'group')
const group = computed(() => groups.byId(chats.current?.groupId))
const groupMembers = computed(() =>
  (group.value?.members ?? [])
    .map((id) => chars.byId(id))
    .filter((c): c is NonNullable<typeof c> => !!c),
)
/** 手动策略时显示点名条 */
const showSpeakerTray = computed(() => isGroup.value && group.value?.activation_strategy === 2)
const streamingId = computed(() =>
  gen.busy ? chats.messages[chats.messages.length - 1]?.id : undefined,
)

async function syncRoute() {
  const id = route.params['id']
  const chatId = Array.isArray(id) ? id[0] : id
  if (!chatId) {
    chats.close()
    return
  }
  if (chats.current?.id === chatId) return
  await chats.open(chatId)
  await nextTick()
  scrollToBottom()
}

onMounted(async () => {
  if (!chars.loaded) await chars.load()
  await chats.loadList()
  await syncRoute()
})

watch(() => route.params['id'], syncRoute)
// 流式增长时跟随贴底
watch(
  () => chats.messages[chats.messages.length - 1]?.mes,
  () => void nextTick(follow),
)
watch(
  () => chats.messages.length,
  () => void nextTick(follow),
)

async function onSend(text: string) {
  if (!chats.current) {
    // 没有会话时自动开一个
    const meta = await chats.createSolo(undefined, '新对话')
    await router.push(`/chat/${meta.id}`)
    await chats.open(meta.id)
  }
  await chats.appendUser(text)
  await nextTick()
  scrollToBottom()
  if (isGroup.value) await gen.sendGroup({ isUserInput: true })
  else await gen.send()
}

/** 1vN 手动点名 */
async function speakAs(id: string) {
  await gen.sendGroup({ forceId: id, isUserInput: false })
}

async function onSwipe(msgId: string, dir: -1 | 1) {
  const msg = chats.messages.find((m) => m.id === msgId)
  if (!msg?.swipes?.length) return
  const n = msg.swipes.length
  const next = ((msg.swipe_id ?? 0) + dir + n) % n
  const text = msg.swipes[next]
  if (text === undefined) return
  chats.patchLocal(msgId, { swipe_id: next, mes: text })
  const row = chats.messages.find((m) => m.id === msgId)
  if (row) await messagesRepo.update(row)
}

const previewOpen = ref(false)

async function onEdit(id: string, text: string) {
  await chats.editMessage(id, text)
}
async function onRemove(id: string) {
  if (!(await confirmDialog({ text: '删除这条消息？' }))) return
  await chats.deleteMessage(id)
}
async function onRemoveFrom(id: string) {
  if (!(await confirmDialog({ text: '删除这条消息以及它之后的全部消息？此操作不可撤销。' }))) return
  await chats.deleteFrom(id)
}
async function onBranch(id: string) {
  const meta = await chats.branchFrom(id)
  if (!meta) return
  toast.success('已分支出新对话')
  await router.push(`/chat/${meta.id}`)
}

async function newChat() {
  const meta = await chats.createSolo(undefined, '新对话')
  await router.push(`/chat/${meta.id}`)
}
</script>

<template>
  <AppTopbar :title="title" class="chat-topbar">
    <template #actions>
      <span
        v-if="settings.settings.chat.showTokens && gen.lastPrompt"
        class="cbx-badge cbx-badge--brand"
      >
        {{ gen.lastPrompt.debug.tokens }} tok
      </span>
      <button
        v-if="hasChat"
        class="cbx-btn cbx-btn--ghost topbar-action"
        title="根据当前对话与角色参考图生成配图"
        aria-label="生成对话配图"
        :disabled="gen.busy || !canGenerateImage"
        @click="openImage()"
      >
        <ImagePlus :size="17" aria-hidden="true" /><span>生成配图</span>
      </button>
      <button
        v-if="hasChat"
        class="cbx-btn cbx-btn--ghost topbar-action"
        title="看看到底发了什么给模型"
        aria-label="预览提示词"
        @click="previewOpen = true"
      >
        <ScanText :size="17" aria-hidden="true" /><span>预览提示词</span>
      </button>
      <button
        class="cbx-btn cbx-btn--soft topbar-action"
        aria-label="新对话"
        title="新对话"
        @click="newChat"
      >
        <Plus :size="18" aria-hidden="true" /><span>新对话</span>
      </button>
    </template>
  </AppTopbar>

  <div ref="scroller" class="cbx-scroll body" :class="{ 'body--empty': !chats.messages.length }">
    <div v-if="!chats.messages.length" class="welcome">
      <div class="welcome-icon">
        <MessageCircle :size="32" :stroke-width="1.5" aria-hidden="true" />
      </div>
      <h2>从一句话，开始新的故事</h2>
      <p>分享一个想法，或向你的角色打个招呼。<br />每一段对话，都从这里开始。</p>
      <RouterLink to="/characters" class="welcome-link"
        ><UsersRound :size="16" aria-hidden="true" />选择一个角色</RouterLink
      >
    </div>

    <div v-else class="stream">
      <MessageBubble
        v-for="m in chats.messages"
        :key="m.id"
        :msg="m"
        :streaming="m.id === streamingId"
        :show-name="!m.is_user"
        :avatar-blob-id="chars.byId(m.original_avatar)?.avatarBlobId"
        :accent="isGroup ? accentOf(m.original_avatar) : undefined"
        :can-generate-image="!gen.busy && !m.is_system && !m.exclude && !!m.mes.trim()"
        @generate-image="openImage(m.id)"
        @image-loaded="follow"
        @regenerate="gen.regenerate()"
        @swipe="(d) => onSwipe(m.id, d)"
        @copy="toast.success('已复制')"
        @edit="(t) => onEdit(m.id, t)"
        @remove="onRemove(m.id)"
        @remove-from="onRemoveFrom(m.id)"
        @branch="onBranch(m.id)"
      />
    </div>
  </div>

  <!-- 1vN 手动策略：点名条 -->
  <div v-if="showSpeakerTray" class="tray">
    <span class="tray__hint">点名发言：</span>
    <button
      v-for="c in groupMembers"
      :key="c.id"
      class="cbx-chip tray__item"
      :disabled="gen.busy"
      @click="speakAs(c.id)"
    >
      {{ c.data.name }}
    </button>
  </div>

  <PromptPreview v-if="previewOpen" @close="previewOpen = false" />
  <ImageGenerationDialog
    v-if="imageTarget"
    title="生成对话配图"
    :initial-prompt="imageTarget.prompt"
    :references="imageTarget.references"
    require-references
    apply-label="保存到对话"
    :apply="applyImage"
    @close="imageTarget = null"
  />

  <ChatComposer
    :busy="gen.busy"
    :send-on-enter="settings.settings.chat.sendOnEnter"
    @send="onSend"
    @stop="gen.stop()"
  />
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-8) var(--cbx-space-6) var(--cbx-space-4);
  background: radial-gradient(ellipse at 50% 0, var(--cbx-brand-subtle), transparent 65%);
}
.body--empty {
  display: grid;
  place-items: center;
}
.welcome {
  padding: var(--cbx-space-8) var(--cbx-space-4);
  text-align: center;
}
.welcome-icon {
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  margin: 0 auto var(--cbx-space-6);
  border: 1px solid var(--cbx-brand-light-hover);
  border-radius: var(--cbx-radius-xl);
  color: var(--cbx-brand);
  background: var(--cbx-bg);
  box-shadow: var(--cbx-shadow-sm);
  transform: rotate(-6deg);
}
.welcome-icon svg {
  transform: rotate(6deg);
}
.welcome h2 {
  font-size: clamp(20px, 2.5vw, 28px);
  font-weight: var(--cbx-fw-medium);
  letter-spacing: 0.02em;
}
.welcome p {
  margin: var(--cbx-space-3) 0 var(--cbx-space-6);
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-sm);
  line-height: 1.9;
}
.welcome-link {
  display: inline-flex;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-2) var(--cbx-space-4);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-brand-subtle);
  color: var(--cbx-brand);
  font-size: var(--cbx-fs-sm);
  text-decoration: none;
}
.welcome-link:hover {
  background: var(--cbx-brand-light-hover);
}
.chat-topbar :deep(.title) {
  min-width: 0;
}
.chat-topbar :deep(.actions) {
  flex-shrink: 0;
}
.topbar-action {
  gap: var(--cbx-space-2);
}
.topbar-action svg {
  flex-shrink: 0;
}
.topbar-action:focus-visible,
.welcome-link:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 3px;
}
.stream {
  max-width: var(--cbx-read-w);
  margin: 0 auto;
}

.tray {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  flex-shrink: 0;
  padding: var(--cbx-space-2) var(--cbx-space-5);
  border-top: 1px solid var(--cbx-border);
  overflow-x: auto;
}
.tray__hint {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  flex-shrink: 0;
}
.tray__item {
  flex-shrink: 0;
}

@media (max-width: 767px) {
  .topbar-action {
    width: 40px;
    padding: 0;
  }
  .topbar-action span {
    display: none;
  }
  .chat-topbar :deep(.cbx-badge) {
    display: none;
  }
  .welcome {
    padding: var(--cbx-space-4) 0;
  }
  .welcome-icon {
    width: 60px;
    height: 60px;
    margin-bottom: var(--cbx-space-4);
  }
  .tray {
    padding-left: var(--cbx-space-3);
    padding-right: var(--cbx-space-3);
  }
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
}
</style>
