<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Send, Square } from '@/components/icons'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'

export interface MentionMember {
  id: string
  name: string
  avatarBlobId?: string | undefined
}

const props = defineProps<{
  busy: boolean
  sendOnEnter: boolean
  /** 演绎成员：传了才启用「@ 提及」选择列表 */
  members?: MentionMember[] | undefined
}>()
const emit = defineEmits<{ send: [text: string]; stop: [] }>()

const text = ref('')
const ta = ref<HTMLTextAreaElement | null>(null)
const action = ref<HTMLButtonElement | null>(null)
const flight = ref<{
  id: number
  x: number
  y: number
  dx: number
  dy: number
  angle: number
} | null>(null)
let flightId = 0
let flightTimer: ReturnType<typeof setTimeout> | undefined
const MAX_H = 180

function finishFlight() {
  clearTimeout(flightTimer)
  flight.value = null
}

function launchPlane() {
  const rect = action.value?.getBoundingClientRect()
  if (!rect || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  // 靠近屏幕右侧时向上飞，确保手机上也能看到完整航迹。
  const dx = Math.max(0, Math.min(160, window.innerWidth - x - 28))
  const dy = Math.min(240, Math.max(60, y - 28))
  flight.value = { id: ++flightId, x, y, dx, dy, angle: (Math.atan2(-dy, dx) * 180) / Math.PI + 45 }
  clearTimeout(flightTimer)
  flightTimer = setTimeout(finishFlight, 850)
}

onBeforeUnmount(finishFlight)

function autosize() {
  const el = ta.value
  if (!el) return
  el.style.height = 'auto'
  const h = Math.min(el.scrollHeight, MAX_H)
  el.style.height = `${h}px`
  el.style.overflowY = el.scrollHeight > MAX_H ? 'auto' : 'hidden'
}

watch(text, () => void nextTick(autosize))

function submit() {
  const t = text.value.trim()
  if (!t || props.busy || flight.value) return
  launchPlane()
  emit('send', t)
  text.value = ''
  void nextTick(autosize)
}

function onAction() {
  if (props.busy) emit('stop')
  else submit()
}

// ── @ 提及 ─────────────────────────────────────────────
// 光标前是「@ + 若干非空白字符」就弹出成员列表，按名字过滤；选中后把 `@查询` 换成 `@名字 `。
// 发送后 activation.ts 的 explicitMentions 按同一规则认出被 @ 的人，让他们优先发言。
const mention = ref<{ at: number; query: string } | null>(null)
const mentionIndex = ref(0)
const mentionList = ref<HTMLElement | null>(null)
/** 按 Esc 关掉的那个 @ 的位置：光标还停在它后面时不再自动弹出 */
let dismissedAt = -1

const mentionOptions = computed(() => {
  const m = mention.value
  const members = props.members ?? []
  if (!m || !members.length) return []
  const q = m.query.toLowerCase()
  if (!q) return members
  const hit = members.filter((c) => c.name.toLowerCase().includes(q))
  // 名字以查询开头的排前面
  return [
    ...hit.filter((c) => c.name.toLowerCase().startsWith(q)),
    ...hit.filter((c) => !c.name.toLowerCase().startsWith(q)),
  ]
})
const mentionOpen = computed(() => mentionOptions.value.length > 0)

function closeMention() {
  mention.value = null
}

function updateMention() {
  const el = ta.value
  if (!el || !props.members?.length || el.selectionStart !== el.selectionEnd) {
    closeMention()
    return
  }
  const caret = el.selectionStart
  // @ 前面不能紧挨字母数字（避开邮箱 a@b.com）；查询里不含空白与 @
  const m = /(^|[^A-Za-z0-9_])@([^\s@]{0,24})$/.exec(el.value.slice(0, caret))
  if (!m) {
    dismissedAt = -1
    closeMention()
    return
  }
  const query = m[2] ?? ''
  const at = caret - query.length - 1
  if (at === dismissedAt) {
    closeMention()
    return
  }
  if (mention.value?.at !== at || mention.value.query !== query) mentionIndex.value = 0
  mention.value = { at, query }
}

/** 方向键上下由列表接管，松开时不能重算（会把高亮重置回第一项） */
function onKeyup(e: KeyboardEvent) {
  if (mentionOpen.value && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
  updateMention()
}

function pickMention(member: MentionMember) {
  const el = ta.value
  const m = mention.value
  if (!el || !m) return
  const end = el.selectionStart
  const insert = `@${member.name} `
  text.value = el.value.slice(0, m.at) + insert + el.value.slice(end)
  closeMention()
  const caret = m.at + insert.length
  void nextTick(() => {
    el.focus()
    el.setSelectionRange(caret, caret)
  })
}

function moveMention(step: number) {
  const n = mentionOptions.value.length
  mentionIndex.value = (mentionIndex.value + step + n) % n
  void nextTick(() =>
    mentionList.value
      ?.querySelector<HTMLElement>(`[data-index="${mentionIndex.value}"]`)
      ?.scrollIntoView({ block: 'nearest' }),
  )
}

/** 列表打开时接管方向键 / Enter / Tab / Esc；返回 true 表示已处理 */
function onMentionKey(e: KeyboardEvent): boolean {
  if (!mentionOpen.value) return false
  switch (e.key) {
    case 'ArrowDown':
      moveMention(1)
      break
    case 'ArrowUp':
      moveMention(-1)
      break
    case 'Enter':
    case 'Tab': {
      const pick = mentionOptions.value[mentionIndex.value]
      if (!pick) return false
      pickMention(pick)
      break
    }
    case 'Escape':
      dismissedAt = mention.value?.at ?? -1
      closeMention()
      break
    default:
      return false
  }
  e.preventDefault()
  e.stopPropagation()
  return true
}

function onKeydown(e: KeyboardEvent) {
  // 输入法组词期间不能拦截，否则中文候选选词会误触发送
  if (e.isComposing) return
  if (onMentionKey(e)) return
  if (e.key !== 'Enter') return
  if (e.shiftKey || e.ctrlKey || e.metaKey) return
  // 移动端 Enter 一律换行（没有 Shift 键可用）
  if (!props.sendOnEnter || window.matchMedia('(max-width: 767px)').matches) return
  e.preventDefault()
  submit()
}
</script>

<template>
  <div class="composer">
    <div class="inner">
      <!-- @ 提及成员列表。pointerdown.prevent：点选时输入框不失焦，手机键盘不收起 -->
      <ul
        v-if="mentionOpen"
        id="composer-mention-list"
        ref="mentionList"
        class="mention"
        role="listbox"
        aria-label="选择要提及的成员"
        @pointerdown.prevent
      >
        <li
          v-for="(c, i) in mentionOptions"
          :id="`composer-mention-${i}`"
          :key="c.id"
          :data-index="i"
          class="mention__item"
          :class="{ 'mention__item--active': i === mentionIndex }"
          role="option"
          :aria-selected="i === mentionIndex"
          @pointerenter="mentionIndex = i"
          @click="pickMention(c)"
        >
          <CbxAvatar :blob-id="c.avatarBlobId" :name="c.name" size="sm" />
          <span class="mention__name">{{ c.name }}</span>
        </li>
      </ul>
      <textarea
        ref="ta"
        v-model="text"
        class="cbx-textarea cbx-textarea--auto field"
        rows="1"
        aria-label="消息内容"
        :placeholder="members?.length ? '说点什么…输入 @ 提及成员' : '说点什么…'"
        aria-autocomplete="list"
        :aria-expanded="mentionOpen"
        :aria-controls="mentionOpen ? 'composer-mention-list' : undefined"
        :aria-activedescendant="mentionOpen ? `composer-mention-${mentionIndex}` : undefined"
        @keydown="onKeydown"
        @keyup="onKeyup"
        @input="updateMention"
        @click="updateMention"
        @blur="closeMention"
      />
      <div class="composer-footer">
        <span class="composer-hint" :class="{ 'composer-hint--busy': busy }" role="status">
          <template v-if="busy"><span class="status-dot" />正在回复…</template>
          <template v-else>
            <span class="desktop-hint">{{
              sendOnEnter ? 'Enter 发送 · Shift + Enter 换行' : 'Enter 换行 · 点击纸飞机发送'
            }}</span>
            <span class="mobile-hint">点击纸飞机发送</span>
          </template>
        </span>
        <button
          ref="action"
          type="button"
          class="send-button"
          :class="{ 'send-button--busy': busy, 'send-button--launching': flight && !busy }"
          :disabled="!busy && (!text.trim() || !!flight)"
          :aria-label="busy ? '停止生成' : '发送消息'"
          :title="busy ? '停止生成' : '发送消息'"
          @click="onAction"
        >
          <Square v-if="busy" :size="20" active fill="currentColor" aria-hidden="true" />
          <Send v-else class="send-icon" :size="20" aria-hidden="true" />
        </button>
      </div>
    </div>
  </div>
  <!-- 独立于按钮的飞行层：生成状态切换为停止按钮时，航迹仍然完整播放。 -->
  <Teleport to="body">
    <div v-if="flight" class="send-flight-layer" aria-hidden="true">
      <span
        :key="flight.id"
        class="send-flight"
        :style="{
          left: `${flight.x - 13}px`,
          top: `${flight.y - 13}px`,
          '--flight-dx': `${flight.dx}px`,
          '--flight-dy': `${-flight.dy}px`,
          '--flight-angle': `${flight.angle}deg`,
        }"
        @animationend.self="finishFlight"
      >
        <Send :size="24" fill="var(--cbx-bg)" />
      </span>
    </div>
  </Teleport>
</template>

<style scoped>
.composer {
  flex-shrink: 0;
  padding: var(--cbx-space-3) var(--cbx-space-6) var(--cbx-space-5);
  /* 移动端底部安全区（刘海屏 / 手势条） */
  padding-bottom: max(var(--cbx-space-5), var(--cbx-safe-b));
  background: linear-gradient(to bottom, transparent, var(--cbx-bg) 35%);
}
.inner {
  position: relative;
  display: flex;
  flex-direction: column;
  max-width: var(--cbx-read-w);
  margin: 0 auto;
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-xl);
  background: var(--cbx-bg);
  box-shadow: var(--cbx-shadow-sm);
  transition:
    border-color var(--cbx-transition),
    box-shadow var(--cbx-transition);
}
.inner:focus-within {
  border-color: var(--cbx-border-focus);
  box-shadow:
    0 0 0 3px var(--cbx-brand-subtle),
    var(--cbx-shadow-sm);
}
.mention {
  position: absolute;
  left: 0;
  bottom: calc(100% + var(--cbx-space-2));
  z-index: 20;
  width: min(280px, 100%);
  max-height: 264px;
  margin: 0;
  padding: var(--cbx-space-1);
  overflow-y: auto;
  overscroll-behavior: contain;
  list-style: none;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-lg);
  background: var(--cbx-bg);
  box-shadow: var(--cbx-shadow-md);
}
.mention__item {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  min-height: 44px;
  padding: var(--cbx-space-1) var(--cbx-space-3);
  border-radius: var(--cbx-radius-md);
  cursor: pointer;
  user-select: none;
}
.mention__item--active {
  background: var(--cbx-brand-light);
}
.mention__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text);
}
.field {
  min-height: 48px;
  max-height: 180px;
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border: 0;
  border-radius: 0;
  background: transparent;
  font-size: var(--cbx-fs-md);
  line-height: 1.65;
}
.field:focus {
  box-shadow: none;
}
.field::placeholder {
  color: var(--cbx-text-placeholder);
}
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cbx-space-3);
  padding-left: var(--cbx-space-3);
}
.composer-hint {
  display: inline-flex;
  align-items: center;
  gap: var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.composer-hint--busy {
  color: var(--cbx-brand);
}
.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 0 4px var(--cbx-brand-light);
}
.mobile-hint {
  display: none;
}
.send-button {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 50%;
  background: var(--cbx-brand);
  color: var(--cbx-text-on-brand);
  cursor: pointer;
  transition:
    background var(--cbx-transition),
    box-shadow var(--cbx-transition),
    transform var(--cbx-transition);
}
.send-button:hover:not(:disabled) {
  background: var(--cbx-brand-hover);
  box-shadow: 0 4px 14px var(--cbx-brand-light-hover);
}
.send-button:active:not(:disabled) {
  transform: scale(0.94);
}
.send-button:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 3px;
}
.send-button:disabled {
  cursor: default;
  color: var(--cbx-text-disabled);
  background: var(--cbx-bg-secondary);
}

