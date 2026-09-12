<script setup lang="ts">
/**
 * 移动端虚拟摇杆。
 *
 * ⚠️ 两条硬要求，都只在真机上才暴露：
 * 1. `touch-action: none` —— 不写的话拖摇杆会变成页面滚动、双指变成系统缩放，
 *    **桌面调试完全发现不了**。
 * 2. `pointercancel` 必须与 `pointerup` 走同一个处理：iOS 的系统手势
 *    （从边缘上滑、来电横幅等）会插进来发 cancel，只监听 up 的话摇杆会
 *    卡在「一直按着」的状态，角色停不下来。
 */
import { ref } from 'vue'

const emit = defineEmits<{ move: [x: number, y: number] }>()

/** 摇杆半径（px）。手指拖到这个距离就是满舵 */
const R = 46

const root = ref<HTMLElement | null>(null)
const active = ref(false)
const knob = ref({ x: 0, y: 0 })
let pointerId = -1
let originX = 0
let originY = 0

function begin(e: PointerEvent) {
  if (active.value) return
  const el = root.value
  if (!el) return
  const r = el.getBoundingClientRect()
  originX = r.left + r.width / 2
  originY = r.top + r.height / 2
  pointerId = e.pointerId
  active.value = true
  // 捕获指针：手指滑出摇杆范围也继续跟手，否则快速划动会中途断开
  el.setPointerCapture(e.pointerId)
  update(e)
}

function update(e: PointerEvent) {
  if (!active.value || e.pointerId !== pointerId) return
  let dx = e.clientX - originX
  let dy = e.clientY - originY
  const len = Math.hypot(dx, dy)
  if (len > R) {
    dx = (dx / len) * R
    dy = (dy / len) * R
  }
  knob.value = { x: dx, y: dy }
  emit('move', dx / R, dy / R)
}

function end(e: PointerEvent) {
  if (e.pointerId !== pointerId) return
  active.value = false
  pointerId = -1
  knob.value = { x: 0, y: 0 }
  emit('move', 0, 0)
}
</script>

<template>
  <div
    ref="root"
    class="pad"
    :class="{ 'pad--on': active }"
    @pointerdown.prevent="begin"
    @pointermove.prevent="update"
    @pointerup="end"
    @pointercancel="end"
    @pointerleave="end"
  >
    <div class="pad__knob" :style="{ transform: `translate(${knob.x}px, ${knob.y}px)` }" />
  </div>
</template>

<style scoped>
.pad {
  position: absolute;
  left: var(--cbx-space-4);
  bottom: max(var(--cbx-space-4), var(--cbx-safe-b));
  z-index: 4;
  /* 尺寸由 RpgPlayView 的 .stage 下发：靠近提示要按它抬高，不能各写一份 */
  width: var(--rpg-pad-size, 112px);
  height: var(--rpg-pad-size, 112px);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.18);
  border: 2px solid rgba(255, 255, 255, 0.35);
  display: grid;
  place-items: center;
  /* 见文件头：不写这条，手机上拖摇杆会变成滚页面 */
  touch-action: none;
  overscroll-behavior: contain;
  transition: background var(--cbx-transition);
}
.pad--on {
  background: rgba(255, 255, 255, 0.3);
}
.pad__knob {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.85);
  box-shadow: var(--cbx-shadow-md);
  pointer-events: none;
}

/* 能 hover 的精确指针设备用键盘就够了，不占画面 */
@media (hover: hover) and (pointer: fine) {
  .pad {
    display: none;
  }
}
</style>
