<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Virtualizer } from 'virtua/vue'
import {
  ImagePlus,
  MessageCircle,
  PanelRight,
  Plus,
  ScanText,
  UsersRound,
} from '@/components/icons'
import AppIcon from '@/components/icons/AppIcon.vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import MessageBubble from '@/components/chat/MessageBubble.vue'
import ChatComposer from '@/components/chat/ChatComposer.vue'
import PromptPreview from '@/components/chat/PromptPreview.vue'
import StatusPanel from '@/components/chat/StatusPanel.vue'
import { useImagePreview, type PreviewItem } from '@/composables/useImagePreview'
import { dialogueImagePrompt, pickSceneCharacters, statusAt } from '@/services/image/prompts'
import { dialogueImagePromptViaLLM } from '@/services/image/promptFromLLM'
import type { GeneratedImage, ImageRefCandidate } from '@/types/image'
import type { ChatMessage } from '@/types/chat'
import { useChatsStore } from '@/stores/chats'
import { useCharactersStore } from '@/stores/characters'
import { useGroupsStore } from '@/stores/groups'
import { useSettingsStore } from '@/stores/settings'
import { useGenerationStore } from '@/stores/generation'
import { useUiStore } from '@/stores/ui'
import { useStatusStore } from '@/stores/status'
import { useImageJobStore, type RevealRequest } from '@/stores/imageJob'
import { useMediaQuery, DRAWER_MQ } from '@/composables/useDrawerSwipe'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { useToast } from '@/composables/useToast'
import { messagesRepo } from '@/db/repositories'
import { accentOf } from '@/utils/charAccent'
import { confirmDialog } from '@/composables/useConfirm'

const route = useRoute()
const router = useRouter()
const chats = useChatsStore()
const chars = useCharactersStore()
const groups = useGroupsStore()
const settings = useSettingsStore()
const gen = useGenerationStore()
const toast = useToast()
const ui = useUiStore()
const status = useStatusStore()
const isMobile = useMediaQuery(DRAWER_MQ)

// ── 角色状态侧栏 ──────────────────────────────────────────
const showStatus = computed(() => !!chats.current && status.enabled)
/** 浮层形态（手机 / 桌面未固定）：聊天时要让开 */
const statusFloating = computed(() => isMobile.value || !ui.statusPinned)
function toggleStatus() {
  ui.statusOpen = !ui.statusOpen
}
/**
 * 输入框获得焦点 = 要开始打字了，浮层收起别挡着。
 * 挂在 .chat-col 上按目标判断：ChatComposer 是多根组件（带 Teleport），@focusin 透传不下去
 */
function onColFocus(e: FocusEvent) {
  if (!statusFloating.value) return
  if (e.target instanceof Element && e.target.closest('.composer')) ui.statusOpen = false
}
/**
 * 入口按钮上的「有新状态」圆点：侧栏关着时出现了新快照。
 * 以「快照所在消息 id + 更新时间」为键；打开侧栏或切换会话时视为已读。
 */
const statusKey = computed(() => {
  const cur = status.current
  return cur ? `${cur.msg.id}:${cur.status.updatedAt}` : ''
})
const statusSeen = ref('')
watch(
  [statusKey, () => ui.statusOpen],
  ([key, open]) => {
    if (open) statusSeen.value = key
  },
  { immediate: true },
)
const statusUnseen = computed(
  () => !ui.statusOpen && !!statusKey.value && statusKey.value !== statusSeen.value,
)
const imageJob = useImageJobStore()
const canGenerateImage = computed(() =>
  chats.messages.some((m) => !m.is_system && !m.exclude && m.mes.trim()),
)

/**
 * 打开对话配图。任务交给应用层（stores/imageJob.ts，App.vue 渲染对话框）：
 * 最小化后离开聊天页（手机上一个返回手势）生成也不会被取消。
 *
 * 参考图候选池：出场角色的封面 + 演绎封面 + 本会话此前的全部配图（新的在前）。
 * 默认只勾选角色封面 —— 演绎按 pickSceneCharacters 挑这一幕真正出场的人，
 * 不把全体成员都塞进去（不在场的人被画进来、面孔互相串）。用户可在对话框里再增删。
 *
 * ⚠️ 下面的回调都闭包住**打开这一刻**的会话快照（chatId / 消息列表），不读 chats.current：
 * 对话框活得比聊天页久，用户中途切了会话，回调里读到的就是别人的消息。
 */
