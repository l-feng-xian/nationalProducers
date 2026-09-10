<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import MessageBubble from '@/components/chat/MessageBubble.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import { useChatsStore } from '@/stores/chats'
import { useCharactersStore } from '@/stores/characters'
import { useSettingsStore } from '@/stores/settings'
import { useGenerationStore } from '@/stores/generation'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { useToast } from '@/composables/useToast'
import { messagesRepo } from '@/db/repositories'

const route = useRoute()
const router = useRouter()
const chats = useChatsStore()
const chars = useCharactersStore()
const settings = useSettingsStore()
const gen = useGenerationStore()
const toast = useToast()

const scroller = ref<HTMLElement | null>(null)
const { scrollToBottom, follow } = useAutoScroll(scroller)

const title = computed(() => chats.current?.title ?? '聊天')
const hasChat = computed(() => !!chats.current)
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
  await gen.send()
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
        @regenerate="gen.regenerate()"
        @swipe="(d) => onSwipe(m.id, d)"
        @copy="toast.success('已复制')"
      />
    </div>
  </div>

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

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
}
</style>
