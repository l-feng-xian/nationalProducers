<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'

const props = defineProps<{ busy: boolean; sendOnEnter: boolean }>()
const emit = defineEmits<{ send: [text: string]; stop: [] }>()

const text = ref('')
const ta = ref<HTMLTextAreaElement | null>(null)
const MAX_H = 180

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
  if (!t || props.busy) return
  emit('send', t)
  text.value = ''
  void nextTick(autosize)
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
        placeholder="说点什么…"
        @keydown="onKeydown"
      />
      <button v-if="busy" class="cbx-btn cbx-btn--ghost act" title="停止生成" @click="emit('stop')">
        ■ 停止
      </button>
      <button v-else class="cbx-btn cbx-btn--primary act" :disabled="!text.trim()" @click="submit">
        发送
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer {
  flex-shrink: 0;
  border-top: 1px solid var(--cbx-border);
  padding: var(--cbx-space-3) var(--cbx-space-5);
  /* 移动端底部安全区（刘海屏 / 手势条） */
  padding-bottom: max(var(--cbx-space-3), var(--cbx-safe-b));
  background: var(--cbx-bg);
}
.inner {
  display: flex;
  align-items: flex-end;
  gap: var(--cbx-space-2);
  max-width: var(--cbx-read-w);
  margin: 0 auto;
}
.field {
  flex: 1;
  min-height: 40px;
  max-height: 180px;
}
.act {
  flex-shrink: 0;
}

@media (max-width: 767px) {
  .composer {
    padding-left: var(--cbx-space-3);
    padding-right: var(--cbx-space-3);
  }
}
</style>
