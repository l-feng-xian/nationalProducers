<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import { computed, onMounted, ref } from 'vue'
import { useGenerationStore } from '@/stores/generation'
import { formatTokens } from '@/services/tokens'
import type { PromptMessage } from '@/types/prompt'
import { useBackClose } from '@/composables/useBackClose'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'

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
// 手机返回键 = 关预览
useBackClose(() => emit('close'))

const gen = useGenerationStore()

/**
 * 演绎：每位成员的提示词都不一样（角色卡、世界书、演绎约束、stop 串都按发言者组装），
 * 所以给一个成员下拉。默认选「按演绎策略下一位会发言的人」，就是点发送后真正会发出去的那份。
 */
const group = gen.previewSpeakers()
const speakerId = ref(group?.defaultId ?? '')
/** 发言者选项：挪出模板，模板里 group 的可空收窄才能保住 */
const speakerOptions = computed(() =>
  (group?.members ?? []).map((m) => ({
    value: m.id,
    label: m.name,
    ...(m.id === group?.defaultId ? { hint: '下一位发言' } : {}),
  })),
)

function rebuild() {
  return gen.build({ isDryRun: true, ...(speakerId.value ? { speakerId: speakerId.value } : {}) })
}
const built = ref(rebuild())

onMounted(() => {
  built.value = rebuild()
})

function refresh() {
  built.value = rebuild()
}

const sections = computed<PromptMessage[]>(() => built.value?.debug.sections ?? [])
const wi = computed(() => built.value?.debug.worldInfo)

/**
 * 缓存诊断：与该发言者上一次真实请求比，前面有多少块一模一样（≈ 能命中前缀缓存的部分），
 * 第一处不同在哪。本会话还没发过（或刚重启）时为 null。
 */
const prefix = computed(() => (built.value ? gen.prefixReport(built.value) : null))
const prefixPct = computed(() =>
  prefix.value && prefix.value.totalTokens
    ? Math.round((prefix.value.sameTokens / prefix.value.totalTokens) * 100)
    : 0,
)
const firstDiffIdx = computed(() => (prefix.value?.firstDiff ? prefix.value.sameBlocks : -1))
const volatile = computed(() => built.value?.debug.volatileMacros ?? [])
/** 在脚本里拼：模板里直接写字面的双花括号会被当成插值 */
function macroText(name: string): string {
  return `{{${name}}}`
}
function whereLabel(where: string): string {
  const [src = '', who] = where.split(':')
  const base = LABEL[src] ?? src
  return who ? `${who} · ${base}` : base
}

/** source → 中文标签 */
const LABEL: Record<string, string> = {
  main: '主提示词',
  // 与 main 互斥：两者只会出现一个，出现哪个就说明本轮是谁占了主提示词槽
  charSystem: '主提示词（角色卡覆盖）',
  worldInfoBefore: '世界书 ↑卡片',
  charDescription: '角色简介',
  charPersonality: '角色性格',
  scenario: '场景',
  worldInfoAfter: '世界书 ↓卡片',
  personaDescription: '用户人设',
  dialogueExamples: '对话示例',
  newChat: '新对话标记',
  chatHistory: '聊天历史',
  groupNudge: '演绎提示',
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
      <div class="cbx-modal cbx-modal--wide cbx-page" role="dialog" aria-modal="true">
        <header class="cbx-modal__head cbx-page-head">
          <h3>提示词预览</h3>
          <div class="head-ops">
            <button class="cbx-btn cbx-btn--ghost sm" @click="refresh">刷新</button>
            <button class="cbx-btn cbx-btn--ghost sm" @click="copyJson">
              <AppIcon :name="copied ? 'Check' : 'Copy'" :active="copied" />{{
                copied ? '已复制' : '复制 JSON'
              }}
            </button>
          </div>
          <!-- 放在操作组外面：手机上它要被 order 挪到标题左边当返回键 -->
          <CbxDialogClose @click="emit('close')" />
        </header>

        <div class="cbx-modal__body cbx-scroll cbx-page-body">
          <div v-if="!built" class="cbx-empty">
            <span class="cbx-empty__desc">当前没有会话</span>
          </div>

          <template v-else>
            <label v-if="group && group.members.length" class="cbx-field speaker">
              <span class="cbx-field__label">预览发言者</span>
              <CbxSelect
                v-model="speakerId"
                :options="speakerOptions"
                label="预览发言者"
                @change="refresh"
              />
            </label>

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
              <span
                v-if="prefix"
                class="cbx-badge"
                :class="prefixPct >= 70 ? 'cbx-badge--success' : 'cbx-badge--warning'"
                title="与上一次真实请求逐块比对：前面相同的部分可以命中服务端的前缀缓存"
              >
                与上次相同前缀 {{ prefix.sameBlocks }}/{{ prefix.totalBlocks }} 块 · ≈{{
                  formatTokens(prefix.sameTokens)
                }}
                tok（{{ prefixPct }}%）
              </span>
            </div>

            <!-- 缓存提示 -->
            <div v-if="prefix?.firstDiff || volatile.length" class="cache-note">
              <p v-if="prefix?.firstDiff">
                第 {{ firstDiffIdx }} 块（{{
                  labelOf(prefix.firstDiff)
                }}）起与上次不同，其后都无法命中缓存。
              </p>
              <p v-for="v in volatile" :key="`${v.where}.${v.macro}`">
                {{ whereLabel(v.where) }} 用了 <code>{{ macroText(v.macro) }}</code
                >，{{
                  v.scope === 'turn' ? '每轮都会变' : '每天会变'
                }}，会让缓存从这里失效；可以把它挪到约束提示词里（depth 0）。
              </p>
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
              :class="{ 'msg--inject': isInjected(m), 'msg--diff': i === firstDiffIdx }"
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
.speaker {
  max-width: var(--cbx-fieldw-md);
}
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
/* 缓存断点：与上次请求第一处不同的块 */
.msg--diff {
  border-color: var(--cbx-warning);
  box-shadow: 0 0 0 1px var(--cbx-warning);
}
.cache-note {
  margin-bottom: var(--cbx-space-4);
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-warning-light);
  color: var(--cbx-text-secondary);
  font-size: var(--cbx-fs-xs);
  line-height: 1.6;
}
.cache-note p {
  margin: 0;
}
.cache-note code {
  font-family: var(--cbx-font-mono);
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
