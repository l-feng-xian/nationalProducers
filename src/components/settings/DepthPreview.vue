<script setup lang="ts">
import { computed } from 'vue'

/**
 * 插入深度语义可视化。
 *
 * 「depth」是整个应用里最容易被误解的概念：直觉上会以为数字越大越靠前，
 * 或者以为 depth 0 是拼到最后一条消息上。用四条假消息演示一遍，
 * 比写三行说明有效得多。
 */
const props = defineProps<{ depth: number }>()

const FAKE = ['…更早的消息', '我：你好', '角色：你好呀', '我：在吗']

/** depth N = 注入之后仍有 N 条真实消息 → 插入位置 = 总数 - N */
const slot = computed(() => Math.max(0, FAKE.length - Math.max(0, props.depth)))
</script>

<template>
  <div class="dp">
    <template v-for="(m, i) in FAKE" :key="i">
      <div v-if="i === slot" class="dp__inject">⬅ 提示词插在这里</div>
      <div class="dp__msg">{{ m }}</div>
    </template>
    <div v-if="slot >= FAKE.length" class="dp__inject">⬅ 提示词插在这里</div>
    <div class="dp__gen">（模型从这里开始生成）</div>
  </div>
</template>

<style scoped>
.dp {
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  padding: var(--cbx-space-2);
  background: var(--cbx-bg-secondary);
  font-size: var(--cbx-fs-xs);
}
.dp__msg {
  padding: var(--cbx-space-1) var(--cbx-space-2);
  color: var(--cbx-text-secondary);
}
.dp__inject {
  padding: var(--cbx-space-1) var(--cbx-space-2);
  margin: 2px 0;
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-brand-light);
  color: var(--cbx-brand);
  font-weight: var(--cbx-fw-medium);
}
.dp__gen {
  padding: var(--cbx-space-1) var(--cbx-space-2);
  color: var(--cbx-text-tertiary);
  border-top: 1px dashed var(--cbx-border);
  margin-top: var(--cbx-space-1);
}
</style>
