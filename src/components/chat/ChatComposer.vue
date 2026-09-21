<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Send, Square } from 'lucide-vue-next'

const props = defineProps<{ busy: boolean; sendOnEnter: boolean }>()
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

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter') return
  // 输入法组词期间不能拦截，否则中文候选选词会误触发送
  if (e.isComposing) return
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
      <textarea
        ref="ta"
        v-model="text"
        class="cbx-textarea cbx-textarea--auto field"
        rows="1"
        aria-label="消息内容"
        placeholder="说点什么…"
        @keydown="onKeydown"
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
          <Square v-if="busy" :size="17" :stroke-width="2" fill="currentColor" aria-hidden="true" />
          <Send v-else class="send-icon" :size="23" :stroke-width="1.8" aria-hidden="true" />
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
        <Send :size="26" :stroke-width="1.8" fill="var(--cbx-bg)" />
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
.send-icon {
  transition: transform 200ms var(--cbx-ease);
}
.send-button:hover:not(:disabled) .send-icon {
  transform: translate(1px, -1px) rotate(-8deg);
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
