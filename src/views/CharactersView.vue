<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  onMounted,
  ref,
  watch,
} from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useToast } from '@/composables/useToast'
import { useViewTransition } from '@/composables/useViewTransition'
import { useMorphTarget } from '@/composables/useMorphTarget'
import { MORPH_VT_NAME } from '@/constants/app'
import { readCharaFromPng } from '@/services/io/pngCard'
import { normalizeCard } from '@/services/io/characterCard'
import { blobsRepo } from '@/db/repositories'
import { parallaxMode, useDepthParallax } from '@/composables/useDepthParallax'
import { useImagePreview } from '@/composables/useImagePreview'
import { ZoomIn } from '@/components/icons'
import type { Character } from '@/types/character'

// name 是 App.vue 里 KeepAlive :include 白名单的匹配依据。
// <script setup> 虽然会从文件名推断，但那是隐式约定 —— 改个文件名缓存就静默失效
// 且不报错。显式写死。
defineOptions({ name: 'CharactersView' })

const router = useRouter()
const chars = useCharactersStore()
const chats = useChatsStore()
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  if (!chars.loaded) void chars.load()
})

const vt = useViewTransition()

/**
 * 正在参与过渡的那一张卡的 id。只有它会被挂上 view-transition-name，
 * 保证同一时刻只有一个同名元素（见 MORPH_VT_NAME 的说明）。
 */
const morphingId = ref<string | null>(null)
/** 过渡进行中不接受新的点击：并发两次过渡会互相 skip，观感是「闪一下没动画」 */
let morphing = false

const morph = useMorphTarget()

/**
 * 立绘视差（见 useDepthParallax）。渲染器全局只有一个，但能同时驱动多张卡：
 * - 桌面：鼠标移到哪张卡上，哪张卡跟着鼠标动；
 * - 手机：**可视区内所有有深度图的卡**一起跟着手机倾斜动。IntersectionObserver 盯着每个画框，
 *   进入可视区（含上下 100px 预备带，滚进来之前纹理已就绪）就挂、滚出去就摘；
 *   纹理留在渲染器的缓存里，滚回来不用重新解码。
 * 没有深度图的卡永远是静态图。
 */
/** 封面角落的放大按钮：全站统一预览 */
const imagePreview = useImagePreview()
function previewCover(c: Character, e: MouseEvent) {
  if (!c.avatarBlobId) return
  const img = (e.currentTarget as HTMLElement).closest('.card__frame')?.querySelector('img')
  void imagePreview.open([{ blobId: c.avatarBlobId, caption: c.data.name }], 0, img)
}

const parallax = useDepthParallax()
const { needsPermission: tiltNeedsGrant, enableTilt } = parallax
const scroller = ref<HTMLElement | null>(null)
/** KeepAlive：页面被缓存（停用）期间不观察，也不许占着渲染器 */
let pageActive = false
let io: IntersectionObserver | null = null

async function onCardEnter(c: Character, e: PointerEvent) {
  if (parallaxMode !== 'pointer') return
  await parallax.activate(e.currentTarget as HTMLElement, c.avatarBlobId, c.depthBlobId)
}
function onCardMove(e: PointerEvent) {
  parallax.pointer(e)
}
function onCardLeave() {
  if (parallaxMode === 'pointer') parallax.release()
}
function releaseParallax() {
  parallax.release()
}

function onIntersect(entries: IntersectionObserverEntry[]) {
  for (const en of entries) {
    const el = en.target as HTMLElement
    const c = chars.byId(el.dataset['id'])
    if (en.isIntersecting && c) void parallax.activate(el, c.avatarBlobId, c.depthBlobId)
    else parallax.deactivate(el)
  }
}

/**
 * （重新）观察所有画框。重建而不是增量 observe：角色增删、换图、生成深度图都会走到这里，
 * 重建后观察器会对每个画框各回调一次当前可见性，已挂的卡按新数据重挂（纹理多半命中缓存）。
 */
function observeCards() {
  io?.disconnect()
  io = null
  releaseParallax()
  if (parallaxMode !== 'tilt' || !pageActive || !scroller.value) return
  io = new IntersectionObserver(onIntersect, {
    root: scroller.value,
    rootMargin: '100px 0px',
    threshold: 0,
  })
  for (const el of scroller.value.querySelectorAll<HTMLElement>('.card__frame[data-id]')) {
    io.observe(el)
  }
}
const hasDepthCards = computed(() =>
  chars.items.some((c) => parallax.eligible(c.avatarBlobId, c.depthBlobId)),
)
watch(
  () => chars.items.map((c) => `${c.id}:${c.avatarBlobId}:${c.depthBlobId}`).join('|'),
  () => void nextTick(observeCards),
)
onActivated(() => {
  pageActive = true
  void nextTick(observeCards)
})
onDeactivated(() => {
  pageActive = false
  io?.disconnect()
  io = null
  releaseParallax()
})
onBeforeUnmount(() => io?.disconnect())

