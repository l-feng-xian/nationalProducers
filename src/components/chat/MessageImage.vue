<script setup lang="ts">
import { computed } from 'vue'
import { Download } from 'lucide-vue-next'
import { useObjectUrl } from '@/composables/useObjectUrl'
import type { MessageImage } from '@/types/image'
const props = defineProps<{ image: MessageImage }>()
const emit = defineEmits<{ loaded: [] }>()
const { url } = useObjectUrl(computed(() => props.image.blobId))
</script>

<template>
  <figure class="message-image">
    <a v-if="url" :href="url" target="_blank" rel="noopener" aria-label="查看对话配图原图"
      ><img :src="url" alt="根据对话生成的配图" loading="lazy" @load="emit('loaded')"
    /></a>
    <span v-else class="placeholder">正在读取配图…</span>
    <figcaption>
      <span>{{ image.serviceName }} · {{ image.model }}</span
      ><a v-if="url" :href="url" download="对话配图" aria-label="下载配图" title="下载配图"
        ><Download :size="16"
      /></a>
    </figcaption>
    <details>
      <summary>画面描述</summary>
      <p>{{ image.prompt }}</p>
    </details>
  </figure>
</template>

<style scoped>
.message-image {
  margin: 12px 0 0;
  width: min(100%, 420px);
}
img {
  display: block;
  width: 100%;
  max-height: 560px;
  object-fit: contain;
  border-radius: var(--cbx-radius-sm);
}
figcaption {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 8px;
  font-size: var(--cbx-fs-xs);
  opacity: 0.8;
}
figcaption span {
  overflow-wrap: anywhere;
}
a {
  color: inherit;
}
details {
  margin-top: 6px;
  font-size: var(--cbx-fs-xs);
}
summary {
  cursor: pointer;
}
p {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 160px;
  overflow: auto;
}
.placeholder {
  font-size: var(--cbx-fs-xs);
}
</style>
