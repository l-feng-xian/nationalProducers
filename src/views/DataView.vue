<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
/**
 * 数据管理。
 *
 * 三件事：整库备份（从设置页搬来），**按会话管理它挂着的全部数据**，
 * 以及其他数据表的可视化浏览。
 *
 * 会话区支持多行同时展开：每行展开后带出该会话相关的各张表（消息 /
 * 向量块 / 图片）以子表格分页展示，状态编辑器在「状态与设置」选项卡。
 * 性能：展开才挂载、收起即销毁；各表一律游标分页，无全量加载路径。
 */
import { onMounted, ref } from 'vue'
import { DRAWER_MQ, useMediaQuery } from '@/composables/useDrawerSwipe'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import SyncDialog from '@/components/data/SyncDialog.vue'
import ChatDataPanel from '@/components/data/ChatDataPanel.vue'
import StoreBrowser from '@/components/data/StoreBrowser.vue'
import { useChatsStore } from '@/stores/chats'
import { useWorldsStore } from '@/stores/worlds'
import { useToast } from '@/composables/useToast'
import { memchunksRepo } from '@/db/repositories'
import { exportAll, importAll, storageEstimate, formatBytes } from '@/services/io/backup'
import { downloadBlob, safeFileName } from '@/utils/download'
import { APP_NAME } from '@/constants/app'
import type { ChatMeta } from '@/types/chat'

const chats = useChatsStore()
const isMobile = useMediaQuery(DRAWER_MQ)
const worlds = useWorldsStore()
const toast = useToast()

const usage = ref<{ usage: number; quota: number } | null>(null)
/** 展开中的会话 id（支持多行同时展开） */
const expanded = ref<string[]>([])
const backupInput = ref<HTMLInputElement | null>(null)
const syncOpen = ref(false)

/**
 * 每个会话的向量块数（单事务批量 count）。
 *
 * **必须真查**，不能读 memIndex.chunks —— 那个是 ord 取号器不是块数，
 * 删过中间的块之后两者就不相等了（见 memchunks 仓储的说明）。
 */
const chunkCounts = ref<Record<string, number>>({})

async function loadChunkCounts() {
  chunkCounts.value = await memchunksRepo.countByChats(chats.list.map((c) => c.id))
}

onMounted(async () => {
  await chats.loadList()
  if (!worlds.loaded) await worlds.load()
  await loadChunkCounts()
  usage.value = await storageEstimate()
})

/** 展开区的任何写操作 / 其他表级联删除后：刷新列表、块数与存储估算 */
async function refresh() {
  await chats.loadList()
  await loadChunkCounts()
  usage.value = await storageEstimate()
}