/**
 * 该不该给这张卡挂 view-transition-name。两个方向各一个来源：
 *  - morphingId：本页发起的「去编辑页」
 *  - morph.target：编辑页发起的「回列表页」，它够不到本页 DOM，只能隔空指定
 *
 * 返回 undefined 时 Vue 会直接移除该行内样式 —— 保证任一时刻最多一个同名元素，
 * 不需要手动清理（同名撞车会让整个过渡被 skip 且不报错）。
 */
function morphStyle(id: string) {
  return morphingId.value === id || morph.target.value === id
    ? { viewTransitionName: MORPH_VT_NAME }
    : undefined
}

/**
 * 预热编辑页的路由 chunk。
 *
 * 这是整条链路上**唯一真正剩下的异步**：vue-router 在导航 finalize 之前
 * 就要下完懒加载 chunk，而 updateCallback 期间整页渲染是冻结的 ——
 * 不预热的话，首次点击会把 chunk 下载整段框进冻结期，弱网下就是「点了没反应」。
 * 提前 import 之后 Vite 的模块缓存让 router 那次 import() 同步命中。
 *
 * hover / 按下时就开始，等到 click 时通常已经就绪。
 */
function prewarm() {
  void import('@/views/CharacterEditView.vue')
}

/**
 * 进入编辑页。两个入口（点头像、点「编辑」按钮）都走这里 ——
 * 原则是**morph 主体、不 morph 触发器**：被带到下一页的「物」是那张立绘，
 * 按钮只是控件，所以源元素永远取同一张 .card__img。
 */
async function openEditor(id: string) {
  if (morphing) return
  // 点击时鼠标必然在卡上，此刻画框里盖着视差 canvas。不摘掉的话 VT 拍到的
  // 「旧」端是一块 canvas，而编辑页那端是 <img> —— 两端对不上，
  // 那个精心调过的「卡片归位」morph 会变成一次莫名其妙的形变。
  releaseParallax()
  const go = () => router.push(`/characters/${id}`)
  if (!vt.supported) {
    await go()
    return
  }
  morphing = true
  // 把 chunk 拉到过渡之外再开始，别让下载落进冻结期
  await import('@/views/CharacterEditView.vue')
  morphingId.value = id
  // 命名是响应式绑定，要等它真正落到 DOM 之后再开始捕获旧状态
  await nextTick()
  try {
    // run() 内部等的是 finished，所以这里的 finally 是在**动画真正结束后**
    // 才清名字；挂在更早的时机会在动画进行中把名字摘掉
    await vt.run(go)
  } finally {
    morphingId.value = null
    morphing = false
  }
}

async function create() {
  const c = await chars.create()
  await router.push(`/characters/${c.id}`)
}

async function startChat(id: string, name: string) {
  const meta = await chats.createSolo(id, name)
  await router.push(`/chat/${meta.id}`)
}

