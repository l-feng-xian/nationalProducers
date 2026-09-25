<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
/**
 * 会话展开的「消息」子表：游标分页浏览，绝不全量加载。
 *
 * 复用 messagesRepo.page()（此前零调用方的预留 API）：第 1 页是最新 50 条，
 * 「更早」用本页首行 seq 作 before 向上翻；「更新」用页栈回退。
 */
import { computed, onMounted, ref } from 'vue'
import { messagesRepo } from '@/db/repositories'
import type { ChatMessage } from '@/types/chat'

const props = defineProps<{ chatId: string; messageCount: number }>()

const PAGE = 50
const rows = ref<ChatMessage[]>([])
const hasOlder = ref(false)
/** 每页的 before 值栈；首页为 [undefined]（最新一页） */
const stack = ref<(number | undefined)[]>([undefined])
const loading = ref(false)
const selected = ref<ChatMessage | null>(null)

const totalPages = computed(() => Math.max(1, Math.ceil(props.messageCount / PAGE)))
/** 当前是第几页（从最新往回数） */
const pageNo = computed(() => totalPages.value - (stack.value.length - 1))

async function load(before?: number) {
  loading.value = true
  try {
    const r = await messagesRepo.page(props.chatId, { limit: PAGE, before })
    rows.value = r.rows
    hasOlder.value = r.hasMore
    if (!r.rows.some((m) => m.id === selected.value?.id)) selected.value = null
  } finally {
    loading.value = false
  }
}

function older() {
  if (!hasOlder.value || loading.value || !rows.value.length) return
  const first = rows.value[0]!
  stack.value = [...stack.value, first.seq]
  void load(first.seq)
}
function newer() {
  if (stack.value.length <= 1 || loading.value) return
  stack.value = stack.value.slice(0, -1)
  void load(stack.value.at(-1))
}

function preview(m: ChatMessage) {
  const text = m.mes.replace(/\s+/g, ' ').trim()
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || '（空）'
}
function who(m: ChatMessage) {
  if (m.is_system) return '系统'
  return m.is_user ? '你' : m.name || '？'
}
function timeOf(m: ChatMessage) {
  const d = new Date(m.send_date)
  const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const today = new Date().toDateString() === d.toDateString()
  return today ? hm : `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${hm}`
}
/** JSON 详情截断阈值：超长正文只展示开头，防几 MB 消息卡死渲染 */
const detailJson = computed(() => {
  if (!selected.value) return ''
  let text = ''
  try {
    text = JSON.stringify(selected.value, null, 2)
  } catch {
    return '（无法序列化）'
  }
  return text.length > 100_000 ? `${text.slice(0, 100_000)}\n…（内容过长，已截断）` : text
})

onMounted(() => void load(undefined))
</script>

<template>
  <div class="msgtab">
    <div class="dtblwrap">
      <table class="dtbl">
        <thead>
          <tr>
            <th>seq</th>
            <th>角色</th>
            <th>内容</th>
            <th>图片</th>
            <th>候选</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="m in rows"
            :key="m.id"
            class="dtbl__row"
            :class="{ 'dtbl__row--on': selected?.id === m.id }"
            @click="selected = selected?.id === m.id ? null : m"
          >
            <td class="dnum" data-label="seq">{{ m.seq }}</td>
            <td data-label="角色">{{ who(m) }}</td>
            <td class="dtbl__clip dcell--wide" :title="m.mes">{{ preview(m) }}</td>
            <td class="dnum" data-label="图片" :class="{ dzero: !m.images?.length }">
              {{ m.images?.length ?? 0 }}
            </td>
            <td class="dnum" data-label="候选" :class="{ dzero: (m.swipes?.length ?? 0) < 2 }">
              {{
                (m.swipes?.length ?? 0) < 2 ? '—' : `${(m.swipe_id ?? 0) + 1}/${m.swipes!.length}`
              }}
            </td>
            <td data-label="时间">{{ timeOf(m) }}</td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td colspan="6" class="dzero">还没有消息</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="dpager">
      <span class="dpager__info">
        共 {{ messageCount }} 条 · 第 {{ pageNo }} / {{ totalPages }} 页
      </span>
      <div class="dpager__acts">
        <button
          class="cbx-btn cbx-btn--ghost sm"
          :disabled="stack.length <= 1 || loading"
          @click="newer"
        >
          <AppIcon name="ArrowLeft" /> 更新
        </button>
        <button class="cbx-btn cbx-btn--ghost sm" :disabled="!hasOlder || loading" @click="older">
          更早 <AppIcon name="ArrowRight" />
        </button>
      </div>
    </div>
    <pre v-if="selected" class="msgdetail">{{ detailJson }}</pre>
  </div>
</template>

<style scoped src="@/assets/styles/data-tables.css"></style>
<style scoped>
.msgtab {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  min-width: 0;
}
.msgdetail {
  margin: 0;
  max-height: 320px;
  overflow: auto;
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg-secondary);
  font-family: var(--cbx-font-mono);
  font-size: var(--cbx-fs-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.sm {
  height: 32px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
</style>