/** 点行切换展开；再点一次收起（收起即销毁面板，释放 DOM 与内存） */
function toggle(id: string) {
  expanded.value = expanded.value.includes(id)
    ? expanded.value.filter((x) => x !== id)
    : [...expanded.value, id]
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

// ── 整库备份（从设置页搬来）──
async function doExport() {
  const blob = await exportAll()
  const at = await downloadBlob(
    blob,
    safeFileName(`${APP_NAME}备份-${new Date().toISOString().slice(0, 10)}`, 'json'),
  )
  if (at) toast.success(`已导出到 ${at}（不含 API Key）`)
}
function openBackup() {
  backupInput.value?.click()
}
/** 导入跳过统计使用用户可读的分类名称。 */
const STORE_LABEL: Record<string, string> = {
  characters: '角色',
  worldbooks: '世界书',
  groups: '演绎',
  chats: '会话',
  messages: '消息',
  blobs: '图片',
  settings: '设置',
}

async function doImport(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  try {
    const r = await importAll(await file.text())
    const line = `导入完成：角色 ${r.characters} · 世界书 ${r.worldbooks} · 会话 ${r.chats} · 消息 ${r.messages}`
    // 跳过的行必须说出来。不说的话「导入完成」会盖住「其实有 300 条没进来」，
    // 而用户是在事后翻不到某段对话时才发现的 —— 那时已经无从查起
    if (r.skipped) {
      const detail = Object.entries(r.skippedBy)
        .map(([k, n]) => `${STORE_LABEL[k] ?? k} ${n}`)
        .join('、')
      toast.error(`${line}；另有 ${r.skipped} 行格式不对被跳过（${detail}）`)
    } else {
      toast.success(line)
    }
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
            点行展开后，可以按子表格浏览各张表的数据并逐项修改。
          </p>

          <div v-if="!chats.list.length" class="cbx-empty">
            <span class="cbx-empty__desc">还没有会话</span>
          </div>

          <template v-else>
            <!-- 桌面：表格自己横向滚，绝不能让 body 横向溢出；手机：每行变成一张卡（见样式） -->
            <div class="tablewrap">
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
                  <template v-for="c in chats.list" :key="c.id">
                    <tr
                      class="tbl__row"
                      data-icon-trigger
                      tabindex="0"
                      :aria-expanded="expanded.includes(c.id)"
                      @keydown.enter.prevent="toggle(c.id)"
                      @keydown.space.prevent="toggle(c.id)"
                      :class="{ 'tbl__row--on': expanded.includes(c.id) }"
                      @click="toggle(c.id)"
                    >
                      <td class="tbl__name">
                        <div class="nm">
                          <AppIcon
                            class="exp"
                            name="ChevronRight"
                            :active="expanded.includes(c.id)"
                          />
                          <AppIcon
                            :name="c.kind === 'group' ? 'UsersRound' : 'MessageCircle'"
                            tone="brand"
                          />
                          <span class="tbl__title">{{ c.title }}</span>
                          <span v-if="c.parentChatId" class="tbl__tag" title="由其它会话分支而来">
                            分支
                          </span>
                        </div>
                      </td>
                      <td class="num" data-label="消息">{{ c.messageCount }}</td>
                      <td class="num" data-label="变量" :class="{ zero: !rowOf(c).vars }">
                        {{ rowOf(c).vars }}
                      </td>
                      <td class="num" data-label="向量块" :class="{ zero: !rowOf(c).chunks }">
                        {{ rowOf(c).chunks }}
                      </td>
                      <td class="num" data-label="状态卡" :class="{ zero: !rowOf(c).card }">
                        {{ rowOf(c).card ? `${rowOf(c).card} 字` : '—' }}
                      </td>
                      <td class="num" data-label="定时" :class="{ zero: !rowOf(c).timed }">
                        {{ rowOf(c).timed }}
                      </td>
                      <td class="book" data-label="世界书" :class="{ zero: !rowOf(c).book }">
                        {{ rowOf(c).book || '—' }}
                      </td>
                    </tr>
                    <!-- 展开行：v-if 保证收起即销毁（数据 tab 的缓存与分页状态一起释放） -->
                    <tr v-if="expanded.includes(c.id)" class="exprow">
                      <td colspan="7">
                        <ChatDataPanel
                          :chat="c"
                          :chunk-count="chunkCounts[c.id] ?? 0"
                          @refresh="refresh"
                        />
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
            <p class="cbx-field__hint">
              点任意一{{ isMobile ? '项' : '行' }}展开子表格；再点一次收起。可同时展开多{{
                isMobile ? '项' : '行'
              }}。
            </p>
          </template>
        </section>

        <section class="cbx-card sec">
          <h3>其他数据</h3>
          <p class="note">
            角色、演绎、世界书、图片与密钥的逐行浏览。删除会走各表的级联清理
            （删角色会连同它的会话与消息），只浏览与删除，不提供行内编辑。
          </p>
          <StoreBrowser @changed="refresh" />
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

/* 表格自己横向滚，绝不让 body 溢出。
   ⚠️ 只横向滚、别套 .cbx-scroll（页面级容器，自带 overscroll-behavior:contain）：
   那会让滚轮 / 手指停在表格上时纵向滚动被截住又不交给页面，表现为「在表格上滚不动」。 */
.tablewrap {
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
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
.exp {
  width: 1em;
  flex-shrink: 0;
  color: var(--cbx-text-tertiary);
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

/* 展开行：子面板放进一个单元格，允许内部正常换行 */
.exprow > td {
  padding: var(--cbx-space-3) var(--cbx-space-4) var(--cbx-space-4);
  white-space: normal;
  background: var(--cbx-bg);
}

.acts {
  display: flex;
  gap: var(--cbx-space-2);
  flex-wrap: wrap;
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

/* 手机：会话表改成「一行一张卡」。7 列的表在 375px 屏上只露得出第一列，横拖着看既累又容易误触展开。
   卡片第一行是会话名，下面是「消息 12 · 变量 3 …」的小块自动折行；展开的子面板占满卡片宽度。 */
@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-3);
  }
  .tablewrap {
    overflow: visible;
  }
  .tbl {
    display: block;
    min-width: 0;
  }
  .tbl thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tbl tbody {
    display: block;
  }
  .tbl__row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cbx-space-1) var(--cbx-space-3);
    padding: var(--cbx-space-3);
    border-bottom: 1px solid var(--cbx-border);
  }
  .tbl tbody > tr:last-child {
    border-bottom: 0;
  }
  .tbl__row > td {
    display: inline-flex;
    align-items: baseline;
    gap: var(--cbx-space-1);
    padding: 0;
    border: 0;
    font-size: var(--cbx-fs-xs);
    color: var(--cbx-text-secondary);
  }
  .tbl__row > td[data-label]::before {
    content: attr(data-label);
    color: var(--cbx-text-tertiary);
  }
  .tbl__row > td.zero {
    color: var(--cbx-text-placeholder);
  }
  .num {
    text-align: left;
  }
  .tbl__name {
    flex-basis: 100%;
    width: auto;
    min-width: 0;
    font-size: var(--cbx-fs-sm);
    color: var(--cbx-text);
  }
  .nm {
    width: 100%;
    min-width: 0;
    min-height: 28px;
  }
  .tbl__title {
    flex: 1;
    min-width: 0;
    max-width: none;
    font-weight: var(--cbx-fw-medium);
  }
  .book {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .exprow {
    display: block;
    border-bottom: 1px solid var(--cbx-border);
  }
  .exprow > td {
    display: block;
    padding: var(--cbx-space-3);
    border: 0;
  }
  .usage__quota,
  .usage__label {
    display: none;
  }
  .acts .cbx-btn {
    flex: 1 1 140px;
    min-height: var(--cbx-tap-min);
  }
}
</style>
