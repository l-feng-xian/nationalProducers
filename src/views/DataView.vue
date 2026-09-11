<script setup lang="ts">
/**
 * 数据管理。
 *
 * 两件事：整库备份（从设置页搬来），以及**按会话管理它挂着的全部数据**。
 *
 * 后者是这个页面存在的理由：会话变量、状态卡、向量索引、定时效果、世界书绑定
 * 这些状态一直只有代码能碰，出了问题用户既看不见也改不了，只能整个删掉会话重来。
 */
import { computed, onMounted, ref } from 'vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import { useChatsStore } from '@/stores/chats'
import { useWorldsStore } from '@/stores/worlds'
import { useToast } from '@/composables/useToast'
import { chatsRepo, memchunksRepo, messagesRepo } from '@/db/repositories'
import { exportAll, importAll, storageEstimate, formatBytes } from '@/services/io/backup'
import { downloadBlob, safeFileName } from '@/utils/download'
import { invalidateIndex } from '@/services/memory/runtime'
import { APP_NAME } from '@/constants/app'
import type { ChatMeta } from '@/types/chat'

const chats = useChatsStore()
const worlds = useWorldsStore()
const toast = useToast()

const usage = ref<{ usage: number; quota: number } | null>(null)
const selectedId = ref('')
/** 选中会话的向量块数。memIndex.chunks 是 ord 取号器不是块数，必须真查 */
const chunkCount = ref<number | null>(null)
const backupInput = ref<HTMLInputElement | null>(null)

onMounted(async () => {
  await chats.loadList()
  if (!worlds.loaded) await worlds.load()
  usage.value = await storageEstimate()
})

const selected = computed<ChatMeta | undefined>(() =>
  chats.list.find((c) => c.id === selectedId.value),
)
const meta = computed(() => selected.value?.chat_metadata)

/** 变量以数组形式编辑，避免直接改对象键导致输入框失焦重建 */
const varRows = ref<{ key: string; value: string }[]>([])

async function select(id: string) {
  selectedId.value = id
  chunkCount.value = null
  const m = chats.list.find((c) => c.id === id)
  varRows.value = Object.entries(m?.chat_metadata.variables ?? {}).map(([key, value]) => ({
    key,
    value,
  }))
  chunkCount.value = await memchunksRepo.countByChat(id)
}

async function refreshSelected() {
  await chats.loadList()
  if (selectedId.value) {
    chunkCount.value = await memchunksRepo.countByChat(selectedId.value)
  }
  usage.value = await storageEstimate()
}

// ── 标题 ──
async function renameChat(title: string) {
  const id = selectedId.value
  if (!id || !title.trim()) return
  await chatsRepo.rename(id, title.trim())
  await refreshSelected()
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
  const id = selectedId.value
  if (!id) return
  const next: Record<string, string> = {}
  for (const r of varRows.value) {
    const k = r.key.trim()
    if (k) next[k] = r.value
  }
  await chatsRepo.patchMetadata(id, { variables: next })
  await refreshSelected()
  toast.success(`已保存 ${Object.keys(next).length} 个变量`)
}

// ── 状态卡 ──
const cardText = ref('')
function loadCard() {
  cardText.value = meta.value?.stateCard?.text ?? ''
}
async function saveCard() {
  const id = selectedId.value
  const m = meta.value
  if (!id || !m) return
  const prev = m.stateCard
  await chatsRepo.patchMetadata(id, {
    stateCard: {
      text: cardText.value,
      // 手改正文不改变「已读到哪」：水位线是提炼器的进度，与正文无关
      throughSeq: prev?.throughSeq ?? -1,
      updatedAt: Date.now(),
      failures: 0,
    },
  })
  await refreshSelected()
  toast.success('状态卡已保存')
}
async function clearCard() {
  const id = selectedId.value
  if (!id) return
  if (!confirm('清除状态卡？下次提炼会从头重建。')) return
  await chatsRepo.patchMetadata(id, { stateCard: undefined })
  cardText.value = ''
  await refreshSelected()
  toast.success('状态卡已清除')
}