function openImage(messageId?: string) {
  // 已有一个（最小化的）配图任务：先把它展开，同一时刻只跑一个
  if (imageJob.job) {
    imageJob.minimized = false
    return
  }
  if (!chats.current || gen.busy) return
  const chatId = chats.current.id
  const rows = [...chats.messages]
  const target = messageId
    ? rows.find((m) => m.id === messageId)
    : [...rows].reverse().find((m) => !m.is_system && !m.exclude && m.mes.trim())
  if (!target || target.is_system || target.exclude || !target.mes.trim()) return
  const cast = isGroup.value
    ? groupMembers.value
    : [chars.byId(chats.current.characterId)].filter((c) => !!c)
  const candidates: ImageRefCandidate[] = cast.map((c) => ({
    id: `char:${c.id}`,
    kind: 'character',
    name: c.data.name,
    ...(c.avatarBlobId ? { blobId: c.avatarBlobId } : {}),
    label: `${c.data.name}的封面`,
    characterId: c.id,
    description: c.data.description,
  }))
  const g = group.value
  if (isGroup.value && g?.avatarBlobId)
    candidates.push({
      id: `group:${g.id}`,
      kind: 'group',
      name: g.name,
      blobId: g.avatarBlobId,
      label: '演绎封面',
    })
  const history: ImageRefCandidate[] = []
  rows.forEach((m, i) => {
    for (const img of m.images ?? [])
      history.push({
        id: `img:${img.blobId}`,
        kind: 'history',
        name: m.name,
        blobId: img.blobId,
        label: `第 ${i + 1} 条 · ${m.name}的配图`,
      })
  })
  const picked = isGroup.value
    ? pickSceneCharacters(target, rows, groupMembers.value)
    : cast.slice(0, 1)
  // 目标消息那一刻的角色状态、以及它之前（含）的对话
  const status = statusAt(rows, target.seq)
  const before = rows.filter((m) => m.seq <= target.seq)

  imageJob.start({
    title: '生成对话配图',
    applyLabel: '保存到对话',
    requireReferences: true,
    // 历史配图新的在前（前面的角色 / 演绎封面顺序不动）
    candidates: [...candidates, ...history.reverse()],
    defaultSelected: picked.map((c) => `char:${c.id}`),
    // 模板提示词：着重当前场景、表情、肢体动作与穿着
    buildPrompt: (refs) => dialogueImagePrompt(target, refs, status),
    // 用已配置的 LLM 依据最近对话 + 角色状态生成（失败回退模板）
    generatePrompt: async (signal, refs) => {
      const p = settings.settings.provider
      const apiKey = await settings.getApiKey(p.secretRef)
      return dialogueImagePromptViaLLM({
        message: target,
        history: before,
        refs,
        status,
        provider: p,
        apiKey,
        signal,
      })
    },
    apply: async (image: GeneratedImage) => {
      const blobId = await chats.attachImage(chatId, target.id, image)
      // 可点击：用户可能已经聊到别处、切到别的会话、甚至离开了聊天页，点一下回到这张图
      toast.action('success', '配图已生成并保存到对话', {
        label: '查看',
        run: () =>
          void imageJob.requestReveal({
            chatId,
            messageId: target.id,
            ...(blobId ? { blobId } : {}),
          }),
      })
    },
  })
}

/**
 * 流程控制「生成配图」动作：一轮生成结束后，最新的运行态若带配图标记，就给那条回复打开配图面板。
 * 只打开面板、不自动调用生图 —— 参考图与提示词仍由用户确认，避免规则悄悄消耗额度。
 * 已处理过的消息记在内存里：重开页面不会对旧消息再弹一次（只看本页生成结束的那一刻）。
 */
const flowImageDone = new Set<string>()
watch(
  () => gen.busy,
  (busy, was) => {
    if (busy || !was) return
    const target = [...chats.messages].reverse().find((m) => m.extra?.flow)
    if (!target?.extra?.flow?.image || flowImageDone.has(target.id)) return
    flowImageDone.add(target.id)
    void nextTick(() => openImage(target.id))
  },
)

/**
 * 执行「定位到配图」：imageJob.reveal 由提示的「查看」发起（它负责跳到对应会话），
 * 这里等会话打开、定位完成后滚动过去并闪一下。虚拟滚动下目标可能没渲染，先让 virtua 滚进来。
 */
