<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
/**
 * 会话行内展开的数据面板：四个选项卡带出该会话挂着的各张表。
 *
 * 性能约定（面对大数据量必须守住）：
 *  - 各数据 tab 用 v-if 懒挂载（首次激活才查询），KeepAlive 缓存已加载数据，
 *    收起整行时随面板一起销毁，不驻留内存；
 *  - 消息 / 向量块 tab 一律 50 条分页，无全量加载路径；
 *  - 「状态与设置」是纯表单，不需要缓存。
 */
import { computed, ref, watch } from 'vue'
import { useChatsStore } from '@/stores/chats'
import { useWorldsStore } from '@/stores/worlds'
import { useToast } from '@/composables/useToast'
import { chatsRepo, memchunksRepo, messagesRepo } from '@/db/repositories'
import { invalidateIndex } from '@/services/memory/runtime'
import { confirmDialog } from '@/composables/useConfirm'
import type { ChatMeta } from '@/types/chat'
import MessagesTab from './MessagesTab.vue'
import ChunksTab from './ChunksTab.vue'
import ImagesTab from './ImagesTab.vue'

const props = defineProps<{ chat: ChatMeta; chunkCount: number }>()
const emit = defineEmits<{ refresh: [] }>()

const chats = useChatsStore()
const worlds = useWorldsStore()
const toast = useToast()

const TABS = [
  { id: 'messages', label: '消息' },
  { id: 'chunks', label: '向量块' },
  { id: 'images', label: '图片' },
  { id: 'state', label: '状态与设置' },
] as const
type TabId = (typeof TABS)[number]['id']
const active = ref<TabId>('messages')
/** 危险操作改动数据后 +1，强制各数据 tab 丢弃缓存重新查询 */
const tabsKey = ref(0)

const meta = computed(() => props.chat.chat_metadata)

/** 变量以数组形式编辑，避免直接改对象键导致输入框失焦重建 */
const varRows = ref<{ key: string; value: string }[]>([])
const cardText = ref('')

function syncEditors() {
  varRows.value = Object.entries(props.chat.chat_metadata.variables ?? {}).map(([key, value]) => ({
    key,
    value,
  }))
  cardText.value = props.chat.chat_metadata.stateCard?.text ?? ''
}
// 列表刷新后 chat 对象整体被替换，编辑器里的草稿要跟着重新初始化
watch(() => props.chat, syncEditors, { immediate: true })

// ── 标题 ──
async function renameChat(title: string) {
  if (!title.trim()) return
  await chatsRepo.rename(props.chat.id, title.trim())
  emit('refresh')
  toast.success('已重命名')
}

// ── 会话变量（{{setvar}} / {{getvar}}）──
function addVar() {
  varRows.value = [...varRows.value, { key: '', value: '' }]
}
function removeVar(i: number) {
  varRows.value = varRows.value.filter((_, n) => n !== i)
}
/**
 * 落盘。空键直接丢弃，重复键后者覆盖前者 ——
 * 变量本来就是个 Record，UI 上允许临时重复，保存时按 Record 的语义收敛。
 */
async function saveVars() {
  const next: Record<string, string> = {}
  for (const r of varRows.value) {
    const k = r.key.trim()
    if (k) next[k] = r.value
  }
  await chatsRepo.patchMetadata(props.chat.id, { variables: next })
  emit('refresh')
  toast.success(`已保存 ${Object.keys(next).length} 个变量`)
}

// ── 状态卡 ──
function loadCard() {
  cardText.value = meta.value?.stateCard?.text ?? ''
}
async function saveCard() {
  const prev = meta.value?.stateCard
  await chatsRepo.patchMetadata(props.chat.id, {
    stateCard: {
      text: cardText.value,
      // 手改正文不改变「已读到哪」：水位线是提炼器的进度，与正文无关
      throughSeq: prev?.throughSeq ?? -1,
      updatedAt: Date.now(),
      failures: 0,
    },
  })
  emit('refresh')
  toast.success('状态卡已保存')
}
async function clearCard() {
  if (
    !(await confirmDialog({
      text: '清除状态卡？下次提炼会从头重建。',
      confirmText: '清除',
      danger: false,
    }))
  )
    return
  await chatsRepo.patchMetadata(props.chat.id, { stateCard: undefined })
  cardText.value = ''
  emit('refresh')
  toast.success('状态卡已清除')
}

// ── 向量索引 ──
async function clearIndex() {
  if (
    !(await confirmDialog({
      text: '清除该会话的向量索引？后续对话会自动重建。',
      confirmText: '清除',
      danger: false,
    }))
  )
    return
  await memchunksRepo.clearChat(props.chat.id)
  // ⚠️ 必须同时抹掉水位线。只删块不删水位线的话，追赶逻辑会认为「已经索引到第 N 条」
  // 而无事可做，于是记忆永远是空的且不报任何错 —— 这个坑在备份导入上踩过一次。
  await chatsRepo.patchMetadata(props.chat.id, { memIndex: undefined })
  invalidateIndex(props.chat.id)
  tabsKey.value++
  emit('refresh')
  toast.success('向量索引已清除')
}