async function onImport(e: Event) {
  const files = (e.target as HTMLInputElement).files
  if (!files?.length) return
  let ok = 0
  for (const f of files) {
    try {
      const id = crypto.randomUUID()
      let raw: unknown
      if (f.name.toLowerCase().endsWith('.png')) {
        raw = await readCharaFromPng(new Uint8Array(await f.arrayBuffer()))
      } else {
        raw = JSON.parse(await f.text())
      }
      const c = normalizeCard(raw, id)
      // PNG 本身就是角色立绘，顺手存成头像
      if (f.name.toLowerCase().endsWith('.png')) {
        c.avatarBlobId = await blobsRepo.put(f)
      }
      await chars.save(c)
      ok++
    } catch (err) {
      toast.error(`${f.name} 导入失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (ok) toast.success(`成功导入 ${ok} 个角色`)
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <AppTopbar title="角色">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="fileInput?.click()">导入角色卡</button>
      <button class="cbx-btn cbx-btn--primary" @click="create">
        <AppIcon name="Plus" /> 新建角色
      </button>
      <input ref="fileInput" type="file" accept=".png,.json" multiple hidden @change="onImport" />
    </template>
  </AppTopbar>

  <div ref="scroller" class="cbx-scroll body">
    <!-- 只有 iOS 会出现：方向传感器必须在用户点击里申请授权 -->
    <button
      v-if="tiltNeedsGrant && hasDepthCards"
      type="button"
      class="cbx-chip tilt-grant"
      @click="enableTilt"
    >
      开启重力视差
    </button>
    <div v-if="!chars.items.length" class="cbx-empty">
      <span class="cbx-empty__icon"><AppIcon name="Characters" tone="brand" /></span>
      <span class="cbx-empty__title">还没有角色</span>
      <span class="cbx-empty__desc">点右上角新建，或导入 SillyTavern 的 PNG / JSON 角色卡</span>
    </div>

    <div v-else class="grid">
      <!-- hover / 按下就开始拉编辑页的 chunk，等真正点下去时通常已就绪，
           这样 chunk 下载不会落进 updateCallback 的冻结期 -->
      <div
        v-for="c in chars.items"
        :key="c.id"
        class="card"
        @pointerenter="prewarm"
        @pointerdown="prewarm"
      >
        <!-- 画框：几何稳定、负责裁切，视差 canvas 挂进它内部（absolute inset:0），
             这样滚动和布局变化都由浏览器自己管，不需要同步坐标 -->
        <div
          class="card__frame"
          :data-id="c.id"
          :style="morphStyle(c.id)"
          @pointerenter="onCardEnter(c, $event)"
          @pointermove="onCardMove"
          @pointerleave="onCardLeave"
          @click="openEditor(c.id)"
        >
          <CbxAvatar class="card__img" :blob-id="c.avatarBlobId" :name="c.data.name" card />
          <!-- 卡片点击进编辑；预览走角落这个按钮（stop 掉，免得同时跳走） -->
          <button
            v-if="c.avatarBlobId"
            type="button"
            class="card__zoom"
            :aria-label="`放大查看「${c.data.name}」的封面`"
            title="放大查看"
            @click.stop="previewCover(c, $event)"
          >
            <ZoomIn :size="18" />
          </button>
        </div>
        <div class="card__name">{{ c.data.name }}</div>
        <div class="card__desc">{{ c.data.description || '（暂无简介）' }}</div>
        <div class="card__ops">
          <button class="cbx-btn cbx-btn--soft sm" @click="startChat(c.id, c.data.name)">
            开始聊天
          </button>
          <button class="cbx-btn cbx-btn--ghost sm" @click="openEditor(c.id)">编辑</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: var(--cbx-space-4);
}
.card {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-1);
}
.tilt-grant {
  margin-bottom: var(--cbx-space-3);
}
.card__frame {
  position: relative;
  cursor: pointer;
  overflow: hidden;
  border-radius: var(--cbx-radius-md);
  aspect-ratio: 2 / 3;
  margin-bottom: var(--cbx-space-2);
  /* 画框自身不能有 transform —— 它是 VT 的配对元素，几何必须和编辑页那端一致 */
}
.card__zoom {
  position: absolute;
  right: var(--cbx-space-2);
  bottom: var(--cbx-space-2);
  z-index: 1;
  width: var(--cbx-tap-min);
  height: var(--cbx-tap-min);
  display: grid;
  place-items: center;
  border: 0;
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  cursor: zoom-in;
}
@media (hover: hover) {
  .card__zoom:hover {
    background: rgba(0, 0, 0, 0.72);
  }
}
.card__zoom:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
.card__img {
  width: 100%;
  height: 100%;
  /* 画框已经负责圆角与裁切，图片再来一次只会在边缘露出锯齿 */
  border-radius: 0;
}
/* `display:block` 只对 <img> 有意义（消掉行内元素底部那几 px 基线缝）。
   ⚠️ 不能写成不限定标签的 `.card__img{display:block}`：没有立绘时 CbxAvatar
   渲染的是 div 占位块，base.css 靠 `display:grid + place-items:center` 让那个
   首字居中，而 scoped 选择器自带 [data-v-*]、(0,2,0) 压得过 base.css 的
   (0,1,0)，于是 grid 被压成 block、字直接贴到左上角。 */
img.card__img {
  display: block;
}
.card__name {
  font-weight: var(--cbx-fw-medium);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card__desc {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.4em;
}
.card__ops {
  display: flex;
  gap: var(--cbx-space-2);
  margin-top: var(--cbx-space-1);
}
.sm {
  flex: 1;
  height: 32px;
  padding: 0 var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .grid {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: var(--cbx-space-3);
  }
  .sm {
    height: var(--cbx-tap-min);
  }
}
</style>
