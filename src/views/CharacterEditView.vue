<script setup lang="ts">
import AppTopbar from '@/components/layout/AppTopbar.vue'
</script>

<template>
  <AppTopbar title="编辑角色" />
  <div class="cbx-scroll body">
    <div class="cbx-empty">
      <span class="cbx-empty__icon">🎭</span>
      <span class="cbx-empty__title">编辑角色</span>
      <span class="cbx-empty__desc">角色编辑器（阶段 2）</span>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
</style>
