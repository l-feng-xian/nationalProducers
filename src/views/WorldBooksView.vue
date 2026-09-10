<script setup lang="ts">
import AppTopbar from '@/components/layout/AppTopbar.vue'
</script>

<template>
  <AppTopbar title="世界书" />
  <div class="cbx-scroll body">
    <div class="cbx-empty">
      <span class="cbx-empty__icon">📚</span>
      <span class="cbx-empty__title">世界书</span>
      <span class="cbx-empty__desc">世界书管理（阶段 3）</span>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
</style>
