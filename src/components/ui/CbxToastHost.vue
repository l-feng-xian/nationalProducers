<script setup lang="ts">
import { useToast, type Toast } from '@/composables/useToast'

const { items, dismiss } = useToast()

/** 点提示：有操作就执行，然后收起 */
function onClick(t: Toast) {
  dismiss(t.id)
  t.action?.run()
}
</script>

<template>
  <Teleport to="body">
    <div class="host">
      <TransitionGroup name="toast">
        <div
          v-for="t in items"
          :key="t.id"
          class="toast"
          :class="[`toast--${t.kind}`, { 'toast--action': t.action }]"
          :role="t.action ? 'button' : undefined"
          :tabindex="t.action ? 0 : undefined"
          @click="onClick(t)"
          @keydown.enter="onClick(t)"
        >
          {{ t.text }}<span v-if="t.action" class="toast__action">{{ t.action.label }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.host {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  /* 页面上方：顶栏之下、随系统安全区避让刘海 */
  top: calc(var(--cbx-topbar-h) + var(--cbx-space-3) + env(safe-area-inset-top, 0px));
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  align-items: center;
  pointer-events: none;
  width: min(92vw, 520px);
}
.toast {
  pointer-events: auto;
  cursor: pointer;
  padding: var(--cbx-space-3) var(--cbx-space-4);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg);
  border: 1px solid var(--cbx-border);
  box-shadow: var(--cbx-shadow-md);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text);
  max-width: 100%;
  overflow-wrap: anywhere;
}
.toast__action {
  margin-left: var(--cbx-space-3);
  color: var(--cbx-brand);
  font-weight: var(--cbx-fw-medium);
  white-space: nowrap;
}
.toast--action:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 2px;
}
.toast--success {
  border-left: 3px solid var(--cbx-success);
}
.toast--error {
  border-left: 3px solid var(--cbx-error);
}
.toast--warning {
  border-left: 3px solid var(--cbx-warning);
}
.toast--info {
  border-left: 3px solid var(--cbx-brand);
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  /* 从上方滑入 / 向上方滑出 —— 与「提示在顶部」的方向一致 */
  transform: translateY(-8px);
}
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--cbx-transition),
    transform var(--cbx-transition);
}
</style>