// ── 世界书绑定 ──
async function bindBook(bookId: string) {
  await chatsRepo.patchMetadata(props.chat.id, { worldBookId: bookId || undefined })
  emit('refresh')
  toast.success(bookId ? '已绑定世界书' : '已解绑')
}

// ── 定时效果 ──
const timedCount = computed(() => {
  const t = meta.value?.timedWorldInfo
  return Object.keys(t?.sticky ?? {}).length + Object.keys(t?.cooldown ?? {}).length
})
async function resetTimed() {
  await chatsRepo.patchMetadata(props.chat.id, { timedWorldInfo: { sticky: {}, cooldown: {} } })
  emit('refresh')
  toast.success('定时效果已重置')
}

// ── 关系图谱快照 ──
async function clearRelationSnapshot() {
  if (
    !(await confirmDialog({
      text: '清除本会话的关系微调？将回落到群组里配置的关系。',
      confirmText: '清除',
      danger: false,
    }))
  )
    return
  await chatsRepo.patchMetadata(props.chat.id, { relationGraph: undefined })
  emit('refresh')
  toast.success('已回落到群组配置')
}

// ── 危险操作 ──
async function clearMessages() {
  if (
    !(await confirmDialog({
      text: `清空「${props.chat.title}」的全部 ${props.chat.messageCount} 条消息？此操作不可撤销。`,
      confirmText: '清空',
    }))
  )
    return
  await messagesRepo.clear(props.chat.id)
  // 消息没了，基于消息建的索引也必须一起清，否则会召回已经不存在的内容
  await memchunksRepo.clearChat(props.chat.id)
  await chatsRepo.patchMetadata(props.chat.id, { memIndex: undefined })
  invalidateIndex(props.chat.id)
  if (chats.current?.id === props.chat.id) await chats.open(props.chat.id)
  tabsKey.value++
  emit('refresh')
  toast.success('消息已清空')
}

async function removeChat() {
  if (!(await confirmDialog({ text: `删除会话「${props.chat.title}」及其全部数据？此操作不可撤销。` })))
    return
  await chats.removeChat(props.chat.id)
  emit('refresh')
  toast.success('会话已删除')
}
</script>

