<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  GitBranch,
  ImagePlus,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-vue-next'
import { renderMarkdown } from '@/composables/useMarkdown'
import { useLongPress } from '@/composables/useLongPress'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import MessageImage from './MessageImage.vue'
import type { ChatMessage } from '@/types/chat'

const props = defineProps<{
  msg: ChatMessage
  /** 正在流式输出的那一条 */
  streaming?: boolean
  showName?: boolean
  /** 发言角色的头像 blob id */
  avatarBlobId?: string | undefined
  /** 1vN 角色区分色索引 1..8 */
  accent?: number | undefined
  canGenerateImage?: boolean
}>()

const emit = defineEmits<{
  regenerate: []
  swipe: [dir: -1 | 1]
  copy: []
  edit: [text: string]
  remove: []
  removeFrom: []
  branch: []
  generateImage: []
  imageLoaded: []
}>()

const html = computed(() => renderMarkdown(props.msg.mes))
const isUser = computed(() => props.msg.is_user)
const timeLabel = computed(() =>
  new Date(props.msg.send_date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
)
const hasSwipes = computed(() => (props.msg.swipes?.length ?? 0) > 1)
const swipeLabel = computed(() => {
  const n = props.msg.swipes?.length ?? 0
  return n > 1 ? `${(props.msg.swipe_id ?? 0) + 1}/${n}` : ''
})

// ── 内联编辑 ──
const editing = ref(false)
const draft = ref('')
const ta = ref<HTMLTextAreaElement | null>(null)

async function startEdit() {
  draft.value = props.msg.mes
  editing.value = true
  sheetOpen.value = false
  await nextTick()
  ta.value?.focus()
}
function commitEdit() {
  editing.value = false
  if (draft.value !== props.msg.mes) emit('edit', draft.value)
}
function cancelEdit() {
  editing.value = false
}

// ── 移动端长按动作面板 ──
const sheetOpen = ref(false)
const { handlers } = useLongPress(() => (sheetOpen.value = true))

function copy() {
  void navigator.clipboard?.writeText(props.msg.mes)
  sheetOpen.value = false
  emit('copy')
}
function act(fn: () => void) {
  sheetOpen.value = false
  fn()
}
</script>

<template>
  <div class="row" :class="{ 'row--user': isUser }">
    <CbxAvatar v-if="!isUser" :blob-id="avatarBlobId" :name="msg.name" size="sm" />

    <div class="col">
      <div class="message-meta">
        <span v-if="showName && !isUser" class="who">{{ msg.name }}</span>
        <span v-else-if="isUser" class="who">你</span>
        <span class="message-time">{{ timeLabel }}</span>
      </div>

      <div
        class="cbx-bubble"
        :class="isUser ? 'cbx-bubble--user' : 'cbx-bubble--ai'"
        :style="accent ? { borderLeft: `3px solid var(--cbx-char-${accent})` } : undefined"
        v-bind="handlers"
      >
        <template v-if="editing">
          <textarea ref="ta" v-model="draft" class="cbx-textarea edit" rows="4" />
          <div class="edit__ops">
            <button class="cbx-btn cbx-btn--ghost xs" @click="cancelEdit">取消</button>
            <button class="cbx-btn cbx-btn--primary xs" @click="commitEdit">保存</button>
          </div>
        </template>
        <template v-else>
          <div v-if="msg.mes" class="cbx-md" v-html="html" />
          <div v-else-if="streaming" class="cbx-typing">
            <span class="cbx-typing__dot" />
            <span class="cbx-typing__dot" />
            <span class="cbx-typing__dot" />
          </div>
          <span v-if="streaming && msg.mes" class="caret" />
          <MessageImage
            v-for="image in msg.images ?? []"
            :key="image.blobId"
            :image="image"
            @loaded="emit('imageLoaded')"
          />
        </template>
      </div>

      <div v-if="!editing" class="tools">
        <button
          v-if="canGenerateImage"
          class="cbx-icon-btn tool"
          title="根据此处对话生成配图"
          aria-label="根据此处对话生成配图"
          @click="emit('generateImage')"
        >
          <ImagePlus :size="14" aria-hidden="true" />
        </button>
        <button class="cbx-icon-btn tool" title="复制" aria-label="复制" @click="copy">
          <Copy :size="14" aria-hidden="true" />
        </button>
        <button class="cbx-icon-btn tool" title="编辑" aria-label="编辑" @click="startEdit">
          <Pencil :size="14" aria-hidden="true" />
        </button>
        <template v-if="!isUser">
          <button
            class="cbx-icon-btn tool"
            title="重新生成"
            aria-label="重新生成"
            @click="emit('regenerate')"
          >
            <RotateCcw :size="14" aria-hidden="true" />
          </button>
          <template v-if="hasSwipes">
            <button
              class="cbx-icon-btn tool"
              title="上一条"
              aria-label="上一条"
              @click="emit('swipe', -1)"
            >
              <ChevronLeft :size="16" aria-hidden="true" />
            </button>
            <span class="swipe-n">{{ swipeLabel }}</span>
            <button
              class="cbx-icon-btn tool"
              title="下一条"
              aria-label="下一条"
              @click="emit('swipe', 1)"
            >
              <ChevronRight :size="16" aria-hidden="true" />
            </button>
          </template>
        </template>
        <button
          class="cbx-icon-btn tool"
          title="从这里分支出新对话"
          aria-label="从这里分支出新对话"
          @click="emit('branch')"
        >
          <GitBranch :size="14" aria-hidden="true" />
        </button>
        <button
          class="cbx-icon-btn tool tool--danger"
          title="删除本条"
          aria-label="删除本条"
          @click="emit('remove')"
        >
          <Trash2 :size="14" aria-hidden="true" />
        </button>
        <span v-if="msg.extra?.stopped" class="cbx-badge cbx-badge--warning">已中断</span>
      </div>
    </div>

    <!-- 移动端长按面板 -->
    <Teleport to="body">
      <div v-if="sheetOpen" class="cbx-modal__scrim sheet-scrim" @click.self="sheetOpen = false">
        <div class="sheet cbx-safe-b">
          <button class="sheet__item" @click="copy">复制</button>
          <button class="sheet__item" @click="startEdit">编辑</button>
          <button
            v-if="canGenerateImage"
            class="sheet__item"
            @click="act(() => emit('generateImage'))"
          >
            根据此处对话生成配图
          </button>
          <button v-if="!isUser" class="sheet__item" @click="act(() => emit('regenerate'))">
            重新生成
          </button>
          <button class="sheet__item" @click="act(() => emit('branch'))">从这里分支出新对话</button>
          <button class="sheet__item sheet__item--danger" @click="act(() => emit('remove'))">
            删除本条
          </button>
          <button class="sheet__item sheet__item--danger" @click="act(() => emit('removeFrom'))">
            删除本条及之后
          </button>
          <button class="sheet__item sheet__cancel" @click="sheetOpen = false">取消</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  gap: var(--cbx-space-3);
  align-items: flex-start;
  margin-bottom: var(--cbx-space-6);
}
.row--user {
  flex-direction: row-reverse;
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: min(calc(100% - 44px), 680px);
}
.row--user .col {
  align-items: flex-end;
  max-width: min(88%, 680px);
}
.message-meta {
  display: flex;
  align-items: baseline;
  gap: var(--cbx-space-2);
  margin-bottom: 6px;
  padding: 0 var(--cbx-space-1);
  font-size: var(--cbx-fs-xs);
}
.who {
  color: var(--cbx-text-secondary);
  font-weight: var(--cbx-fw-medium);
}
.message-time {
  color: var(--cbx-text-tertiary);
  font-size: 11px;
  white-space: nowrap;
}
.cbx-bubble {
  padding: 14px 18px;
  line-height: 1.8;
}
.cbx-bubble--ai {
  background: var(--cbx-bg);
  border-color: color-mix(in srgb, var(--cbx-border) 70%, transparent);
  border-top-left-radius: var(--cbx-radius-sm);
  box-shadow: 0 2px 8px var(--cbx-brand-subtle);
}
.cbx-bubble--user {
  border-top-right-radius: var(--cbx-radius-sm);
  box-shadow: 0 3px 10px var(--cbx-brand-light);
}
.cbx-bubble--user :deep(a),
.cbx-bubble--user :deep(blockquote),
.cbx-bubble--user :deep(h1),
.cbx-bubble--user :deep(h2),
.cbx-bubble--user :deep(h3),
.cbx-bubble--user :deep(h4),
.cbx-bubble--user :deep(h5),
.cbx-bubble--user :deep(h6) {
  color: inherit;
}
.cbx-bubble--user :deep(a) {
  text-decoration: underline;
}
.cbx-bubble--user :deep(blockquote) {
  border-color: currentColor;
}
.row > :deep(.cbx-avatar) {
  margin-top: 2px;
  box-shadow: 0 0 0 3px var(--cbx-bg);
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

.edit {
  width: min(420px, 100%);
  min-width: min(260px, 100%);
  background: var(--cbx-bg);
}
.edit__ops {
  display: flex;
  justify-content: flex-end;
  gap: var(--cbx-space-2);
  margin-top: var(--cbx-space-2);
}
.xs {
  height: 28px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}

.tools {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: var(--cbx-space-1);
  opacity: 0;
  transition: opacity var(--cbx-transition);
}
.row:hover .tools,
.row:focus-within .tools {
  opacity: 1;
}
.tool {
  width: 28px;
  height: 28px;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-tertiary);
}
.tool:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 2px;
}
.tool--danger:hover {
  color: var(--cbx-error);
}
@media (max-width: 767px) {
  .row {
    gap: var(--cbx-space-2);
  }
  /* 头像与姓名在第一行，气泡横跨两列，释放原先留给头像的侧边宽度。 */
  .row:not(.row--user) {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr);
  }
  .row:not(.row--user) .col {
    display: contents;
  }
  .row > :deep(.cbx-avatar) {
    grid-column: 1;
    grid-row: 1;
    margin-top: 0;
  }
  .row:not(.row--user) .message-meta {
    grid-column: 2;
    grid-row: 1;
    align-self: center;
    min-width: 0;
    margin-bottom: 0;
    padding: 0;
  }
  .who {
    overflow-wrap: anywhere;
  }
  .row:not(.row--user) .cbx-bubble,
  .row:not(.row--user) .tools {
    grid-column: 1 / -1;
    justify-self: start;
    min-width: 0;
    max-width: 100%;
  }
  .row--user .col {
    max-width: 100%;
  }
  .cbx-bubble {
    padding: 10px 14px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .caret {
    animation: none;
  }
  .tools {
    transition: none;
  }
}
.swipe-n {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  min-width: 28px;
  text-align: center;
}

/* 底部动作面板 */
.sheet-scrim {
  align-items: flex-end;
  padding: 0;
}
.sheet {
  width: 100%;
  background: var(--cbx-bg);
  border-radius: var(--cbx-radius-lg) var(--cbx-radius-lg) 0 0;
  padding: var(--cbx-space-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sheet__item {
  min-height: var(--cbx-tap-min);
  border: none;
  background: none;
  font-family: inherit;
  font-size: var(--cbx-fs-md);
  color: var(--cbx-text);
  border-radius: var(--cbx-radius-md);
  cursor: pointer;
}
.sheet__item:active {
  background: var(--cbx-bg-active);
}
.sheet__item--danger {
  color: var(--cbx-error);
}
.sheet__cancel {
  margin-top: var(--cbx-space-2);
  border-top: 1px solid var(--cbx-border);
  color: var(--cbx-text-secondary);
}

/* 触屏没有 hover：桌面操作条隐藏，改用长按面板 */
@media (hover: none) {
  .tools {
    display: none;
  }
}
/* 桌面不需要长按面板 */
@media (hover: hover) {
  .sheet-scrim {
    display: none;
  }
}
</style>