// ── 向量索引 ──
async function clearIndex() {
  const id = selectedId.value
  if (!id) return
  if (!confirm('清除该会话的向量索引？后续对话会自动重建。')) return
  await memchunksRepo.clearChat(id)
  // ⚠️ 必须同时抹掉水位线。只删块不删水位线的话，追赶逻辑会认为「已经索引到第 N 条」
  // 而无事可做，于是记忆永远是空的且不报任何错 —— 这个坑在备份导入上踩过一次。
  await chatsRepo.patchMetadata(id, { memIndex: undefined })
  invalidateIndex(id)
  await refreshSelected()
  toast.success('向量索引已清除')
}

// ── 世界书绑定 ──
async function bindBook(bookId: string) {
  const id = selectedId.value
  if (!id) return
  await chatsRepo.patchMetadata(id, { worldBookId: bookId || undefined })
  await refreshSelected()
  toast.success(bookId ? '已绑定世界书' : '已解绑')
}

// ── 定时效果 ──
const timedCount = computed(() => {
  const t = meta.value?.timedWorldInfo
  return Object.keys(t?.sticky ?? {}).length + Object.keys(t?.cooldown ?? {}).length
})
async function resetTimed() {
  const id = selectedId.value
  if (!id) return
  await chatsRepo.patchMetadata(id, { timedWorldInfo: { sticky: {}, cooldown: {} } })
  await refreshSelected()
  toast.success('定时效果已重置')
}

// ── 关系图谱快照 ──
async function clearRelationSnapshot() {
  const id = selectedId.value
  if (!id) return
  if (!confirm('清除本会话的关系微调？将回落到群组里配置的关系。')) return
  await chatsRepo.patchMetadata(id, { relationGraph: undefined })
  await refreshSelected()
  toast.success('已回落到群组配置')
}

// ── 危险操作 ──
async function clearMessages() {
  const id = selectedId.value
  const m = selected.value
  if (!id || !m) return
  if (!confirm(`清空「${m.title}」的全部 ${m.messageCount} 条消息？此操作不可撤销。`)) return
  await messagesRepo.clear(id)
  // 消息没了，基于消息建的索引也必须一起清，否则会召回已经不存在的内容
  await memchunksRepo.clearChat(id)
  await chatsRepo.patchMetadata(id, { memIndex: undefined })
  invalidateIndex(id)
  if (chats.current?.id === id) await chats.open(id)
  await refreshSelected()
  toast.success('消息已清空')
}

async function removeChat() {
  const m = selected.value
  if (!m) return
  if (!confirm(`删除会话「${m.title}」及其全部数据？此操作不可撤销。`)) return
  await chats.removeChat(m.id)
  selectedId.value = ''
  await refreshSelected()
  toast.success('会话已删除')
}

