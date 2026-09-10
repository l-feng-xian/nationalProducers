<script setup lang="ts">
import AppTopbar from '@/components/layout/AppTopbar.vue'
</script>

<template>
  <AppTopbar title="设置" />
  <div class="cbx-scroll body">
    <div class="cbx-empty">
      <span class="cbx-empty__icon">⚙️</span>
      <span class="cbx-empty__title">设置</span>
      <span class="cbx-empty__desc">全局配置（阶段 1 起逐步补齐）</span>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
</style>