async function revealImage(req: RevealRequest) {
  const { messageId, blobId } = req
  const index = chats.messages.findIndex((m) => m.id === messageId)
  if (index < 0) {
    toast.info('这条消息已经不在了')
    return
  }
  if (virtualized.value) {
    vlist.value?.scrollToIndex(index, { align: 'center' })
    await new Promise((r) => setTimeout(r, 60))
  }
  await nextTick()
  const row = scroller.value?.querySelector<HTMLElement>(`[data-msg-id="${messageId}"]`)
  const figure = (blobId && row?.querySelector<HTMLElement>(`[data-blob-id="${blobId}"]`)) || row
  if (!figure) return
  const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  figure.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' })
  figure.classList.remove('message-image--flash')
  void figure.offsetWidth // 重新触发动画
  figure.classList.add('message-image--flash')
  setTimeout(() => figure.classList.remove('message-image--flash'), 1700)
}

watch(
  () => route.params['id'],
  () => {
    if (statusFloating.value) ui.statusOpen = false
  },
)

const scroller = ref<HTMLElement | null>(null)
const { stuck, scrollToBottom, follow } = useAutoScroll(scroller)

/**
 * 打开会话期间先藏住消息流，滚到底之后再显示，消掉「先顶部后弹底」那一下。
 *
 * ⚠️ 只作用于 `.stream`，绝不能连 `.welcome` 一起藏：新会话发第一条时
 * `createSolo → seedGreeting → appendUser` 会让长度在一次操作里 0→1→2，
 * 途中要经过空态，藏错地方就是空态闪一下。
 */
const positioning = ref(false)

/**
 * 「定位到配图」：会话切到位、打开时的定位完成（positioning 结束）再执行。
 * 不用 immediate：setup 阶段 DOM 还没挂、虚拟列表的 ref 也还没声明。
 * 从别的页面点「查看」回到**同一个**会话时 id 与 positioning 都不变，watch 不触发 ——
 * 由 onMounted 末尾补调一次 tryReveal。
 */
function tryReveal() {
  const req = imageJob.reveal
  if (!req || positioning.value || req.chatId !== chats.current?.id) return
  imageJob.reveal = null
  void revealImage(req)
}
watch(() => [imageJob.reveal, chats.current?.id, positioning.value], tryReveal)

/**
 * 超过这么多条才启用虚拟滚动（沿用 docs/design-data-arch.md 的既定阈值）。
 *
 * 不是无条件开：虚拟滚动会让浏览器的 Ctrl+F 查找与跨消息拖选只覆盖已渲染的那一屏，
 * 而本页**没有**会话内搜索，Ctrl+F 是用户翻旧话的唯一手段。分档能把这个代价
 * 限制在真正长、真正会卡的会话里。
 */
const VIRTUAL_THRESHOLD = 500

/**
 * 是否虚拟化。**只在打开会话时定一次**，不跟着 length 走 —— 否则会话聊到第 501 条时
 * 整个列表会在用户眼皮底下从扁平切成虚拟，滚动位置和正在进行的编辑都会被掀翻。
 */
const virtualized = ref(false)
const vlist = ref<{ scrollToIndex: (i: number, opts?: { align?: string }) => void } | null>(null)

/**
 * `.body` 的上内边距。virtua 要知道自己前面还隔着多少空白才能把偏移算对，
 * 而这个值是响应式的（≥768px 是 --cbx-space-8，窄屏是 --cbx-space-4），
 * 挂载时量一次在断点切换/旋转/改窗口大小之后就是错的。
 */
const startMargin = ref(0)
function measureStartMargin() {
  const node = scroller.value
  if (!node) return
  startMargin.value = Number.parseFloat(getComputedStyle(node).paddingTop) || 0
}
let ro: ResizeObserver | undefined

/**
 * 正在内联编辑的那条消息 id。虚拟滚动下必须把它钉住不卸载，
 * 否则用户改到一半滚开，草稿（组件内状态）就没了。
 * 按 **id** 记而不是下标：中途删一条会让下标指向另一条消息。
 */
const editingId = ref<string | null>(null)
const pinned = computed(() => {
  if (!editingId.value) return []
  const i = chats.messages.findIndex((m) => m.id === editingId.value)
  return i >= 0 ? [i] : []
})

