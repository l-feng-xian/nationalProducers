<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
/**
 * 「其他数据表」可视化浏览：角色 / 群聊 / 世界书 / 图片 / 密钥。
 *
 * 约定：只浏览与删除（不做行内编辑）；删除一律走各表仓储的级联删除，
 * 不裸删 IDB 行，防止留下孤儿消息 / 图片。分页与轻量化见 browse.ts。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useToast } from '@/composables/useToast'
import { confirmDialog } from '@/composables/useConfirm'
import {
  blobsRepo,
  browseRepo,
  charactersRepo,
  groupsRepo,
  secretsRepo,
  worldbooksRepo,
} from '@/db/repositories'
import type { BrowseRow, BrowseStore } from '@/db/repositories/browse'
import { formatBytes } from '@/services/io/backup'
import { useBlobPreview } from '@/composables/useBlobPreview'
import BlobThumb from './BlobThumb.vue'
import BlobLightbox from './BlobLightbox.vue'
import CbxDialogClose from '@/components/ui/CbxDialogClose.vue'
import { useBackClose } from '@/composables/useBackClose'

const emit = defineEmits<{ changed: [] }>()
const toast = useToast()

const STORES: { id: BrowseStore; label: string }[] = [
  { id: 'characters', label: '角色' },
  { id: 'groups', label: '群聊' },
  { id: 'worldbooks', label: '世界书' },
  { id: 'blobs', label: '图片' },
  { id: 'secrets', label: '密钥' },
]
const columns = browseRepo.BROWSE_COLUMNS

const active = ref<BrowseStore>('characters')
const rows = ref<BrowseRow[]>([])
const hasMore = ref(false)
/** 每页的 before 值栈；首页为 [undefined] */
const stack = ref<(string | undefined)[]>([undefined])
const loading = ref(false)
const count = ref(0)
/** 仅图片表：全库可达引用集（懒计算），用于标注与安全删除判断 */
const refSet = ref<Set<string> | null>(null)

const storeLabel = computed(() => STORES.find((s) => s.id === active.value)!.label)
const pageNo = computed(() => stack.value.length)
/** 空状态行的 colspan：名称 + 数据列 + 更新时间 + 操作；图片表另有「预览」「引用」两列 */
const colCount = computed(
  () => 3 + columns[active.value].length + (active.value === 'blobs' ? 2 : 0),
)

async function load(before?: string) {
  loading.value = true
  try {
    const page = await browseRepo.browseStore(active.value, { limit: 50, before })
    rows.value = page.rows
    hasMore.value = page.hasMore
    // 删掉本页唯一一行后重载可能为空：自动回退上一页
    if (!page.rows.length && stack.value.length > 1) {
      stack.value = stack.value.slice(0, -1)
      return load(stack.value.at(-1))
    }
  } finally {
    loading.value = false
  }
}

async function activate(store: BrowseStore) {
  if (active.value === store && rows.value.length) return
  active.value = store
  stack.value = [undefined]
  refSet.value = null
  void load(undefined)
  count.value = await browseRepo.countStore(store)
  if (store === 'blobs') refSet.value = await browseRepo.referencedBlobIds()
}

function next() {
  if (!hasMore.value || loading.value || !rows.value.length) return
  const before = rows.value.at(-1)!.key
  stack.value = [...stack.value, before]
  void load(before)
}
function prev() {
  if (stack.value.length <= 1 || loading.value) return
  stack.value = stack.value.slice(0, -1)
  void load(stack.value.at(-1))
}

async function reload() {
  void load(stack.value.at(-1))
  count.value = await browseRepo.countStore(active.value)
  if (active.value === 'blobs') refSet.value = await browseRepo.referencedBlobIds()
  emit('changed')
}

// ── 详情（仅 JSON 类的表；图片表直接在行内展示缩略图，不再走详情弹层）──
const detail = reactive({
  open: false,
  title: '',
  json: '',
  truncated: false,
})
const dlg = ref<HTMLDialogElement | null>(null)

async function openDetail(row: BrowseRow) {
  if (active.value === 'blobs') return
  detail.title = `${storeLabel.value} · ${row.title}`
  detail.json = ''
  detail.truncated = false
  const full = await browseRepo.getStoreRow(active.value, row.key)
  let text = ''
  try {
    text = JSON.stringify(full, null, 2)
  } catch {
    text = '（无法序列化）'
  }
  detail.truncated = text.length > 200_000
  detail.json = detail.truncated ? `${text.slice(0, 200_000)}\n…（内容过长，已截断）` : text
  detail.open = true
  // v-if 的 dialog 要等 DOM 挂载后才能 showModal，否则元素存在但未「open」不可见
  await nextTick()
  dlg.value?.showModal()
}
function closeDetail() {
  detail.open = false
  dlg.value?.close()
}
// 手机上是整页：返回键 = 关闭
useBackClose(closeDetail, () => detail.open)

