<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import MessageBubble from '@/components/chat/MessageBubble.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import PromptPreview from '@/components/chat/PromptPreview.vue'
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
  if (
    !(await confirmDialog({ text: '删除这条消息以及它之后的全部消息？此操作不可撤销。' }))
  )
    return
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
  <AppTopbar :title="title">
    <template #actions>
      <span
        v-if="settings.settings.chat.showTokens && gen.lastPrompt"
        class="cbx-badge cbx-badge--brand"
      >
        {{ gen.lastPrompt.debug.tokens }} tok
      </span>
      <button
        v-if="hasChat"
        class="cbx-btn cbx-btn--ghost"
        title="看看到底发了什么给模型"
        @click="previewOpen = true"
      >
        预览提示词
      </button>
      <button class="cbx-btn cbx-btn--soft" @click="newChat">＋ 新对话</button>
    </template>
  </AppTopbar>

  <div ref="scroller" class="cbx-scroll body">
    <div v-if="!hasChat" class="cbx-empty">
      <span class="cbx-empty__icon">💬</span>
      <span class="cbx-empty__title">开始一段对话</span>
      <span class="cbx-empty__desc">直接在下方输入即可，或先到「角色」创建一个角色</span>
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
  padding: var(--cbx-space-5);
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
  .tray {
    padding-left: var(--cbx-space-3);
    padding-right: var(--cbx-space-3);
  }
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
}
</style>
