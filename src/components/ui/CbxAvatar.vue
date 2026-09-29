<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import { useObjectUrl } from '@/composables/useObjectUrl'
import { useImagePreview } from '@/composables/useImagePreview'

const props = withDefaults(
  defineProps<{
    blobId?: string | undefined
    name?: string
    size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl'
    card?: boolean
    /** 点击打开全站统一预览（有图时才生效）。父级的点击不会被触发 */
    previewable?: boolean
  }>(),
  { size: 'md', name: '', card: false, previewable: false },
)

const { url } = useObjectUrl(toRef(props, 'blobId'))
const initial = computed(() => (props.name || '?').slice(0, 1))
const cls = computed(() => [
  'cbx-avatar',
  props.size !== 'md' ? `cbx-avatar--${props.size}` : '',
  props.card ? 'cbx-avatar--card' : '',
])

const img = ref<HTMLImageElement | null>(null)
const preview = useImagePreview()
function openPreview() {
  if (!props.blobId) return
  void preview.open([{ blobId: props.blobId, caption: props.name }], 0, img.value)
}
</script>

<template>
  <button
    v-if="url && previewable"
    type="button"
    class="cbx-avatar-btn"
    :class="{ 'cbx-avatar-btn--card': card }"
    :aria-label="name ? `预览${name}的图片` : '预览图片'"
    @click.stop="openPreview"
  >
    <img ref="img" :class="cls" :src="url" :alt="name" draggable="false" />
  </button>
  <img v-else-if="url" :class="cls" :src="url" :alt="name" />
  <div v-else :class="[...cls, 'cbx-avatar__fallback']">{{ initial }}</div>
</template>