// ── 图片放大预览（点缩略图，带 View Transitions 形变）──
const preview = useBlobPreview()
/** 图片表的数据列就是 mime / 大小，直接复用成预览说明，不再单取一次记录 */
function openPreview(r: BrowseRow) {
  const meta = `${fmtCol('blobs', 0, r.cols[0])} · ${fmtCol('blobs', 1, r.cols[1])} · ${fmtTime(r.at)}`
  void preview.open(r.key, meta)
}

// ── 删除（全部走级联删除的仓储方法）──
const REMOVE_TEXT: Record<BrowseStore, (row: BrowseRow) => string> = {
  characters: (r) => `删除角色「${r.title}」？其全部会话与消息会一并删除，此操作不可撤销。`,
  groups: (r) => `删除群聊「${r.title}」？其全部会话与消息会一并删除，此操作不可撤销。`,
  worldbooks: (r) => `删除世界书「${r.title}」？绑定它的角色与会话会被解绑，此操作不可撤销。`,
  blobs: (r) =>
    refSet.value?.has(r.key)
      ? `该图片仍被引用，删除后对应头像 / 配图会显示异常。确定删除？`
      : `删除这张未被引用的图片？`,
  secrets: (r) => `删除密钥「${r.key}」？对应服务需要重新填写 API Key。`,
}

async function removeRow(row: BrowseRow) {
  const text = REMOVE_TEXT[active.value]!(row)
  const danger = active.value === 'blobs' && !!refSet.value?.has(row.key)
  if (!(await confirmDialog({ text, danger }))) return
  switch (active.value) {
    case 'characters':
      await charactersRepo.remove(row.key)
      break
    case 'groups':
      await groupsRepo.remove(row.key)
      break
    case 'worldbooks':
      await worldbooksRepo.remove(row.key)
      break
    case 'blobs':
      await blobsRepo.remove(row.key)
      break
    case 'secrets':
      await secretsRepo.remove(row.key)
      break
  }
  toast.success(`已删除${storeLabel.value}「${row.title}」`)
  await reload()
}

async function gcBlobs() {
  if (!(await confirmDialog({ text: '扫描并删除全部未被引用的图片？' }))) return
  const removed = await blobsRepo.gc()
  toast.success(removed ? `已清理 ${removed} 张未引用图片` : '没有未引用的图片')
  await reload()
}

function fmtCol(store: BrowseStore, index: number, value: string | number | undefined) {
  if (value === undefined) return '—'
  const kind = columns[store][index]?.kind
  return kind === 'bytes' && typeof value === 'number' ? formatBytes(value) : String(value)
}
function fmtTime(at?: number) {
  return at ? new Date(at).toLocaleString() : '—'
}

onMounted(() => void activate('characters'))
onBeforeUnmount(() => {
  if (detail.open) dlg.value?.close()
})
</script>