/** 扁平列表与虚拟列表共用的一份气泡绑定，两处只能有一个真相 */
function bubbleProps(m: ChatMessage) {
  return {
    msg: m,
    streaming: m.id === streamingId.value,
    showName: !m.is_user,
    avatarBlobId: chars.byId(m.original_avatar)?.avatarBlobId,
    accent: isGroup.value ? accentOf(m.original_avatar) : undefined,
    canGenerateImage: !gen.busy && !m.is_system && !m.exclude && !!m.mes.trim(),
    onGenerateImage: () => openImage(m.id),
    onImageLoaded: follow,
    onOpenImage: openViewer,
    onRegenerate: () => void gen.regenerate(),
    onSwipe: (d: -1 | 1) => void onSwipe(m.id, d),
    onCopy: () => toast.success('已复制'),
    onEdit: (t: string) => void onEdit(m.id, t),
    onRemove: () => void onRemove(m.id),
    onRemoveFrom: () => void onRemoveFrom(m.id),
    onBranch: () => void onBranch(m.id),
    onEditingChange: (on: boolean) => {
      // 退出编辑时只清自己那一条，避免「A 退出」把「B 进入」刚设的值抹掉
      if (on) editingId.value = m.id
      else if (editingId.value === m.id) editingId.value = null
    },
  }
}

const title = computed(() => chats.current?.title ?? '聊天')
const hasChat = computed(() => !!chats.current)
const isGroup = computed(() => chats.current?.kind === 'group')
const group = computed(() => groups.byId(chats.current?.groupId))
const groupMembers = computed(() =>
  (group.value?.members ?? [])
    .map((id) => chars.byId(id))
    .filter((c): c is NonNullable<typeof c> => !!c),
)
/** 输入框「@ 提及」候选：仅演绎 */
const mentionMembers = computed(() =>
  isGroup.value
    ? groupMembers.value.map((c) => ({ id: c.id, name: c.data.name, avatarBlobId: c.avatarBlobId }))
    : undefined,
)
/** 手动策略时显示点名条 */
const showSpeakerTray = computed(() => isGroup.value && group.value?.activation_strategy === 2)
const streamingId = computed(() =>
  gen.busy ? chats.messages[chats.messages.length - 1]?.id : undefined,
)

async function syncRoute() {
  const id = route.params['id']
  const chatId = Array.isArray(id) ? id[0] : id
  if (!chatId) {
    chats.close()
    return
  }
  if (chats.current?.id === chatId) return
  positioning.value = true
  try {
    await chats.open(chatId)
    // 刚打开的会话里已有的快照不算「新」
    statusSeen.value = statusKey.value
    editingId.value = null
    virtualized.value = chats.messages.length > VIRTUAL_THRESHOLD
    // nextTick 之后 DOM 已打补丁但尚未绘制，这里同步滚到底，首帧就是底部
    await nextTick()
    measureStartMargin()
    if (virtualized.value) {
      // 虚拟列表刚挂载时下方全是估算高度，原生的 scrollHeight 够不到真正的底，
      // 只有这一次要走 virtua 自己的定位
      vlist.value?.scrollToIndex(chats.messages.length - 1, { align: 'end' })
      await nextTick()
    }
    scrollToBottom()
  } finally {
    // 无论打开成功与否都要放出来，否则消息流永远隐身
    positioning.value = false
  }
}

onMounted(async () => {
  if (!chars.loaded) await chars.load()
  await chats.loadList()
  await syncRoute()
  // 只盯滚动容器的尺寸变化来重量 padding：断点切换、旋转、改窗口大小都会走到这里
  if (scroller.value) {
    ro = new ResizeObserver(measureStartMargin)
    ro.observe(scroller.value)
  }
  tryReveal()
})
onBeforeUnmount(() => {
  ro?.disconnect()
  ro = undefined
})

watch(() => route.params['id'], syncRoute)
// 流式增长时跟随贴底
watch(
  () => chats.messages[chats.messages.length - 1]?.mes,
  () => void nextTick(follow),
)
watch(
  () => chats.messages.length,
  () => void nextTick(follow),
)

async function onSend(text: string) {
  if (!chats.current) {
    // 没有会话时自动开一个
    const meta = await chats.createSolo(undefined, '新对话')
    await router.push(`/chat/${meta.id}`)
    await chats.open(meta.id)
  }
  await chats.appendUser(text)
  if (statusFloating.value) ui.statusOpen = false
  await nextTick()
  scrollToBottom()
  if (isGroup.value) await gen.sendGroup({ isUserInput: true })
  else await gen.send()
}

