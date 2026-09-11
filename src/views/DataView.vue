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
import SyncDialog from '@/components/data/SyncDialog.vue'
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
/**
 * 每个会话的向量块数。
 *
 * **必须真查**，不能读 memIndex.chunks —— 那个是 ord 取号器不是块数，
 * 删过中间的块之后两者就不相等了（见 memchunks 仓储的说明）。
 */
const chunkCounts = ref<Record<string, number>>({})
const backupInput = ref<HTMLInputElement | null>(null)
const syncOpen = ref(false)

async function loadChunkCounts() {
  const entries = await Promise.all(
    chats.list.map(async (c) => [c.id, await memchunksRepo.countByChat(c.id)] as const),
  )
  chunkCounts.value = Object.fromEntries(entries)
}

onMounted(async () => {
  await chats.loadList()
  if (!worlds.loaded) await worlds.load()
  await loadChunkCounts()
  usage.value = await storageEstimate()
})

const selected = computed<ChatMeta | undefined>(() =>
  chats.list.find((c) => c.id === selectedId.value),
)
const meta = computed(() => selected.value?.chat_metadata)

/** 变量以数组形式编辑，避免直接改对象键导致输入框失焦重建 */
const varRows = ref<{ key: string; value: string }[]>([])

/** 点同一行再点一次则收起详情 —— 表格本身已经够看，不必强制留着编辑面板 */
function select(id: string) {
  selectedId.value = selectedId.value === id ? '' : id
  const m = chats.list.find((c) => c.id === id)
  varRows.value = Object.entries(m?.chat_metadata.variables ?? {}).map(([key, value]) => ({
    key,
    value,
  }))
  cardText.value = m?.chat_metadata.stateCard?.text ?? ''
}

async function refreshSelected() {
  await chats.loadList()
  await loadChunkCounts()
  usage.value = await storageEstimate()
}

