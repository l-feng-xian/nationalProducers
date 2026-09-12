<script setup lang="ts">
/**
 * 游戏内对话条。
 *
 * 刻意不复用聊天页的 MessageBubble —— 那是一整行「头像+名字+气泡+工具条+
 * 长按菜单」，为聊天列表设计的。游戏里要的是压在画面底部的一条窄带，
 * 只显示当前这一来一回。完整历史本来就在会话里，想翻记录去聊天页看即可。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdown'
import { useRpgStore } from '@/stores/rpg'

const emit = defineEmits<{ close: []; send: [text: string]; stop: [] }>()

const rpg = useRpgStore()
const draft = ref('')
const input = ref<HTMLTextAreaElement | null>(null)
const scroller = ref<HTMLElement | null>(null)

const canSend = computed(() => draft.value.trim().length > 0 && !rpg.pending)

// 新内容进来时贴底，流式输出才不会把新文字顶到看不见的地方
watch(
  () => rpg.lines.map((l) => l.text).join('|'),
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function submit() {
  const t = draft.value.trim()
  if (!t || rpg.pending) return
  draft.value = ''
  emit('send', t)
}

/**
 * Enter 发送、Shift+Enter 换行。
 * ⚠️ 必须判 isComposing：中文输入法选词时按 Enter 是在确认候选，
 * 不判的话会把半截拼音直接发出去。
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  submit()
}

function focus() {
  void nextTick(() => input.value?.focus())
}
defineExpose({ focus })
</script>

<template>
  <div class="bar">
    <header class="bar__head">
      <span class="bar__who">{{ rpg.talkingName }}</span>
      <button v-if="rpg.pending" class="cbx-btn cbx-btn--ghost sm" @click="emit('stop')">
        停止
      </button>
      <button class="cbx-icon-btn" aria-label="结束对话" @click="emit('close')">✕</button>
    </header>

    <div ref="scroller" class="bar__log cbx-scroll">
      <p v-if="!rpg.lines.length && !rpg.dialogueError" class="bar__hint">
        说点什么吧。这段对话会记进它的会话历史里。
      </p>
      <div v-for="(l, i) in rpg.lines" :key="i" class="line" :class="`line--${l.who}`">
        <span class="line__who">{{ l.name }}</span>
        <!-- eslint-disable-next-line vue/no-v-html -- renderMarkdown 内部已过 DOMPurify -->
        <div class="line__text cbx-md" v-html="renderMarkdown(l.text)" />
      </div>
      <p v-if="rpg.pending && !rpg.lines.some((l) => l.who === 'npc' && l.text)" class="bar__hint">
        正在思考…
      </p>
      <p v-if="rpg.dialogueError" class="bar__err">⚠️ {{ rpg.dialogueError }}</p>
    </div>

    <div class="bar__input">
      <textarea
        ref="input"
        v-model="draft"
        class="cbx-textarea"
        rows="1"
        placeholder="说点什么…"
        @keydown="onKeydown"
      />
      <button class="cbx-btn cbx-btn--primary" :disabled="!canSend" @click="submit">发送</button>
    </div>
  </div>
</template>

<style scoped>
.bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  max-height: 58%;
  padding: var(--cbx-space-3);
  /* 底部安全区：手机上不能被 home 指示条压住 */
  padding-bottom: max(var(--cbx-space-3), var(--cbx-safe-b));
  background: var(--cbx-bg);
  border-top: 1px solid var(--cbx-border);
  box-shadow: var(--cbx-shadow-lg);
}
.bar__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.bar__who {
  flex: 1;
  min-width: 0;
  font-weight: var(--cbx-fw-bold);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bar__log {
  flex: 1;
  min-height: 0;
  max-height: 34vh;
}
.bar__hint {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-tertiary);
}
.bar__err {
  margin: var(--cbx-space-2) 0 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-warning-hover);
}
.line {
  margin-bottom: var(--cbx-space-3);
}
.line__who {
  display: block;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.line--player .line__who {
  color: var(--cbx-brand);
}
.line__text {
  font-size: var(--cbx-fs-sm);
  line-height: var(--cbx-lh);
}
.bar__input {
  display: flex;
  gap: var(--cbx-space-2);
  align-items: flex-end;
}
.bar__input .cbx-textarea {
  flex: 1;
  min-width: 0;
  max-height: 96px;
}
@media (max-width: 767px) {
  .bar {
    max-height: 70%;
  }
  .bar__input .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
}
</style>