/** 1vN 手动点名 */
async function speakAs(id: string) {
  await gen.sendGroup({ forceId: id, isUserInput: false })
}

async function onSwipe(msgId: string, dir: -1 | 1) {
  const msg = chats.messages.find((m) => m.id === msgId)
  if (!msg?.swipes?.length) return
  const n = msg.swipes.length
  const next = ((msg.swipe_id ?? 0) + dir + n) % n
  const text = msg.swipes[next]
  if (text === undefined) return
  chats.patchLocal(msgId, { swipe_id: next, mes: text })
  const row = chats.messages.find((m) => m.id === msgId)
  if (row) await messagesRepo.update(row)
}

const previewOpen = ref(false)

/**
 * 整段对话的配图按消息顺序拍平成一个相册，预览里左右切换就能连着看，
 * 不用退出来再点下一张。每条消息的多张图保持原顺序。
 */
const gallery = computed<PreviewItem[]>(() =>
  chats.messages.flatMap((m) =>
    (m.images ?? []).map((img) => ({
      blobId: img.blobId,
      caption: [m.name, img.serviceName, img.model].filter(Boolean).join(' · '),
    })),
  ),
)
const imagePreview = useImagePreview()
/** 从本会话全部配图组成的相册里打开，预览里可左右切换 */
function openViewer(blobId: string, el?: HTMLElement) {
  const i = gallery.value.findIndex((g) => g.blobId === blobId)
  if (i >= 0) void imagePreview.open(gallery.value, i, el)
}

async function onEdit(id: string, text: string) {
  await chats.editMessage(id, text)
}
async function onRemove(id: string) {
  if (!(await confirmDialog({ text: '删除这条消息？' }))) return
  await chats.deleteMessage(id)
}
async function onRemoveFrom(id: string) {
  if (!(await confirmDialog({ text: '删除这条消息以及它之后的全部消息？此操作不可撤销。' }))) return
  await chats.deleteFrom(id)
}
async function onBranch(id: string) {
  const meta = await chats.branchFrom(id)
  if (!meta) return
  toast.success('已分支出新对话')
  await router.push(`/chat/${meta.id}`)
}

/**
 * 聊天页的「新对话」：**沿用它所在会话的角色 / 演绎**再开一段。
 * 在某个角色的对话里点，就再开一段和同一角色的；在演绎里点，就再开一段同一个演绎的。
 * 没有会话时（空聊天页）回落到通用助手，与这里原来的行为一致。
 */
async function newChat() {
  const cur = chats.current
  if (cur?.kind === 'group' && cur.groupId) {
    const g = groups.byId(cur.groupId)
    const meta = await chats.createGroup(cur.groupId, g?.name ?? cur.title)
    await router.push(`/chat/${meta.id}`)
    return
  }
  const char = cur?.characterId ? chars.byId(cur.characterId) : undefined
  const meta = await chats.createSolo(char?.id, char?.data.name ?? '新对话')
  await router.push(`/chat/${meta.id}`)
}
</script>