<template>
  <div class="browser">
    <div class="stores" role="tablist">
      <button
        v-for="s in STORES"
        :key="s.id"
        type="button"
        role="tab"
        class="stores__btn"
        :class="{ 'stores__btn--on': active === s.id }"
        :aria-selected="active === s.id"
        @click="activate(s.id)"
      >
        {{ s.label }}
      </button>
    </div>

    <div class="dpager">
      <span class="dpager__info">
        {{ storeLabel }}共 {{ count }} 行 · 第 {{ pageNo }} 页{{ hasMore ? '＋' : '' }}
      </span>
      <div class="dpager__acts">
        <button
          v-if="active === 'blobs'"
          class="cbx-btn cbx-btn--ghost sm"
          :disabled="loading"
          @click="gcBlobs"
        >
          清理未引用
        </button>
      </div>
    </div>

    <div class="dtblwrap cbx-scroll">
      <table class="dtbl">
        <thead>
          <tr>
            <th v-if="active === 'blobs'">预览</th>
            <th>名称</th>
            <th v-for="c in columns[active]" :key="c.label">{{ c.label }}</th>
            <th v-if="active === 'blobs'">引用</th>
            <th>更新时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key">
            <td v-if="active === 'blobs'" class="dpreview">
              <button
                type="button"
                class="dpreview__btn"
                :style="preview.thumbStyle(r.key)"
                aria-label="放大预览这张图片"
                @click="openPreview(r)"
              >
                <BlobThumb :blob-id="r.key" />
              </button>
            </td>
            <td class="dtbl__clip" :title="r.key">{{ r.title }}</td>
            <td
              v-for="(c, i) in columns[active]"
              :key="c.label"
              :class="{ dnum: typeof r.cols[i] === 'number' }"
            >
              {{ fmtCol(active, i, r.cols[i]) }}
            </td>
            <td v-if="active === 'blobs'">
              <span v-if="refSet?.has(r.key)" class="tag">被引用</span>
              <span v-else class="tag tag--free">未引用</span>
            </td>
            <td>{{ fmtTime(r.at) }}</td>
            <td class="ops">
              <button
                v-if="active !== 'blobs'"
                class="cbx-btn cbx-btn--ghost sm"
                @click="openDetail(r)"
              >
                详情
              </button>
              <button class="cbx-btn cbx-btn--ghost sm danger" @click="removeRow(r)">删除</button>
            </td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td :colspan="colCount" class="dzero">这张表还没有数据</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="dpager">
      <span class="dpager__info" />
      <div class="dpager__acts">
        <button
          class="cbx-btn cbx-btn--ghost sm"
          :disabled="stack.length <= 1 || loading"
          @click="prev"
        >
          <AppIcon name="ArrowLeft" /> 上一页
        </button>
        <button class="cbx-btn cbx-btn--ghost sm" :disabled="!hasMore || loading" @click="next">
          下一页 <AppIcon name="ArrowRight" />
        </button>
      </div>
    </div>

    <BlobLightbox
      :blob-id="preview.id.value"
      :caption="preview.caption.value"
      :morph-style="preview.stageStyle.value"
      @close="preview.close()"
    />

    <Teleport to="body">
      <dialog v-if="detail.open" ref="dlg" class="rowdetail cbx-page" @cancel.prevent="closeDetail">
        <!-- 标题栏放在滚动区外面：整页时它要钉在顶上，不能跟着 JSON 一起滚走 -->
        <header class="rowdetail__head cbx-page-head">
          <h4>{{ detail.title }}</h4>
          <CbxDialogClose @click="closeDetail" />
        </header>
        <div class="rowdetail__body cbx-scroll cbx-page-body">
          <pre v-if="detail.json" class="rowdetail__json">{{ detail.json }}</pre>
        </div>
      </dialog>
    </Teleport>
  </div>
</template>

<style scoped src="@/assets/styles/data-tables.css"></style>
<style scoped>
.browser {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
  min-width: 0;
}
.stores {
  display: flex;
  gap: var(--cbx-space-1);
  flex-wrap: wrap;
}
.stores__btn {
  border: 1px solid var(--cbx-border);
  background: none;
  font-family: inherit;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  padding: var(--cbx-space-1) var(--cbx-space-3);
  border-radius: var(--cbx-radius-pill);
  cursor: pointer;
}
@media (hover: hover) {
  .stores__btn:hover {
    background: var(--cbx-bg-hover);
  }
}
.stores__btn--on {
  border-color: var(--cbx-brand);
  background: var(--cbx-brand-light);
  color: var(--cbx-brand);
}
.tag {
  padding: 1px var(--cbx-space-2);
  border-radius: var(--cbx-radius-xs);
  font-size: var(--cbx-fs-xs);
  background: var(--cbx-bg-tertiary);
  color: var(--cbx-text-tertiary);
  white-space: nowrap;
}
.tag--free {
  color: var(--cbx-success, inherit);
}
.ops {
  white-space: nowrap;
}
/* 图片表行内预览：直接把缩略图放大到能看清，替代原来的「详情」弹层 */
.dpreview {
  width: 72px;
}
.dpreview .dthumb {
  width: 56px;
  height: 56px;
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
.sm {
  height: 32px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.danger {
  color: var(--cbx-error);
}

.rowdetail {
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-lg);
  background: var(--cbx-bg);
  color: var(--cbx-text);
  padding: 0;
  width: min(720px, calc(100vw - 48px));
  max-height: min(80vh, 720px);
}
.rowdetail::backdrop {
  background: rgba(0, 0, 0, 0.45);
}
.rowdetail[open] {
  display: flex;
  flex-direction: column;
}
.rowdetail__body {
  padding: 0 var(--cbx-space-4) var(--cbx-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
  min-height: 0;
  overflow: auto;
}
.rowdetail__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--cbx-space-2);
  flex-shrink: 0;
  padding: var(--cbx-space-4) var(--cbx-space-4) var(--cbx-space-3);
}
.rowdetail__head h4 {
  margin: 0;
  font-size: var(--cbx-fs-md);
  overflow-wrap: anywhere;
}
.rowdetail__json {
  margin: 0;
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
</style>