// ── 整库备份（从设置页搬来）──
async function doExport() {
  const blob = await exportAll()
  downloadBlob(
    blob,
    safeFileName(`${APP_NAME}备份-${new Date().toISOString().slice(0, 10)}`, 'json'),
  )
  toast.success('已导出（不含 API Key）')
}
function openBackup() {
  backupInput.value?.click()
}
async function doImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const r = await importAll(await file.text())
    toast.success(
      `导入完成：角色 ${r.characters} · 世界书 ${r.worldbooks} · 会话 ${r.chats} · 消息 ${r.messages}`,
    )
    setTimeout(() => location.reload(), 800)
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err))
  }
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <div class="page">
    <AppTopbar title="数据管理">
      <template #actions>
        <span v-if="usage" class="usage" :title="`本站已占用 ${formatBytes(usage.usage)}`">
          <span class="usage__label">已占用</span>
          <strong class="usage__val">{{ formatBytes(usage.usage) }}</strong>
          <span v-if="usage.quota" class="usage__quota">/ {{ formatBytes(usage.quota) }}</span>
        </span>
      </template>
    </AppTopbar>

    <div class="cbx-scroll body">
      <div class="cbx-form-col col">
        <section class="cbx-card sec">
          <h3>整库备份</h3>
          <p class="note">
            所有数据都存在这台设备的浏览器里。清除站点数据或换浏览器都会丢，重要内容请导出备份。
            <strong>备份不含 API Key</strong>，可以放心分享。
          </p>
          <p class="note">
            备份也<strong>不含向量索引</strong>（Float32 摊进 JSON 会膨胀十几倍），
            它是从消息推导出来的派生数据，导入后会自动重建。
          </p>
          <div class="acts">
            <button class="cbx-btn cbx-btn--ghost" @click="doExport">导出全部数据</button>
            <button class="cbx-btn cbx-btn--ghost" @click="openBackup">导入备份</button>
            <input ref="backupInput" type="file" accept=".json" hidden @change="doImport" />
          </div>
        </section>

        <section class="cbx-card sec">
          <h3>会话数据</h3>
          <p class="note">
            每个会话除了消息，还挂着变量、状态卡、向量索引、定时效果等一堆状态。
            它们平时不可见，出了问题也只能整个删掉会话重来 —— 这里可以逐项查看和修改。
          </p>

          <div v-if="!chats.list.length" class="cbx-empty">
            <span class="cbx-empty__desc">还没有会话</span>
          </div>

          <div v-else class="split">
            <div class="picker cbx-scroll">
              <button
                v-for="c in chats.list"
                :key="c.id"
                class="cbx-nav-item pick"
                :class="{ 'cbx-nav-item--active': selectedId === c.id }"
                @click="select(c.id)"
              >
                <span class="pick__icon">{{ c.kind === 'group' ? '👥' : '💬' }}</span>
                <span class="pick__name">{{ c.title }}</span>
                <span class="pick__meta">{{ c.messageCount }}</span>
              </button>
            </div>

            <div v-if="!selected" class="detail detail--empty">
              <span class="cbx-empty__desc">选一个会话查看它的数据</span>
            </div>

            <div v-else class="detail">
              <label class="cbx-field">
                <span class="cbx-field__label">会话标题</span>
                <input
                  class="cbx-input"
                  :value="selected.title"
                  @change="renameChat(($event.target as HTMLInputElement).value)"
                />
              </label>

              <div class="chips">
                <span class="chip">{{ selected.messageCount }} 条消息</span>
                <span class="chip">{{ varRows.length }} 个变量</span>
                <span class="chip"> 向量块 {{ chunkCount === null ? '…' : chunkCount }} </span>
                <span class="chip">{{ timedCount }} 条定时效果</span>
                <span v-if="selected.parentChatId" class="chip">
                  分支自 seq {{ selected.branchFromSeq }}
                </span>
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
                  <button class="cbx-icon-btn tiny" title="删除" @click="removeVar(i)">✕</button>
                </div>
                <div class="acts">
                  <button class="cbx-btn cbx-btn--ghost sm" @click="addVar">＋ 添加变量</button>
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
                  <button
                    class="cbx-btn cbx-btn--ghost sm"
                    :disabled="!timedCount"
                    @click="resetTimed"
                  >
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
                  <button class="cbx-btn cbx-btn--ghost sm danger" @click="clearMessages">
                    清空消息
                  </button>
                  <button class="cbx-btn cbx-btn--ghost sm danger" @click="removeChat">
                    删除会话
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.body {
  flex: 1;
  min-height: 0;
  padding: var(--cbx-space-4);
}
.col {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-4);
}
.sec {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}

.split {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: var(--cbx-space-4);
  align-items: start;
}
.picker {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* 会话可能很多，列表自己滚，别把整页拉长 */
  max-height: 420px;
}
.pick {
  width: 100%;
  text-align: left;
  gap: var(--cbx-space-2);
}
.pick__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pick__meta {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}

.detail {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-4);
  min-width: 0;
}
.detail--empty {
  padding: var(--cbx-space-6) 0;
  text-align: center;
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

.note {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.7;
}

/* 顶栏里的存储占用，与模型管理页同一套 */
.usage {
  display: inline-flex;
  align-items: baseline;
  gap: var(--cbx-space-1);
  flex-shrink: 0;
  padding: var(--cbx-space-1) var(--cbx-space-3);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-secondary);
  white-space: nowrap;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.usage__val {
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-secondary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 767px) {
  .split {
    grid-template-columns: 1fr;
  }
  .picker {
    max-height: 200px;
  }
  .varrow__k {
    width: 110px;
  }
  .usage__quota,
  .usage__label {
    display: none;
  }
  .acts .cbx-btn {
    min-height: var(--cbx-tap-min);
  }
}
</style>