<template>
  <AppTopbar :title="title" class="chat-topbar">
    <template #actions>
      <span
        v-if="settings.settings.chat.showTokens && gen.lastPrompt"
        class="cbx-badge cbx-badge--brand"
      >
        {{ gen.lastPrompt.debug.tokens }} tok
      </span>
      <button
        v-if="hasChat"
        class="cbx-btn cbx-btn--ghost topbar-action"
        title="根据当前对话与角色参考图生成配图"
        aria-label="生成对话配图"
        :disabled="gen.busy || !canGenerateImage"
        @click="openImage()"
      >
        <ImagePlus :size="20" aria-hidden="true" /><span>生成配图</span>
      </button>
      <button
        v-if="showStatus"
        class="cbx-btn cbx-btn--ghost topbar-action status-toggle"
        :class="{ 'status-toggle--on': ui.statusOpen }"
        :title="
          status.lastError
            ? `最近一轮没有更新状态：${status.lastError.error}`
            : '时间、地点、心情、背包等角色状态'
        "
        aria-label="角色状态"
        :aria-pressed="ui.statusOpen"
        @click="toggleStatus"
      >
        <PanelRight :size="20" aria-hidden="true" /><span>状态</span>
        <i
          v-if="status.lastError || statusUnseen"
          class="status-dot"
          :class="{ 'status-dot--warn': status.lastError }"
          aria-hidden="true"
        ></i>
      </button>
      <button
        v-if="hasChat"
        class="cbx-btn cbx-btn--ghost topbar-action"
        title="看看到底发了什么给模型"
        aria-label="预览提示词"
        @click="previewOpen = true"
      >
        <ScanText :size="20" aria-hidden="true" /><span>预览提示词</span>
      </button>
      <button
        class="cbx-btn cbx-btn--soft topbar-action"
        aria-label="新对话"
        title="新对话"
        @click="newChat"
      >
        <Plus :size="20" aria-hidden="true" /><span>新对话</span>
      </button>
    </template>
  </AppTopbar>

  <!-- 聊天列 + 右侧状态栏（固定常驻时并排；浮层时 StatusPanel 自己 fixed 定位） -->
  <div class="chat-row">
    <div class="chat-col" @focusin="onColFocus">
      <!-- .stage 只为「回到底部」按钮提供定位上下文：它贴着消息区的底边，
       天然避开点名条与 composer，不用去量它们的高度 -->
      <div class="stage">
        <div
          ref="scroller"
          class="cbx-scroll body"
          :class="{ 'body--empty': !chats.messages.length }"
        >
          <div v-if="!chats.messages.length" class="welcome">
            <div class="welcome-icon">
              <MessageCircle :size="32" aria-hidden="true" />
            </div>
            <h2>从一句话，开始新的故事</h2>
            <p>分享一个想法，或向你的角色打个招呼。<br />每一段对话，都从这里开始。</p>
            <RouterLink to="/characters" class="welcome-link"
              ><UsersRound :size="16" aria-hidden="true" />选择一个角色</RouterLink
            >
          </div>

          <!-- 两个分支共用 bubbleProps()，避免十几行绑定抄两遍之后改一处漏一处 -->
          <Virtualizer
            v-else-if="virtualized"
            ref="vlist"
            class="stream"
            :class="{ 'stream--positioning': positioning }"
            :data="chats.messages"
            :start-margin="startMargin"
            :keep-mounted="pinned"
            v-slot="{ item: m }"
          >
            <MessageBubble :key="m.id" v-bind="bubbleProps(m)" />
          </Virtualizer>

          <div v-else class="stream" :class="{ 'stream--positioning': positioning }">
            <MessageBubble v-for="m in chats.messages" :key="m.id" v-bind="bubbleProps(m)" />
          </div>
        </div>

        <Transition name="jump">
          <button
            v-if="!stuck && chats.messages.length"
            type="button"
            class="jump"
            aria-label="回到最新消息"
            title="回到最新消息"
            @click="scrollToBottom(true)"
          >
            <AppIcon name="ArrowDownToLine" :size="20" />
          </button>
        </Transition>
      </div>

      <!-- 1vN 手动策略：点名条 -->
      <div v-if="showSpeakerTray" class="tray">
        <span class="tray__hint">点名发言：</span>
        <button
          v-for="c in groupMembers"
          :key="c.id"
          class="cbx-chip tray__item"
          :disabled="gen.busy"
          @click="speakAs(c.id)"
        >
          {{ c.data.name }}
        </button>
      </div>

      <ChatComposer
        :busy="gen.busy"
        :send-on-enter="settings.settings.chat.sendOnEnter"
        :members="mentionMembers"
        @send="onSend"
        @stop="gen.stop()"
      />
    </div>
    <StatusPanel v-if="showStatus" />
  </div>

  <PromptPreview v-if="previewOpen" @close="previewOpen = false" />
</template>

<style scoped>
/* 聊天列与状态栏并排。两层都要 min-height:0 / min-width:0，否则内容会撑破 flex 轨道 */
.chat-row {
  flex: 1;
  min-height: 0;
  display: flex;
}
.chat-col {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.status-toggle {
  position: relative;
}
.status-toggle--on {
  color: var(--cbx-brand);
  background: var(--cbx-brand-light);
}
.status-dot {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--cbx-brand);
  box-shadow: 0 0 0 2px var(--cbx-bg);
}
.status-dot--warn {
  background: var(--cbx-warning);
}
/* 接过原先 .body 的伸缩职责。⚠️ flex:1 与 min-height:0 缺一不可：
   少了 min-height:0，滚动容器会被内容撑破、把 composer 顶出屏幕（base.css 有记载） */
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.body {
  flex: 1;
  padding: var(--cbx-space-8) var(--cbx-space-6) var(--cbx-space-4);
  background: radial-gradient(ellipse at 50% 0, var(--cbx-brand-subtle), transparent 65%);
}
/* 定位期间只藏消息流（不影响布局，scrollHeight 照常算），滚到底后再显形 */
.stream--positioning {
  opacity: 0;
}

