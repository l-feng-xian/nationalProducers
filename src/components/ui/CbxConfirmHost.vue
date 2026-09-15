<script setup lang="ts">
/**
 * 全局确认弹窗的宿主（挂在 App.vue，与 CbxToastHost 平级）。
 * 弹窗由 useConfirm() 的模块级状态驱动，任何组件都能 await confirmDialog()。
 *
 * 键盘：Enter 确认、Esc 取消。用**捕获阶段**拦截并 stopPropagation ——
 * 避免确认框打开时同时触发页面上的快捷键。
 */
import { onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { useConfirm } from '@/composables/useConfirm'

const { state, settle } = useConfirm()
const confirmBtn = ref<HTMLButtonElement | null>(null)

function onKeydown(e: KeyboardEvent) {
  if (!state.value) return
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    settle(e.key === 'Enter')
  }
}
onMounted(() => window.addEventListener('keydown', onKeydown, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown, true))

// 弹窗出现后把焦点放到确认钮上：Enter 直接确认，触屏键盘也不会乱跳
watch(state, (s) => {
  if (s) nextTick(() => confirmBtn.value?.focus())
})
</script>

<template>
  <Teleport to="body">
    <div v-if="state" class="cbx-modal__scrim confirm-scrim" @click.self="settle(false)">
      <div class="cbx-modal confirm" role="alertdialog" aria-modal="true">
        <header class="cbx-modal__head">
          <h3>{{ state.title }}</h3>
        </header>
        <div class="cbx-modal__body confirm__text">{{ state.text }}</div>
        <footer class="cbx-modal__foot">
          <button class="cbx-btn cbx-btn--ghost" @click="settle(false)">
            {{ state.cancelText }}
          </button>
          <button
            ref="confirmBtn"
            class="cbx-btn confirm__ok"
            :class="{ 'confirm__ok--danger': state.danger }"
            @click="settle(true)"
          >
            {{ state.confirmText }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Teleport 到 body 末尾,与其它 cbx-modal 同 z 层时按 DOM 序盖在其上 */
.confirm-scrim {
  z-index: 120;
}
.confirm {
  max-width: 440px;
}
.confirm__text {
  font-size: var(--cbx-fs-sm);
  line-height: 1.7;
  color: var(--cbx-text);
  overflow-wrap: anywhere;
}
/* 默认（非危险）确认钮：主色描边 */
.confirm__ok {
  background: var(--cbx-brand);
  border-color: var(--cbx-brand);
  color: var(--cbx-bg);
}
.confirm__ok:hover:not(:disabled) {
  filter: brightness(1.05);
}
/* 危险确认钮：红。与 error 徽章同一对令牌 */
.confirm__ok--danger {
  background: var(--cbx-error);
  border-color: var(--cbx-error);
  color: #fff;
}
</style>