.send-button--launching .send-icon {
  visibility: hidden;
}
.send-button--busy {
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
  border-color: var(--cbx-brand-light-hover);
}
.send-button--busy:hover:not(:disabled) {
  background: var(--cbx-brand-light-hover);
}
.send-flight-layer {
  position: fixed;
  inset: 0;
  z-index: 1200;
  pointer-events: none;
  overflow: clip;
}
.send-flight {
  position: absolute;
  width: 26px;
  height: 26px;
  color: var(--cbx-brand);
  filter: drop-shadow(0 3px 5px var(--cbx-brand-light-hover));
  animation: plane-flight 780ms cubic-bezier(0.4, 0, 0.6, 1) both;
}
.send-flight::before {
  content: '';
  position: absolute;
  width: 30px;
  height: 2px;
  left: -24px;
  top: 34px;
  border-radius: var(--cbx-radius-pill);
  background: linear-gradient(to right, transparent, var(--cbx-brand));
  transform: rotate(-45deg);
  opacity: 0.45;
}
@keyframes plane-flight {
  0% {
    transform: translate(0, 0) rotate(0) scale(1);
    opacity: 1;
  }
  18% {
    transform: translate(-7px, 5px) rotate(-10deg) scale(1.08);
    opacity: 1;
  }
  65% {
    transform: translate(calc(var(--flight-dx) * 0.55), calc(var(--flight-dy) * 0.5))
      rotate(var(--flight-angle)) scale(0.95);
    opacity: 1;
  }
  100% {
    transform: translate(var(--flight-dx), var(--flight-dy)) rotate(var(--flight-angle)) scale(0.45);
    opacity: 0;
  }
}

@media (max-width: 767px) {
  .composer {
    padding-left: var(--cbx-space-3);
    padding-right: var(--cbx-space-3);
    padding-bottom: max(var(--cbx-space-3), var(--cbx-safe-b));
  }
  .inner {
    padding: var(--cbx-space-2);
    border-radius: var(--cbx-radius-lg);
  }
  .mention {
    width: 100%;
    max-height: 40vh;
  }
  .desktop-hint {
    display: none;
  }
  .mobile-hint {
    display: inline;
  }
}
@media (prefers-reduced-motion: reduce) {
  .send-flight-layer {
    display: none;
  }
  .send-flight {
    animation: none;
  }
  .inner,
  .send-button,
  .send-icon {
    transition: none;
  }
  .send-button:hover:not(:disabled) .send-icon,
  .send-button:active:not(:disabled) {
    transform: none;
  }
}
</style>
