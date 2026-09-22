<script setup lang="ts">
/**
 * 会话展开的「图片」子表：单游标扫该会话消息收集引用（force_avatar + images），
 * 再单事务批量取 blob 元数据。只读 —— 引用中的图片不能单删，孤儿走「清理未引用」。
 */
import { onMounted, ref } from 'vue'
import { blobsRepo, browseRepo } from '@/db/repositories'
import { useBlobPreview } from '@/composables/useBlobPreview'
import BlobThumb from './BlobThumb.vue'
import BlobLightbox from './BlobLightbox.vue'

const props = defineProps<{ chatId: string }>()

interface ImgRow {
  id: string
  mime: string
  size: number
  createdAt?: number
  refs: number
}
const rows = ref<ImgRow[]>([])
const loading = ref(true)

function fmtTime(t?: number) {
  return t ? new Date(t).toLocaleString() : '—'
}

/** 点缩略图放大预览（带 View Transitions 形变） */
const preview = useBlobPreview()
function openPreview(r: ImgRow) {
  void preview.open(r.id, `${r.mime} · ${(r.size / 1024).toFixed(1)}KB · ${fmtTime(r.createdAt)}`)
}

onMounted(async () => {
  try {
    const refs = await browseRepo.chatBlobRefs(props.chatId)
    const records = await blobsRepo.getMany([...refs.keys()])
    rows.value = [...refs.entries()]
      .map(([id, refs2]) => {
        const rec = records[id]
        return {
          id,
          mime: rec?.mime ?? '（已丢失）',
          size: rec?.size ?? 0,
          createdAt: rec?.createdAt,
          refs: refs2,
        }
      })
      .sort((a, b) => b.refs - a.refs)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="imgtab">
    <p class="cbx-field__hint">
      本会话消息引用的图片（含强制头像）。图片被消息引用着，不能单独删除；
      换封面 / 删消息后产生的孤儿可在下方「其他数据 · 图片」里清理。
    </p>
    <div class="dtblwrap cbx-scroll">
      <table class="dtbl">
        <thead>
          <tr>
            <th>预览</th>
            <th>类型</th>
            <th>大小</th>
            <th>引用次数</th>
            <th>时间</th>
            <th>blobId</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="dpreview">
              <button
                type="button"
                class="dpreview__btn"
                :style="preview.thumbStyle(r.id)"
                aria-label="放大预览这张图片"
                @click="openPreview(r)"
              >
                <BlobThumb :blob-id="r.id" />
              </button>
            </td>
            <td>{{ r.mime }}</td>
            <td class="dnum">{{ (r.size / 1024).toFixed(1) }}KB</td>
            <td class="dnum">{{ r.refs }}</td>
            <td>{{ fmtTime(r.createdAt) }}</td>
            <td class="dtbl__clip dzero" :title="r.id">{{ r.id }}</td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td colspan="6" class="dzero">本会话没有引用图片</td>
          </tr>
        </tbody>
      </table>
    </div>

    <BlobLightbox
      :blob-id="preview.id.value"
      :caption="preview.caption.value"
      :morph-style="preview.stageStyle.value"
      @close="preview.close()"
    />
  </div>
</template>

<style scoped src="@/assets/styles/data-tables.css"></style>
<style scoped>
.imgtab {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  min-width: 0;
}
.dpreview__btn {
  display: block;
  padding: 0;
  border: 0;
  background: none;
  border-radius: var(--cbx-radius-sm);
  cursor: zoom-in;
}
.dpreview__btn:focus-visible {
  outline: 2px solid var(--cbx-brand);
  outline-offset: 2px;
}
</style>
