<script setup lang="ts">
import { computed } from 'vue'
import { Download } from '@/components/icons'
import { useObjectUrl } from '@/composables/useObjectUrl'
import { blobsRepo } from '@/db/repositories'
import { downloadBlob, safeFileName } from '@/utils/download'
import { useToast } from '@/composables/useToast'
import type { MessageImage } from '@/types/image'
const props = defineProps<{ image: MessageImage }>()
const emit = defineEmits<{ loaded: []; open: [el: HTMLElement] }>()
const { url } = useObjectUrl(computed(() => props.image.blobId))
const toast = useToast()

/**
 * 保存配图。原本是 `<a :href="blobUrl" download>`，而**安卓 WebView 不处理
 * blob: 下载** —— 点了毫无反应。统一走 downloadBlob，原生壳里会弹系统保存框。
 * 直接从库里取原始 Blob，不用再 fetch 一遍 objectURL。
 */
async function saveImage() {
  const blob = await blobsRepo.get(props.image.blobId)
  if (!blob) {
    toast.error('配图已丢失')
    return
  }
  const ext = (props.image.width && blob.type.split('/')[1]) || 'png'
  const at = await downloadBlob(blob, safeFileName('对话配图', ext, '对话配图'))
  if (at) toast.success(`已保存到 ${at}`)
}

/**
 * 附图时存下的像素尺寸 → 用 aspect-ratio 把高度**先占住**，Blob 还在从
 * IndexedDB 里读的时候这一格就已经是最终高度，不会「先一行字、再撑满」跳两次。
 * 老记录没存尺寸，回退到不占位（与改动前一致）。
 */
/** 把图片元素交出去做缩略图 → 大图的形变 */
function onOpen(e: MouseEvent) {
  const el =
    (e.currentTarget as HTMLElement).querySelector('img') ?? (e.currentTarget as HTMLElement)
  emit('open', el)
}

const frameStyle = computed(() => {
  const { width, height } = props.image
  return width && height ? { aspectRatio: `${width} / ${height}` } : undefined
})
</script>

<template>
  <figure class="message-image" :data-blob-id="image.blobId">
    <!-- 不用 loading="lazy"：虚拟滚动本身已经是窗口化，再叠一层浏览器懒加载
         只会让高度在滚入后又变一次 -->
    <!-- 原来是 <a target="_blank"> 开新标签：安卓 WebView 里没有标签页，点了没反应。
         改为应用内的统一预览（useImagePreview：可缩放、可左右切换本会话的全部配图） -->
    <button
      v-if="url"
      type="button"
      class="frame"
      :style="frameStyle"
      aria-label="查看大图"
      @click="onOpen"
    >
      <img :src="url" alt="根据对话生成的配图" draggable="false" @load="emit('loaded')" />
    </button>
    <span v-else class="placeholder frame" :style="frameStyle">正在读取配图…</span>
    <figcaption>
      <span>{{ image.serviceName }} · {{ image.model }}</span
      ><button
        v-if="url"
        type="button"
        class="save"
        aria-label="保存配图"
        title="保存配图"
        @click="saveImage"
      >
        <Download :size="16" />
      </button>
    </figcaption>
    <details>
      <summary>画面描述</summary>
      <p>{{ image.prompt }}</p>
    </details>
  </figure>
</template>

<style scoped>
/* 「定位到配图」时闪一下（ChatView.revealImage 临时加上 message-image--flash） */
.message-image--flash .frame {
  animation: image-flash 1.6s var(--cbx-ease);
}
@keyframes image-flash {
  0%,
  60% {
    box-shadow: 0 0 0 3px var(--cbx-brand);
  }
  100% {
    box-shadow: 0 0 0 3px transparent;
  }
}
@media (prefers-reduced-motion: reduce) {
  .message-image--flash .frame {
    animation: none;
    box-shadow: 0 0 0 3px var(--cbx-brand);
  }
}
.message-image {
  margin: 12px 0 0;
  width: min(100%, 420px);
}
/* 占位框：有尺寸时 aspect-ratio 撑开，没有则退回内容高度 */
.frame {
  display: block;
  width: 100%;
  max-height: 560px;
}
img {
  display: block;
  width: 100%;
  height: 100%;
  max-height: 560px;
  object-fit: contain;
  border-radius: var(--cbx-radius-sm);
}
.placeholder.frame {
  display: grid;
  place-items: center;
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-bg-secondary);
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
button.frame {
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
  -webkit-touch-callout: none;
}
button.frame:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 2px;
}
.save {
  display: inline-flex;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
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
