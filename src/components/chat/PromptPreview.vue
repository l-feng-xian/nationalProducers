<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useGenerationStore } from '@/stores/generation'
import { formatTokens } from '@/services/tokens'
import type { PromptMessage } from '@/types/prompt'

/**
 * 提示词预览（dry run）。
 *
 * 这是本项目最重要的排查工具：所有「模型为什么没按设定走」的问题，
 * 答案都在这里 —— 到底哪些块进了提示词、约束提示词落在第几条、
 * 世界书激活了什么、历史被砍掉了多少。
 *
 * ⚠️ 走 isDryRun，不会推进 sticky/cooldown（否则看几眼预览设定就失效了）。
 */
const emit = defineEmits<{ close: [] }>()

const gen = useGenerationStore()
const built = ref(gen.build({ isDryRun: true }))

onMounted(() => {
  built.value = gen.build({ isDryRun: true })
})

function refresh() {
  built.value = gen.build({ isDryRun: true })
}

const sections = computed<PromptMessage[]>(() => built.value?.debug.sections ?? [])
const wi = computed(() => built.value?.debug.worldInfo)

/** source → 中文标签 */
const LABEL: Record<string, string> = {
  main: '主提示词',
  charSystem: '角色主提示词覆盖',
  worldInfoBefore: '世界书 ↑卡片',
  charDescription: '角色简介',
  charPersonality: '角色性格',
  scenario: '场景',
  worldInfoAfter: '世界书 ↓卡片',
  personaDescription: '用户人设',
  dialogueExamples: '对话示例',
  newChat: '新对话标记',
  chatHistory: '聊天历史',
  groupNudge: '群聊提示',
  jailbreak: '后置指令',
  memoryState: '会话记忆',
}
function labelOf(m: PromptMessage): string {
  const s = m.source ?? ''
  if (s.startsWith('inject@')) return `深度注入 @${s.slice(7)}`
  return LABEL[s] ?? s ?? '—'
}
function isInjected(m: PromptMessage): boolean {
  return !!m.injected
}

const copied = ref(false)
function copyJson() {
  const msgs = built.value?.messages ?? []
  void navigator.clipboard?.writeText(JSON.stringify(msgs, null, 2))
  copied.value = true
  setTimeout(() => (copied.value = false), 1500)
}
</script>

<template>
  <Teleport to="body">
    <div class="cbx-modal__scrim" @click.self="emit('close')">
      <div class="cbx-modal cbx-modal--wide" role="dialog" aria-modal="true">
        <header class="cbx-modal__head">
          <h3>提示词预览</h3>
          <div class="head-ops">
            <button class="cbx-btn cbx-btn--ghost sm" @click="refresh">刷新</button>
            <button class="cbx-btn cbx-btn--ghost sm" @click="copyJson">
              {{ copied ? '✓ 已复制' : '复制 JSON' }}
            </button>
            <button class="cbx-icon-btn" aria-label="关闭" @click="emit('close')">✕</button>
          </div>
        </header>

        <div class="cbx-modal__body cbx-scroll">
          <div v-if="!built" class="cbx-empty">
            <span class="cbx-empty__desc">当前没有会话</span>
          </div>

          <template v-else>
            <!-- 概览 -->
            <div class="stats">
              <span class="cbx-badge cbx-badge--brand">
                实际发出 {{ built.messages.length }} 条 · {{ formatTokens(built.debug.tokens) }} tok
              </span>
              <span class="cbx-badge cbx-badge--success">
                注入预留 {{ formatTokens(built.debug.reserved) }} tok
              </span>
              <span v-if="built.debug.droppedHistory" class="cbx-badge cbx-badge--warning">
                历史被裁掉 {{ built.debug.droppedHistory }} 条
              </span>
              <span v-if="built.debug.droppedExamples" class="cbx-badge cbx-badge--warning">
                示例被裁掉 {{ built.debug.droppedExamples }} 组
              </span>
              <span v-if="wi?.budgetOverflowed" class="cbx-badge cbx-badge--error">
                世界书超预算
              </span>
            </div>

            <!-- 世界书激活情况 -->
            <div v-if="wi && wi.allActivatedEntries.length" class="wi">
              <div class="cbx-group-label">
                世界书已激活 {{ wi.allActivatedEntries.length }} 条 · 预算
                {{ formatTokens(wi.budget) }} tok
              </div>
              <div class="chips">
                <span
                  v-for="e in wi.allActivatedEntries"
                  :key="`${e.world}.${e.uid}`"
                  class="cbx-chip"
                >
                  {{ e.comment || e.key.join('/') || '未命名' }}
                </span>
              </div>
            </div>

            <!-- 逐条消息 -->
            <div class="cbx-group-label">
              组装明细（{{ sections.length }} 块）
              <span v-if="sections.length !== built.messages.length" class="note">
                — 相邻的 system 块发出前会被合并，故实际条数更少
              </span>
            </div>
            <div
              v-for="(m, i) in sections"
              :key="i"
              class="msg"
              :class="{ 'msg--inject': isInjected(m) }"
            >
              <div class="msg__head">
                <span class="msg__idx">{{ i }}</span>
                <span class="msg__role" :class="`msg__role--${m.role}`">{{ m.role }}</span>
                <span v-if="m.name" class="msg__name">{{ m.name }}</span>
                <span class="msg__src">{{ labelOf(m) }}</span>
              </div>
              <pre class="msg__body">{{ m.content }}</pre>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.head-ops {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.sm {
  height: 30px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-4);
}
.wi {
  margin-bottom: var(--cbx-space-4);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.note {
  font-weight: var(--cbx-fw-normal);
  text-transform: none;
  letter-spacing: 0;
}
.msg {
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  margin-bottom: var(--cbx-space-2);
  overflow: hidden;
}
/* 注入产生的伪消息高亮，一眼看出约束提示词落在哪 */
.msg--inject {
  border-color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
.msg__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-2) var(--cbx-space-3);
  background: var(--cbx-bg-secondary);
  font-size: var(--cbx-fs-xs);
}
.msg--inject .msg__head {
  background: transparent;
}
.msg__idx {
  min-width: 20px;
  color: var(--cbx-text-tertiary);
  font-family: var(--cbx-font-mono);
}
.msg__role {
  font-weight: var(--cbx-fw-medium);
  padding: 1px 6px;
  border-radius: var(--cbx-radius-sm);
}
.msg__role--system {
  background: var(--cbx-warning-light);
  color: var(--cbx-warning);
}
.msg__role--user {
  background: var(--cbx-brand-light);
  color: var(--cbx-brand);
}
.msg__role--assistant {
  background: var(--cbx-success-light);
  color: var(--cbx-success);
}
.msg__name {
  color: var(--cbx-text-tertiary);
  font-family: var(--cbx-font-mono);
}
.msg__src {
  margin-left: auto;
  color: var(--cbx-text-tertiary);
}
.msg__body {
  margin: 0;
  padding: var(--cbx-space-3);
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 240px;
  overflow-y: auto;
}
</style>