.jump {
  position: absolute;
  right: var(--cbx-space-6);
  bottom: var(--cbx-space-4);
  z-index: 10;
  width: var(--cbx-tap-min);
  height: var(--cbx-tap-min);
  display: grid;
  place-items: center;
  /* 白底 + 品牌色箭头：聊天区底色本就接近白，用 --cbx-text-secondary 的灰箭头
     配浅边框实测几乎看不见。不做成 send 按钮那样的品牌实心 —— 它就在正下方，
     两个实心圆叠在一起会抢主次。 */
  border: 1px solid var(--cbx-brand-light-hover);
  border-radius: 50%;
  background: var(--cbx-bg);
  color: var(--cbx-brand);
  box-shadow: var(--cbx-shadow-lg);
  cursor: pointer;
  transition:
    background var(--cbx-transition),
    color var(--cbx-transition),
    border-color var(--cbx-transition);
}
@media (hover: hover) {
  .jump:hover {
    background: var(--cbx-brand-light);
    border-color: var(--cbx-brand);
    color: var(--cbx-brand-hover);
  }
}
.jump:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 3px;
}
/* 抄 CbxToastHost 的进出场；它在底部，所以位移取正方向 */
.jump-enter-active,
.jump-leave-active {
  transition:
    opacity var(--cbx-transition),
    transform var(--cbx-transition);
}
.jump-enter-from,
.jump-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
@media (prefers-reduced-motion: reduce) {
  .jump-enter-active,
  .jump-leave-active {
    transition: none;
  }
}
.body--empty {
  display: grid;
  place-items: center;
}
.welcome {
  padding: var(--cbx-space-8) var(--cbx-space-4);
  text-align: center;
}
.welcome-icon {
  display: grid;
  place-items: center;
  width: 72px;
  height: 72px;
  margin: 0 auto var(--cbx-space-6);
  border: 1px solid var(--cbx-brand-light-hover);
  border-radius: var(--cbx-radius-xl);
  color: var(--cbx-brand);
  background: var(--cbx-bg);
  box-shadow: var(--cbx-shadow-sm);
  transform: rotate(-6deg);
}
.welcome-icon svg {
  transform: rotate(6deg);
}
.welcome h2 {
  font-size: clamp(20px, 2.5vw, 28px);
  font-weight: var(--cbx-fw-medium);
  letter-spacing: 0.02em;
}
.welcome p {
  margin: var(--cbx-space-3) 0 var(--cbx-space-6);
  color: var(--cbx-text-tertiary);
  font-size: var(--cbx-fs-sm);
  line-height: 1.9;
}
.welcome-link {
  display: inline-flex;
  align-items: center;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-2) var(--cbx-space-4);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-brand-subtle);
  color: var(--cbx-brand);
  font-size: var(--cbx-fs-sm);
  text-decoration: none;
}
.welcome-link:hover {
  background: var(--cbx-brand-light-hover);
}
.chat-topbar :deep(.title) {
  min-width: 0;
}
.chat-topbar :deep(.actions) {
  flex-shrink: 0;
}
.topbar-action {
  gap: var(--cbx-space-2);
}
.topbar-action svg {
  flex-shrink: 0;
}
.topbar-action:focus-visible,
.welcome-link:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 3px;
}
.stream {
  max-width: var(--cbx-read-w);
  margin: 0 auto;
}

.tray {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  flex-shrink: 0;
  padding: var(--cbx-space-2) var(--cbx-space-5);
  border-top: 1px solid var(--cbx-border);
  overflow-x: auto;
}
.tray__hint {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  flex-shrink: 0;
}
.tray__item {
  flex-shrink: 0;
}

@media (max-width: 767px) {
  .topbar-action {
    width: 40px;
    padding: 0;
  }
  .topbar-action span {
    display: none;
  }
  .chat-topbar :deep(.cbx-badge) {
    display: none;
  }
  .welcome {
    padding: var(--cbx-space-4) 0;
  }
  .welcome-icon {
    width: 60px;
    height: 60px;
    margin-bottom: var(--cbx-space-4);
  }
  .tray {
    padding-left: var(--cbx-space-3);
    padding-right: var(--cbx-space-3);
  }
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
}
</style>
