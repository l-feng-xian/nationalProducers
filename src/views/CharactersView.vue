<script setup lang="ts">
import AppTopbar from '@/components/layout/AppTopbar.vue'
</script>

<template>
  <AppTopbar title="角色" />
  <div class="cbx-scroll body">
    <div class="cbx-empty">
      <span class="cbx-empty__icon">🎭</span>
      <span class="cbx-empty__title">角色</span>
      <span class="cbx-empty__desc">还没有角色，点右上角新建</span>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
</style>
