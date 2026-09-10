<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useGroupsStore } from '@/stores/groups'
import { useToast } from '@/composables/useToast'
import { useViewTransition } from '@/composables/useViewTransition'
import { MORPH_VT_NAME } from '@/constants/app'
import { readCharaFromPng } from '@/services/io/pngCard'
import { normalizeCard } from '@/services/io/characterCard'
import { blobsRepo } from '@/db/repositories'

const router = useRouter()
const chars = useCharactersStore()
const chats = useChatsStore()
const groups = useGroupsStore()
const toast = useToast()
const fileInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  if (!chars.loaded) void chars.load()
  if (!groups.loaded) void groups.load()
})

const vt = useViewTransition()

/**
 * 正在参与过渡的那一张卡的 id。只有它会被挂上 view-transition-name，
 * 保证同一时刻只有一个同名元素（见 MORPH_VT_NAME 的说明）。
 */
const morphingId = ref<string | null>(null)
/** 过渡进行中不接受新的点击：并发两次过渡会互相 skip，观感是「闪一下没动画」 */
let morphing = false

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
      <button class="cbx-btn cbx-btn--ghost" @click="router.push('/groups/new')">＋ 群聊</button>
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
        <CbxAvatar
          class="card__img"
          :blob-id="c.avatarBlobId"
          :name="c.data.name"
          card
          :style="morphingId === c.id ? { viewTransitionName: MORPH_VT_NAME } : undefined"
          @click="openEditor(c.id)"
        />
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

    <template v-if="groups.items.length">
      <div class="cbx-group-label">群聊</div>
      <div class="glist">
        <div
          v-for="g in groups.items"
          :key="g.id"
          class="cbx-nav-item grow"
          @click="router.push(`/groups/${g.id}`)"
        >
          <span class="grow__icon">👥</span>
          <span class="grow__name">{{ g.name }}</span>
          <span class="grow__meta">{{ g.members.length }} 位成员</span>
        </div>
      </div>
    </template>
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
.card__img {
  cursor: pointer;
  margin-bottom: var(--cbx-space-2);
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

.glist {
  margin-top: var(--cbx-space-2);
}
.grow__icon {
  font-size: var(--cbx-fs-lg);
}
.grow__name {
  flex: 1;
}
.grow__meta {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
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
