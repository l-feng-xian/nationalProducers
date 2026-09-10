<script setup lang="ts">
import AppTopbar from '@/components/layout/AppTopbar.vue'
</script>

<template>
  <AppTopbar title="群聊设置" />
  <div class="cbx-scroll body">
    <div class="cbx-empty">
      <span class="cbx-empty__icon">👥</span>
      <span class="cbx-empty__title">群聊设置</span>
      <span class="cbx-empty__desc">群聊与关系图谱（阶段 4）</span>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
</style>