<template>
  <div class="panel" @click.stop>
    <div class="tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        role="tab"
        class="tabs__btn"
        :class="{ 'tabs__btn--on': active === t.id }"
        :aria-selected="active === t.id"
        @click="active = t.id"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 数据 tab：懒挂载 + KeepAlive 缓存；危险操作后 tabsKey 变更强制重查 -->
    <KeepAlive>
      <MessagesTab
        v-if="active === 'messages'"
        :key="`m-${chat.id}-${tabsKey}`"
        :chat-id="chat.id"
        :message-count="chat.messageCount"
      />
      <ChunksTab
        v-else-if="active === 'chunks'"
        :key="`c-${chat.id}-${tabsKey}`"
        :chat-id="chat.id"
        :chunk-count="chunkCount"
      />
      <ImagesTab
        v-else-if="active === 'images'"
        :key="`i-${chat.id}-${tabsKey}`"
        :chat-id="chat.id"
      />
    </KeepAlive>

    <!-- 状态与设置：纯表单，直接渲染 -->
    <div v-if="active === 'state'" class="detail">
      <label class="cbx-field">
        <span class="cbx-field__label">会话标题</span>
        <input
          class="cbx-input"
          :value="chat.title"
          @change="renameChat(($event.target as HTMLInputElement).value)"
        />
      </label>

      <div v-if="chat.parentChatId" class="chips">
        <span class="chip">分支自 seq {{ chat.branchFromSeq }}</span>
      </div>

      <!-- 会话变量：增删改查 -->
      <div class="block">
        <div class="block__head">
          <span class="cbx-field__label">会话变量</span>
          <span class="cbx-field__hint">供提示词里的 setvar / getvar 使用</span>
        </div>
        <div v-for="(r, i) in varRows" :key="i" class="varrow">
          <input v-model="r.key" class="cbx-input varrow__k" placeholder="变量名" />
          <input v-model="r.value" class="cbx-input varrow__v" placeholder="值" />
          <button class="cbx-icon-btn tiny" title="删除" @click="removeVar(i)"><AppIcon name="X" tone="danger" /></button>
        </div>
        <div class="acts">
          <button class="cbx-btn cbx-btn--ghost sm" @click="addVar"><AppIcon name="Plus" /> 添加变量</button>
          <button class="cbx-btn cbx-btn--soft sm" @click="saveVars">保存变量</button>
        </div>
      </div>

      <!-- 状态卡 -->
      <div class="block">
        <div class="block__head">
          <span class="cbx-field__label">会话记忆 · 状态卡</span>
          <span v-if="meta?.stateCard?.failures" class="cbx-badge cbx-badge--warning">
            连续失败 {{ meta.stateCard.failures }} 次
          </span>
        </div>
        <p v-if="!meta?.stateCard?.text" class="cbx-field__hint">
          还没有提炼出状态卡。开启会话记忆后，每隔若干条消息会自动生成。
        </p>
        <textarea
          v-model="cardText"
          class="cbx-textarea card"
          rows="4"
          placeholder="点「载入」后可直接编辑"
        />
        <div class="acts">
          <button class="cbx-btn cbx-btn--ghost sm" @click="loadCard">载入当前</button>
          <button class="cbx-btn cbx-btn--soft sm" @click="saveCard">保存</button>
          <button
            v-if="meta?.stateCard"
            class="cbx-btn cbx-btn--ghost sm danger"
            @click="clearCard"
          >
            清除
          </button>
        </div>
      </div>

      <!-- 向量索引 -->
      <div class="block">
        <div class="block__head">
          <span class="cbx-field__label">会话记忆 · 向量索引</span>
        </div>
        <p class="cbx-field__hint">
          <template v-if="meta?.memIndex">
            模型 {{ meta.memIndex.model }} · {{ meta.memIndex.dim }} 维 · 已索引到 seq
            {{ meta.memIndex.throughSeq }}
          </template>
          <template v-else>尚未建立索引</template>
        </p>
        <div class="acts">
          <button
            class="cbx-btn cbx-btn--ghost sm danger"
            :disabled="!chunkCount"
            @click="clearIndex"
          >
            清除索引
          </button>
        </div>
      </div>

      <!-- 世界书绑定 -->
      <label class="cbx-field cbx-field--md">
        <span class="cbx-field__label">会话专属世界书</span>
        <select
          class="cbx-input"
          :value="meta?.worldBookId ?? ''"
          @change="bindBook(($event.target as HTMLSelectElement).value)"
        >
          <option value="">（不绑定）</option>
          <option v-for="b in worlds.items" :key="b.id" :value="b.id">{{ b.name }}</option>
        </select>
        <span class="cbx-field__hint">优先级最高的一层，只对这个会话生效</span>
      </label>

      <!-- 定时效果 / 关系快照 -->
      <div class="block">
        <div class="block__head">
          <span class="cbx-field__label">世界书定时效果</span>
        </div>
        <p class="cbx-field__hint">
          sticky / cooldown 的运行状态。条目行为异常时可以重置，不影响世界书本身。
        </p>
        <div class="acts">
          <button class="cbx-btn cbx-btn--ghost sm" :disabled="!timedCount" @click="resetTimed">
            重置定时效果
          </button>
          <button
            v-if="meta?.relationGraph"
            class="cbx-btn cbx-btn--ghost sm"
            @click="clearRelationSnapshot"
          >
            清除本会话的关系微调
          </button>
        </div>
      </div>

      <div class="cbx-divider" />
      <div class="block">
        <div class="block__head">
          <span class="cbx-field__label danger">危险操作</span>
        </div>
        <div class="acts">
          <button class="cbx-btn cbx-btn--ghost sm danger" @click="clearMessages">清空消息</button>
          <button class="cbx-btn cbx-btn--ghost sm danger" @click="removeChat">删除会话</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
  min-width: 0;
}
.tabs {
  display: flex;
  gap: var(--cbx-space-1);
  flex-wrap: wrap;
  border-bottom: 1px solid var(--cbx-border);
  padding-bottom: var(--cbx-space-2);
}
.tabs__btn {
  border: none;
  background: none;
  font-family: inherit;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
  padding: var(--cbx-space-1) var(--cbx-space-3);
  border-radius: var(--cbx-radius-pill);
  cursor: pointer;
}
@media (hover: hover) {
  .tabs__btn:hover {
    background: var(--cbx-bg-hover);
  }
}
.tabs__btn--on {
  background: var(--cbx-brand-light);
  color: var(--cbx-brand);
}
.tabs__btn:focus-visible {
  outline: 2px solid var(--cbx-brand);
}

.detail {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-4);
  min-width: 0;
}
.block {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.block__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
}
.varrow {
  display: flex;
  gap: var(--cbx-space-2);
  align-items: center;
}
.varrow__k {
  width: 160px;
  flex-shrink: 0;
}
.varrow__v {
  flex: 1;
  min-width: 0;
}
.card {
  resize: vertical;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.chip {
  padding: 2px var(--cbx-space-2);
  border-radius: var(--cbx-radius-sm);
  background: var(--cbx-bg-secondary);
  color: var(--cbx-text-secondary);
  font-size: var(--cbx-fs-xs);
  white-space: nowrap;
}
.acts {
  display: flex;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
}
.sm {
  height: 32px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.tiny {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  font-size: var(--cbx-fs-xs);
}
.danger {
  color: var(--cbx-error);
}
@media (max-width: 767px) {
  .varrow__k {
    width: 110px;
  }
  .acts .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
}
</style>
