<script setup lang="ts">
import AppIcon from './AppIcon.vue'
defineProps<{ open?: boolean }>()
</script>

<template>
  <AppIcon name="Menu" tone="brand" :active="open" />
</template>
