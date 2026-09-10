<script setup lang="ts">
import { computed, toRef } from 'vue'
import { useObjectUrl } from '@/composables/useObjectUrl'

const props = withDefaults(
  defineProps<{
    blobId?: string | undefined
    name?: string
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
    card?: boolean
  }>(),
  { size: 'md', name: '', card: false },
)

const { url } = useObjectUrl(toRef(props, 'blobId'))
const initial = computed(() => (props.name || '?').slice(0, 1))
const cls = computed(() => [
  'cbx-avatar',
  props.size !== 'md' ? `cbx-avatar--${props.size}` : '',
  props.card ? 'cbx-avatar--card' : '',
])
</script>

<template>
  <img v-if="url" :class="cls" :src="url" :alt="name" />
  <div v-else :class="[...cls, 'cbx-avatar__fallback']">{{ initial }}</div>
</template>