/** 表格里每行要展示的派生数据。组件里算好，模板保持干净 */
function rowOf(c: ChatMeta) {
  const m = c.chat_metadata
  const t = m.timedWorldInfo
  return {
    vars: Object.keys(m.variables ?? {}).length,
    chunks: chunkCounts.value[c.id] ?? 0,
    card: m.stateCard?.text?.length ?? 0,
    timed: Object.keys(t?.sticky ?? {}).length + Object.keys(t?.cooldown ?? {}).length,
    book: m.worldBookId ? (worlds.byId(m.worldBookId)?.name ?? '（已删除）') : '',
  }
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
            <button class="cbx-btn cbx-btn--ghost" @click="syncOpen = true">二维码同步</button>
            <input ref="backupInput" type="file" accept=".json" hidden @change="doImport" />
          </div>
          <p class="cbx-field__hint">
            「二维码同步」把数据直接传给同一局域网里的另一台设备，扫码建立连接，不经过服务器。
          </p>
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

          <template v-else>
            <!-- 表格必须自己横向滚，绝不能让 body 横向溢出 —— 窄屏上列数放不下 -->
            <div class="tablewrap cbx-scroll">
              <table class="tbl">
                <thead>
                  <tr>
                    <th class="tbl__name">会话</th>
                    <th>消息</th>
                    <th>变量</th>
                    <th>向量块</th>
                    <th>状态卡</th>
                    <th>定时</th>
                    <th>世界书</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="c in chats.list"
                    :key="c.id"
                    class="tbl__row"
                    :class="{ 'tbl__row--on': selectedId === c.id }"
                    @click="select(c.id)"
                  >
                    <td class="tbl__name">
                      <div class="nm">
                        <span>{{ c.kind === 'group' ? '👥' : '💬' }}</span>
                        <span class="tbl__title">{{ c.title }}</span>
                        <span v-if="c.parentChatId" class="tbl__tag" title="由其它会话分支而来">
                          分支
                        </span>
                      </div>
                    </td>
                    <td class="num">{{ c.messageCount }}</td>
                    <td class="num" :class="{ zero: !rowOf(c).vars }">{{ rowOf(c).vars }}</td>
                    <td class="num" :class="{ zero: !rowOf(c).chunks }">{{ rowOf(c).chunks }}</td>
                    <td class="num" :class="{ zero: !rowOf(c).card }">
                      {{ rowOf(c).card ? `${rowOf(c).card} 字` : '—' }}
                    </td>
                    <td class="num" :class="{ zero: !rowOf(c).timed }">{{ rowOf(c).timed }}</td>
                    <td :class="{ zero: !rowOf(c).book }">{{ rowOf(c).book || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p class="cbx-field__hint">点任意一行展开编辑；再点一次收起。</p>

            <div v-if="selected" class="detail">
              <label class="cbx-field">
                <span class="cbx-field__label">会话标题</span>
                <input
                  class="cbx-input"
                  :value="selected.title"
                  @change="renameChat(($event.target as HTMLInputElement).value)"
                />
              </label>

              <div v-if="selected.parentChatId" class="chips">
                <span class="chip">分支自 seq {{ selected.branchFromSeq }}</span>
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
                    :disabled="!chunkCounts[selected.id]"
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
          </template>
        </section>
      </div>
    </div>

    <SyncDialog v-if="syncOpen" @close="syncOpen = false" />
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

/* 表格自己横向滚，绝不让 body 溢出 —— 窄屏上 7 列放不下 */
.tablewrap {
  overflow-x: auto;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--cbx-fs-sm);
  /* 列宽按内容排，配合 min-width 保证窄屏下是滚动而不是挤成一团 */
  min-width: 640px;
}
.tbl th,
.tbl td {
  padding: var(--cbx-space-2) var(--cbx-space-3);
  text-align: left;
  white-space: nowrap;
  border-bottom: 1px solid var(--cbx-border);
}
.tbl thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--cbx-bg-secondary);
  font-size: var(--cbx-fs-xs);
  font-weight: var(--cbx-fw-medium);
  color: var(--cbx-text-tertiary);
}
.tbl tbody tr:last-child td {
  border-bottom: 0;
}
.tbl__row {
  cursor: pointer;
  transition: background var(--cbx-transition);
}
@media (hover: hover) {
  .tbl__row:hover {
    background: var(--cbx-bg-hover);
  }
}
.tbl__row--on {
  background: var(--cbx-brand-light);
}
.tbl__row--on:hover {
  background: var(--cbx-brand-light-hover);
}
.tbl__name {
  /* 让名字列吃掉所有多余宽度，其余数字列各自按内容收紧。
     ⚠️ 不能把 display:flex 加在 <td> 上 —— 那会让它不再是表格单元格、
     退出列宽计算，表现是名字列被撑出一大段空白。flex 放在内层 .nm 上。 */
  width: 100%;
}
.nm {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.tbl__title {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.tbl__tag {
  padding: 0 var(--cbx-space-1);
  border-radius: var(--cbx-radius-xs);
  background: var(--cbx-bg-tertiary);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
/* 数字列右对齐并等宽，扫一眼就能比大小 */
.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
/* 空值压淡：一眼看出哪些会话其实没挂数据 */
.zero {
  color: var(--cbx-text-placeholder);
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
  .tablewrap {
    /* 窄屏限高，表格内部纵向也能滚，不至于把详情面板推到屏幕外 */
    max-height: 45vh;
  }
  /* 窄屏下名字列不能再吃满宽度：640px 的表在 375px 屏上只露得出第一列，
     右边的数字列一个都看不见，用户根本不知道还能横滑。收窄它让「消息」列
     探出半个头，横向可滚才有视觉暗示。 */
  .tbl__name {
    width: auto;
    /* 跟着横滑走会丢失「这是哪一行」，钉住首列。
       钉住的格子必须自带不透明背景 + z-index，否则下面滚过去的数字会透上来。 */
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--cbx-bg);
  }
  .tbl__row--on .tbl__name {
    /* 选中行钉住的首列要跟着变色，否则横滑时首列是白的、行是蓝的 */
    background: var(--cbx-brand-light);
  }
  .tbl thead .tbl__name {
    /* 表头首列两个方向都钉住，层级要压过只钉一个方向的邻居 */
    z-index: 2;
  }
  .tbl__title {
    max-width: 120px;
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
