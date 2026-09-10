<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '@/composables/useMarkdown'
import type { ChatMessage } from '@/types/chat'

const props = defineProps<{
  msg: ChatMessage
  /** 正在流式输出的那一条 */
  streaming?: boolean
  showName?: boolean
}>()

const emit = defineEmits<{
  regenerate: []
  swipe: [dir: -1 | 1]
  copy: []
}>()

const html = computed(() => renderMarkdown(props.msg.mes))
const isUser = computed(() => props.msg.is_user)
const hasSwipes = computed(() => (props.msg.swipes?.length ?? 0) > 1)
const swipeLabel = computed(() => {
  const n = props.msg.swipes?.length ?? 0
  return n > 1 ? `${(props.msg.swipe_id ?? 0) + 1}/${n}` : ''
})

const initial = computed(() => (props.msg.name || '?').slice(0, 1))

function copy() {
  void navigator.clipboard?.writeText(props.msg.mes)
  emit('copy')
}
</script>

<template>
  <div class="row" :class="{ 'row--user': isUser }">
    <div v-if="!isUser" class="cbx-avatar cbx-avatar--sm cbx-avatar__fallback">{{ initial }}</div>

    <div class="col">
      <div v-if="showName && !isUser" class="who">{{ msg.name }}</div>

      <div class="cbx-bubble" :class="isUser ? 'cbx-bubble--user' : 'cbx-bubble--ai'">
        <div v-if="msg.mes" class="cbx-md" v-html="html" />
        <div v-else-if="streaming" class="cbx-typing">
          <span class="cbx-typing__dot" />
          <span class="cbx-typing__dot" />
          <span class="cbx-typing__dot" />
        </div>
        <span v-if="streaming && msg.mes" class="caret" />
      </div>

      <div class="tools">
        <button class="cbx-icon-btn tool" title="复制" @click="copy">⧉</button>
        <template v-if="!isUser">
          <button class="cbx-icon-btn tool" title="重新生成" @click="emit('regenerate')">↻</button>
          <template v-if="hasSwipes">
            <button class="cbx-icon-btn tool" title="上一条" @click="emit('swipe', -1)">‹</button>
            <span class="swipe-n">{{ swipeLabel }}</span>
            <button class="cbx-icon-btn tool" title="下一条" @click="emit('swipe', 1)">›</button>
          </template>
        </template>
        <span v-if="msg.extra?.stopped" class="cbx-badge cbx-badge--warning">已中断</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: var(--cbx-space-3);
  align-items: flex-start;
  margin-bottom: var(--cbx-space-5);
}
.row--user {
  flex-direction: row-reverse;
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: min(100%, 680px);
}
.row--user .col {
  align-items: flex-end;
}
.who {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  margin-bottom: var(--cbx-space-1);
  padding-left: var(--cbx-space-1);
}
.caret {
  display: inline-block;
  width: 2px;
  height: 1em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: caret-blink 1s step-end infinite;
}
@keyframes caret-blink {
  50% {
    opacity: 0;
  }
}

.tools {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: var(--cbx-space-1);
  opacity: 0;
  transition: opacity var(--cbx-transition);
}
.row:hover .tools {
  opacity: 1;
}
.tool {
  width: 28px;
  height: 28px;
  font-size: var(--cbx-fs-sm);
}
.swipe-n {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  min-width: 28px;
  text-align: center;
}

/* 触屏没有 hover，操作条常显（半透明） */
@media (hover: none) {
  .tools {
    opacity: 0.55;
  }
  .tool {
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
}
</style>
