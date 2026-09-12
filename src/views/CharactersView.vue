<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
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
import { useSettingsStore } from '@/stores/settings'
import { attach, detach, move } from '@/services/depth/parallax'
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
const settings = useSettingsStore()

/**
 * 视差只在「桌面指针 + 未要求减少动效」时启用。
 *
 * 触屏上 pointermove 要么不触发要么语义错乱；而视差是典型的前庭刺激来源，
 * 开了「减少动效」就该彻底不做，而不是把幅度调小。
 * 只算一次：这两项在会话中途不会变。
 */
const parallaxAllowed =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** 当前挂着视差的画框，点击进编辑页前要先摘掉 */
let parallaxHost: HTMLElement | null = null
let hoverRect: DOMRect | null = null

/** 有深度图才做视差；没有就还是一张普通静态图 */
function canParallax(c: { avatarBlobId?: string; depthBlobId?: string }) {
  return parallaxAllowed && !!settings.settings.depth.modelId && !!c.avatarBlobId && !!c.depthBlobId
}

async function onCardEnter(c: Character, e: PointerEvent) {
  if (!canParallax(c)) return
  const el = e.currentTarget as HTMLElement
  hoverRect = el.getBoundingClientRect()
  parallaxHost = el
  const [color, depth] = await Promise.all([
    blobsRepo.get(c.avatarBlobId!),
    blobsRepo.get(c.depthBlobId!),
  ])
  if (!color || !depth || parallaxHost !== el) return
  // 这两个 URL 的生命周期跟着 attach 走，detach 时回收
  const colorUrl = URL.createObjectURL(color)
  const depthUrl = URL.createObjectURL(depth)
  const ok = await attach({ el, colorUrl, depthUrl, aspect: 2 / 3 })
  if (!ok || parallaxHost !== el) {
    URL.revokeObjectURL(colorUrl)
    URL.revokeObjectURL(depthUrl)
    return
  }
  liveUrls = [colorUrl, depthUrl]
}

let liveUrls: string[] = []

function onCardMove(e: PointerEvent) {
  if (!parallaxHost || !hoverRect) return
  // 归一化到 -1..1，原点在画框中心
  const nx = ((e.clientX - hoverRect.left) / hoverRect.width) * 2 - 1
  const ny = ((e.clientY - hoverRect.top) / hoverRect.height) * 2 - 1
  move(nx, ny)
}

function onCardLeave() {
  releaseParallax()
}

function releaseParallax() {
  if (!parallaxHost) return
  detach()
  parallaxHost = null
  hoverRect = null
  for (const u of liveUrls) URL.revokeObjectURL(u)
  liveUrls = []
}

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
      <button class="cbx-btn cbx-btn--primary" @click="create">＋ 新建角色</button>
      <input ref="fileInput" type="file" accept=".png,.json" multiple hidden @change="onImport" />
    </template>
  </AppTopbar>

  <div class="cbx-scroll body">
    <div v-if="!chars.items.length" class="cbx-empty">
      <span class="cbx-empty__icon">🎭</span>
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
          :style="morphStyle(c.id)"
          @pointerenter="onCardEnter(c, $event)"
          @pointermove="onCardMove"
          @pointerleave="onCardLeave"
          @click="openEditor(c.id)"
        >
          <CbxAvatar class="card__img" :blob-id="c.avatarBlobId" :name="c.data.name" card />
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
.card__frame {
  position: relative;
  cursor: pointer;
  overflow: hidden;
  border-radius: var(--cbx-radius-md);
  aspect-ratio: 2 / 3;
  margin-bottom: var(--cbx-space-2);
  /* 画框自身不能有 transform —— 它是 VT 的配对元素，几何必须和编辑页那端一致 */
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
