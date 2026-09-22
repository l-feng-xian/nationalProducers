<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
/**
 * 会话展开的「向量块」子表：只读元数据分页（vec 被仓储层剥离成维度/字节）。
 * 向量是派生数据，可整段清除后自动重建 —— 这里只提供浏览与入口提示。
 */
import { computed, onMounted, ref } from 'vue'
import { memchunksRepo } from '@/db/repositories'
import type { ChunkMetaRow } from '@/db/repositories/memchunks'

const props = defineProps<{ chatId: string; chunkCount: number }>()

const PAGE = 50
const rows = ref<ChunkMetaRow[]>([])
const hasMore = ref(false)
/** 每页的 before 值栈（[kindRank, ord]）；首页为 [undefined]（最旧一页） */
const stack = ref<([number, number] | undefined)[]>([undefined])
const loading = ref(false)

const totalPages = computed(() => Math.max(1, Math.ceil(props.chunkCount / PAGE)))
const pageNo = computed(() => stack.value.length)

async function load(before?: [number, number]) {
  loading.value = true
  try {
    const r = await memchunksRepo.pageByChat(props.chatId, { limit: PAGE, before })
    rows.value = r.rows
    hasMore.value = r.hasMore
  } finally {
    loading.value = false
  }
}
function next() {
  if (!hasMore.value || loading.value || !rows.value.length) return
  const last = rows.value.at(-1)!
  stack.value = [...stack.value, [last.kindRank, last.ord]]
  void load([last.kindRank, last.ord])
}
function prev() {
  if (stack.value.length <= 1 || loading.value) return
  stack.value = stack.value.slice(0, -1)
  void load(stack.value.at(-1))
}
const kindLabel = (k: 0 | 1) => (k === 0 ? '窗口' : '事实')

onMounted(() => void load(undefined))
</script>

<template>
  <div class="chunktab">
    <p class="cbx-field__hint">
      向量块是从消息推导的派生数据（检索用），清除后会在后续对话中自动重建。
      共 {{ chunkCount }} 块。
    </p>
    <div class="dtblwrap cbx-scroll">
      <table class="dtbl">
        <thead>
          <tr>
            <th>类型</th>
            <th>ord</th>
            <th>seq 区间</th>
            <th>覆盖</th>
            <th>维度</th>
            <th>大小</th>
            <th>内容</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in rows" :key="`${c.kindRank}-${c.ord}`">
            <td>{{ kindLabel(c.kindRank) }}</td>
            <td class="dnum">{{ c.ord }}</td>
            <td class="dnum">{{ c.startSeq }}–{{ c.endSeq }}</td>
            <td class="dnum">{{ c.srcCount }}</td>
            <td class="dnum">{{ c.dims }}</td>
            <td class="dnum">{{ (c.bytes / 1024).toFixed(1) }}KB</td>
            <td class="dtbl__clip" :title="c.textPreview">{{ c.textPreview }}</td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td colspan="7" class="dzero">还没有向量块</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="dpager">
      <span class="dpager__info">第 {{ pageNo }} / {{ totalPages }} 页</span>
      <div class="dpager__acts">
        <button class="cbx-btn cbx-btn--ghost sm" :disabled="stack.length <= 1 || loading" @click="prev">
          <AppIcon name="ArrowLeft" /> 上一页
        </button>
        <button class="cbx-btn cbx-btn--ghost sm" :disabled="!hasMore || loading" @click="next">
          下一页 <AppIcon name="ArrowRight" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped src="@/assets/styles/data-tables.css"></style>
<style scoped>
.chunktab {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  min-width: 0;
}
.sm {
  height: 32px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
</style>
