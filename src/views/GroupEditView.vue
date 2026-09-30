<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import CbxSelect from '@/components/ui/CbxSelect.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import RelationGraph from '@/components/group/RelationGraph.vue'
import StatusConfigEditor from '@/components/settings/StatusConfigEditor.vue'
import ImageGenerationDialog from '@/components/image/ImageGenerationDialog.vue'
import { ImagePlus } from '@/components/icons'
import { useCoverImage } from '@/composables/useCoverImage'
import { useImagePreview } from '@/composables/useImagePreview'
import { parallaxMode, useDepthParallax } from '@/composables/useDepthParallax'
import { groupCoverPrompt } from '@/services/image/prompts'
import { groupCoverPromptViaLLM } from '@/services/image/promptFromLLM'
import { renderRelations } from '@/services/prompt/relations'
import type { GeneratedImage, ImageRefCandidate } from '@/types/image'
import type { CharacterStatusConfig } from '@/types/status'
import FlowEditor from '@/components/flow/FlowEditor.vue'
import FlowSimulator from '@/components/flow/FlowSimulator.vue'
import { resolveStatusFields } from '@/services/status/template'
import type { FlowConfig } from '@/types/flow'
import { useGroupsStore } from '@/stores/groups'
import { useCharactersStore } from '@/stores/characters'
import { useWorldsStore } from '@/stores/worlds'
import { useChatsStore } from '@/stores/chats'
import { useToast } from '@/composables/useToast'
import { toPlain } from '@/utils/plain'
import {
  group_activation_strategy,
  group_generation_mode,
  resolvePersona,
  DEFAULT_RELATION_TEMPLATE,
  USER_NODE_ID,
  type Group,
  type GroupRelation,
} from '@/types/group'
import { useSettingsStore } from '@/stores/settings'
import { confirmDialog } from '@/composables/useConfirm'

const route = useRoute()
const router = useRouter()
const groups = useGroupsStore()
const chars = useCharactersStore()
const worlds = useWorldsStore()
const worldBookOptions = computed(() => [
  { value: '', label: '使用全局世界书' },
  ...worlds.items.map((book) => ({ value: book.id, label: book.name })),
])
const selectedWorldBook = computed({
  get: () => model.value?.worldBookId ?? '',
  set: (id: string) => { if (model.value) model.value.worldBookId = id },
})
const chats = useChatsStore()
const toast = useToast()

const model = ref<Group | null>(null)
const tab = ref<'members' | 'relations' | 'strategy' | 'status' | 'flow'>('members')
const relView = ref<'list' | 'graph'>('list')

const STRATEGIES = [
  {
    v: group_activation_strategy.NATURAL,
    label: '自然顺序',
    desc: '按发言意愿掷骰，被点名优先，可能多人同时发言',
  },
  { v: group_activation_strategy.LIST, label: '列表顺序', desc: '每个成员依次各发言一次' },
  { v: group_activation_strategy.POOLED, label: '轮流', desc: '每轮一人，优先挑还没说过话的' },
  { v: group_activation_strategy.MANUAL, label: '手动', desc: '不自动回复，你点名谁谁才说话' },
]

const MODES = [
  { v: group_generation_mode.SWAP, label: '只用当前发言者的卡', desc: '最省 token，推荐' },
  {
    v: group_generation_mode.APPEND,
    label: '拼接所有未静音成员的卡',
    desc: '角色更了解彼此，但更费 token',
  },
  { v: group_generation_mode.APPEND_DISABLED, label: '拼接全部成员的卡（含静音）', desc: '' },
]

const memberChars = computed(() =>
  (model.value?.members ?? [])
    .map((id) => chars.byId(id))
    .filter((c): c is NonNullable<typeof c> => !!c),
)

const settings = useSettingsStore()

/** 模板里要显示字面的 {{user}}，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const USER_MACRO = '{{user}}'

/** 本演绎实际生效的「我」—— 演绎留空就显示全局人设的值，让用户看得见回落结果 */
const effectivePersona = computed(() =>
  resolvePersona(model.value ?? undefined, settings.settings.persona),
)

/**
 * 关系图谱的节点集合 = 用户自己 + 全体成员。
 *
 * 用户排在最前：他是玩家视角的锚点，画布初始布局按顺序排圆周，放第一个
 * 位置最稳定。列表视图的下拉也跟着这个顺序，「我」永远是第一项。
 */
const relationOptions = computed(() =>
  relationNodes.value.map((n) => ({
    value: n.id,
    label: n.isUser ? `${n.name}（我）` : n.name,
  })),
)
const relationNodes = computed(() => [
  { id: USER_NODE_ID, name: effectivePersona.value.name, isUser: true },
  ...memberChars.value.map((c) => ({ id: c.id, name: c.data.name, isUser: false })),
])
const candidates = computed(() =>
  chars.items.filter((c) => !(model.value?.members ?? []).includes(c.id)),
)

onMounted(async () => {
  if (!chars.loaded) await chars.load()
  if (!worlds.loaded) await worlds.load()
  if (!groups.loaded) await groups.load()
  const id = route.params['id']
  const gid = Array.isArray(id) ? id[0] : id

  if (gid === 'new') {
    const g = await groups.create()
    await router.replace(`/groups/${g.id}`)
    model.value = toPlain(g)
    return
  }
  const found = gid ? groups.byId(gid) : undefined
  if (!found) {
    toast.error('演绎不存在')
    // 演绎已经有独立的 tab 页了，找不到时回演绎列表，别再甩到角色页
    await router.push('/groups')
    return
  }
  model.value = toPlain(found)
})

async function save() {
  if (!model.value) return
  await groups.save(model.value)
  toast.success('已保存')
}

// ── 角色状态（group.status）：「状态」页签 ──
/** 初始状态里锁定的人：全体成员 + 本演绎的用户身份 */
const statusPeople = computed(() => [
  ...memberChars.value.map((c) => c.data.name),
  effectivePersona.value.name,
])
/**
 * 初始状态表单每敲一个字都会交回一份新配置 —— 走防抖静默保存，
 * 不能每次都调 save()（那会连弹一串「已保存」）。离开页面时把没落盘的冲掉。
 */
let statusTimer: ReturnType<typeof setTimeout> | null = null
function flushStatus() {
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = null
  if (model.value) void groups.save(model.value)
}
function setStatusConfig(cfg: CharacterStatusConfig | undefined) {
  const m = model.value
  if (!m) return
  if (cfg) m.status = cfg
  else delete m.status
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(flushStatus, 500)
}
onBeforeUnmount(() => {
  if (statusTimer) flushStatus()
})

// ── 流程控制（Group.flow）：与状态共用同一个防抖静默保存 ──
/** 模板里直接写字面的双花括号会被当成插值，只能从脚本里给 */
const CHAR_MACRO = '{{char}}'
const flowFields = computed(() =>
  model.value ? resolveStatusFields(settings.settings.status, model.value.status) : [],
)
function setFlowConfig(cfg: FlowConfig | undefined) {
  const m = model.value
  if (!m) return
  if (cfg) m.flow = cfg
  else delete m.flow
  if (statusTimer) clearTimeout(statusTimer)
  statusTimer = setTimeout(flushStatus, 500)
}

// ── 演绎封面（横版 3:2）+ 深度视差 ──────────────────────────
/** 演绎封面是横版合影；视差画布也按这个比例渲染 */
const COVER_ASPECT = 3 / 2
/** OpenAI 兼容接口出横版图；ComfyUI 只出方图，靠 object-fit: cover 裁 */
const COVER_SIZE = '1536x1024'
const coverFrame = ref<HTMLElement | null>(null)
const coverInput = ref<HTMLInputElement | null>(null)
const parallax = useDepthParallax()
const { needsPermission: tiltNeedsGrant, enableTilt } = parallax

/** 封面相关的落盘不弹「已保存」：生成深度图时还会再存一次，连弹两条是噪音 */
async function saveQuiet() {
  if (model.value) await groups.save(model.value)
}
const {
  avatarBusy: coverBusy,
  depthBusy,
  depthPct,
  replace: replaceCover,
  regenDepth,
} = useCoverImage({
  target: () => model.value,
  save: saveQuiet,
  beforeReplace: () => parallax.release(),
})

async function onCoverEnter(e: PointerEvent) {
  if (parallaxMode !== 'pointer' || depthBusy.value) return
  const m = model.value
  await parallax.activate(
    e.currentTarget as HTMLElement,
    m?.avatarBlobId,
    m?.depthBlobId,
    COVER_ASPECT,
  )
}
function onCoverMove(e: PointerEvent) {
  parallax.pointer(e)
}
function onCoverLeave() {
  if (parallaxMode === 'pointer') parallax.release()
}
// 手机倾斜模式：封面与深度图就绪就挂上，任何一项变化先摘再重挂
watch(
  () =>
    [
      coverFrame.value,
      model.value?.avatarBlobId,
      model.value?.depthBlobId,
      depthBusy.value,
    ] as const,
  ([el, avatar, depth, busy]) => {
    if (parallaxMode !== 'tilt') return
    parallax.release()
    if (!el || busy) return
    void parallax.activate(el, avatar, depth, COVER_ASPECT)
  },
)

async function onCoverFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    await replaceCover(f)
    toast.success('演绎封面已更换')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

const imagePreview = useImagePreview()
function previewCover() {
  const m = model.value
  if (!m?.avatarBlobId) return
  void imagePreview.open(
    [{ blobId: m.avatarBlobId, caption: `${m.name} · 演绎封面` }],
    0,
    coverFrame.value?.querySelector('img'),
  )
}

// 生成封面：候选 = 各成员的角色封面，默认全选（对话框按后端上限截断）
const coverOpen = ref(false)
const coverCandidates = computed<ImageRefCandidate[]>(() =>
  memberChars.value.map((c) => ({
    id: `char:${c.id}`,
    kind: 'character',
    name: c.data.name,
    ...(c.avatarBlobId ? { blobId: c.avatarBlobId } : {}),
    label: `${c.data.name}的封面`,
    characterId: c.id,
    description: c.data.description,
  })),
)
const coverDefault = computed(() => coverCandidates.value.filter((c) => c.blobId).map((c) => c.id))
function openCover() {
  if (!memberChars.value.length) {
    toast.info('请先在「成员」里添加角色，再生成演绎封面')
    return
  }
  coverOpen.value = true
}
/** 关系图谱文本，写进封面提示词：站位与神态要体现关系 */
const relationsText = computed(() => {
  const m = model.value
  if (!m?.relations.length) return ''
  const nameOf = new Map<string, string>([[USER_NODE_ID, effectivePersona.value.name]])
  for (const c of memberChars.value) nameOf.set(c.id, c.data.name)
  return renderRelations({
    relations: m.relations,
    nameOf,
    template: m.relationTemplate || DEFAULT_RELATION_TEMPLATE,
  })
})
function coverPrompt(refs: ImageRefCandidate[]) {
  return groupCoverPrompt({ name: model.value?.name ?? '', refs, relations: relationsText.value })
}
async function coverPromptGen(signal: AbortSignal, refs: ImageRefCandidate[]) {
  const p = settings.settings.provider
  const apiKey = await settings.getApiKey(p.secretRef)
  return groupCoverPromptViaLLM({
    name: model.value?.name ?? '',
    refs,
    relations: relationsText.value,
    provider: p,
    apiKey,
    signal,
  })
}
async function applyCover(image: GeneratedImage) {
  await replaceCover(image.blob)
  toast.success('演绎封面已更换')
}

function addMember(id: string) {
  const m = model.value
  if (!m || m.members.includes(id)) return
  m.members.push(id)
  void save()
}
function removeMember(id: string) {
  const m = model.value
  if (!m) return
  m.members = m.members.filter((x) => x !== id)
  m.disabled_members = m.disabled_members.filter((x) => x !== id)
  // 成员移除时同时清掉它的关系边与坐标，否则图谱会渲染悬空节点
  m.relations = m.relations.filter((r) => r.from !== id && r.to !== id)
  delete m.layout[id]
  void save()
}
function toggleMute(id: string) {
  const m = model.value
  if (!m) return
  const i = m.disabled_members.indexOf(id)
  if (i >= 0) m.disabled_members.splice(i, 1)
  else m.disabled_members.push(id)
  void save()
}
function move(id: string, dir: -1 | 1) {
  const m = model.value
  if (!m) return
  const i = m.members.indexOf(id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= m.members.length) return
  const a = m.members[i]
  const b = m.members[j]
  if (a === undefined || b === undefined) return
  m.members[i] = b
  m.members[j] = a
  void save()
}

function addRelation(from?: string, to?: string) {
  const m = model.value
  // 节点集合含「我」，所以 1 个成员就够凑出一条边
  if (!m || relationNodes.value.length < 2) return
  // 默认取「我 → 第一个成员」：沉浸式演绎里用户最想先定的就是自己跟谁什么关系
  const f = from ?? relationNodes.value[0]?.id
  const t = to ?? relationNodes.value[1]?.id
  if (!f || !t) return
  const r: GroupRelation = { id: crypto.randomUUID(), from: f, to: t, label: '' }
  m.relations.push(r)
  // ⚠️ 必须落盘。model 是 toPlain() 出来的**编辑草稿**，不是 store 里的对象 ——
  // 只 push 不 save 的话，画布上确实会多一条边、编辑框也会弹出，
  // 但一离开本页草稿就没了，用户体感就是「按钮点了没用」。
  // 同目录的 removeRelation / addMember / toggleMove 都有 save()，唯独这里漏了。
  void save()
}
/** 画布拖完节点后回传坐标 */
function onLayout(layout: Group['layout']) {
  const m = model.value
  if (!m) return
  m.layout = layout
  void save()
}
function removeRelation(id: string) {
  const m = model.value
  if (!m) return
  m.relations = m.relations.filter((r) => r.id !== id)
  void save()
}
function swapDirection(r: GroupRelation) {
  const from = r.from
  r.from = r.to
  r.to = from
  void save()
}

async function startChat() {
  const m = model.value
  if (!m) return
  if (m.members.length < 2) {
    toast.error('至少需要 2 个成员')
    return
  }
  await save()
  const meta = await chats.createGroup(m.id, m.name)
  await router.push(`/chat/${meta.id}`)
}

async function removeGroup() {
  const m = model.value
  if (!m) return
  if (!(await confirmDialog({ text: `确定删除演绎「${m.name}」？其全部对话也会一并删除。` })))
    return
  await groups.remove(m.id)
  toast.success('已删除')
  await router.push('/groups')
}
</script>

<template>
  <AppTopbar :title="model?.name || '演绎'">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="router.push('/groups')">返回</button>
      <button class="cbx-btn cbx-btn--soft" @click="startChat">开始演绎</button>
      <button class="cbx-btn cbx-btn--primary" @click="save">保存</button>
    </template>
  </AppTopbar>

  <div v-if="model" class="cbx-scroll body">
    <div class="cbx-form-col">
      <label class="cbx-field cbx-field--md">
        <span class="cbx-field__label">演绎名</span>
        <input v-model="model.name" class="cbx-input" @change="save" />
      </label>

      <!-- 演绎封面：横版 3:2，可上传 / 用成员封面作参考图生成，支持深度视差 -->
      <section class="gcover" aria-label="演绎封面">
        <div
          ref="coverFrame"
          class="gcover__frame"
          :class="{ 'gcover__frame--zoomable': !!model.avatarBlobId }"
          :role="model.avatarBlobId ? 'button' : undefined"
          :tabindex="model.avatarBlobId ? 0 : undefined"
          :aria-label="model.avatarBlobId ? '预览演绎封面' : undefined"
          @pointerenter="onCoverEnter"
          @pointermove="onCoverMove"
          @pointerleave="onCoverLeave"
          @click="previewCover"
          @keydown.enter="previewCover"
        >
          <CbxAvatar
            v-if="model.avatarBlobId"
            class="gcover__img"
            :blob-id="model.avatarBlobId"
            :name="model.name"
          />
          <div v-else class="gcover__empty">
            <div class="gcover__faces">
              <CbxAvatar
                v-for="c in memberChars.slice(0, 5)"
                :key="c.id"
                :blob-id="c.avatarBlobId"
                :name="c.data.name"
                size="lg"
              />
            </div>
            <span>还没有演绎封面</span>
          </div>
          <button
            v-if="tiltNeedsGrant && parallax.eligible(model.avatarBlobId, model.depthBlobId)"
            type="button"
            class="cbx-chip gcover__tilt"
            @click.stop="enableTilt"
          >
            开启重力视差
          </button>
        </div>
        <div class="gcover__ops">
          <button
            type="button"
            class="cbx-btn cbx-btn--ghost"
            :disabled="depthBusy || coverBusy"
            @click="coverInput?.click()"
          >
            {{ model.avatarBlobId ? '更换图片' : '上传图片' }}
          </button>
          <input ref="coverInput" type="file" accept="image/*" hidden @change="onCoverFile" />
          <button
            type="button"
            class="cbx-btn cbx-btn--soft"
            :disabled="depthBusy || coverBusy"
            @click="openCover"
          >
            <ImagePlus :size="16" />生成封面
          </button>
          <!-- 深度图状态。只有启用了深度模型才出现 -->
          <div v-if="settings.settings.depth.modelId && model.avatarBlobId" class="gcover__depth">
            <span v-if="depthBusy" class="gcover__state">
              正在生成深度图…{{ depthPct ? ` ${depthPct}%` : '' }}
            </span>
            <template v-else-if="model.depthBlobId">
              <span class="gcover__state gcover__state--ok"
                ><AppIcon name="Check" /> 已有深度图 ·
                {{ parallaxMode === 'tilt' ? '倾斜可视差' : '悬停可视差' }}</span
              >
              <button type="button" class="cbx-btn cbx-btn--ghost gcover__tiny" @click="regenDepth">
                重新生成
              </button>
            </template>
            <template v-else>
              <span class="gcover__state">这张图还没有深度图</span>
              <button type="button" class="cbx-btn cbx-btn--soft gcover__tiny" @click="regenDepth">
                生成深度图
              </button>
            </template>
          </div>
        </div>
      </section>

      <div class="cbx-tabs">
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'members' }"
          @click="tab = 'members'"
        >
          成员
          <span v-if="model.members.length" class="cbx-badge cbx-badge--brand">{{
            model.members.length
          }}</span>
        </button>
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'relations' }"
          @click="tab = 'relations'"
        >
          关系图谱
          <span v-if="model.relations.length" class="cbx-badge cbx-badge--brand">{{
            model.relations.length
          }}</span>
        </button>
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'strategy' }"
          @click="tab = 'strategy'"
        >
          发言策略
        </button>
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'status' }"
          @click="tab = 'status'"
        >
          状态
        </button>
        <button
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === 'flow' }"
          @click="tab = 'flow'"
        >
          流程
        </button>
      </div>

      <!-- 成员 -->
      <section v-show="tab === 'members'" class="pane">
        <!-- 「我」也是这场戏里的一个参与者，所以放在成员列表最上面而不是塞进设置页：
             全局人设是跨所有对话的默认值，这里配的是**只在这个演绎里**的身份 -->
        <div class="me">
          <div class="me__head">
            <span class="me__icon"><AppIcon name="UserRound" /></span>
            <span class="cbx-field__label">我扮演的角色</span>
            <span v-if="!model.persona.name && !model.persona.description" class="cbx-badge">
              沿用全局人设
            </span>
          </div>
          <p class="cbx-field__hint">
            只作用于本演绎。留空则沿用设置里的全局人设（当前为「{{
              settings.settings.persona.name
            }}」）。这里填的名字就是提示词里的
            {{ USER_MACRO }}，也会作为关系图谱里「我」这个节点的名字。
          </p>
          <input
            v-model="model.persona.name"
            class="cbx-input"
            :placeholder="settings.settings.persona.name || '我'"
            @change="save"
          />
          <textarea
            v-model="model.persona.description"
            class="cbx-textarea me__desc"
            rows="3"
            :placeholder="
              settings.settings.persona.description ||
              '你在这个场景里是谁、什么身份、和大家什么渊源'
            "
            @change="save"
          />
        </div>

        <div class="cbx-divider" />

        <div v-if="!memberChars.length" class="cbx-empty">
          <span class="cbx-empty__desc">还没有成员，从下面添加</span>
        </div>
        <div v-for="(c, i) in memberChars" :key="c.id" class="member">
          <CbxAvatar :blob-id="c.avatarBlobId" :name="c.data.name" size="sm" previewable />
          <span class="member__name" :class="{ muted: model.disabled_members.includes(c.id) }">
            {{ c.data.name }}
          </span>
          <span v-if="model.disabled_members.includes(c.id)" class="cbx-badge cbx-badge--warning">
            静音
          </span>
          <div class="member__ops">
            <button
              class="cbx-icon-btn tiny"
              title="上移"
              :disabled="i === 0"
              @click="move(c.id, -1)"
            >
              <AppIcon name="ArrowUp" />
            </button>
            <button
              class="cbx-icon-btn tiny"
              title="下移"
              :disabled="i === memberChars.length - 1"
              @click="move(c.id, 1)"
            >
              <AppIcon name="ArrowDown" />
            </button>
            <button
              class="cbx-icon-btn tiny"
              :title="model.disabled_members.includes(c.id) ? '取消静音' : '静音'"
              :aria-pressed="model.disabled_members.includes(c.id)"
              @click="toggleMute(c.id)"
            >
              <span class="icon-swap"
                ><Transition name="icon-swap"
                  ><AppIcon
                    :key="String(model.disabled_members.includes(c.id))"
                    :name="model.disabled_members.includes(c.id) ? 'VolumeX' : 'Volume2'"
                    :size="16" /></Transition
              ></span>
            </button>
            <button class="cbx-icon-btn tiny" title="移除" @click="removeMember(c.id)">
              <AppIcon name="X" tone="danger" />
            </button>
          </div>
        </div>

        <div class="cbx-divider" />
        <div class="cbx-field__label">添加成员</div>
        <div v-if="!candidates.length" class="cbx-field__hint">没有可添加的角色了</div>
        <div class="chips">
          <button v-for="c in candidates" :key="c.id" class="cbx-chip" @click="addMember(c.id)">
            <AppIcon name="Plus" /> {{ c.data.name }}
          </button>
        </div>
      </section>

      <!-- 关系图谱 -->
      <section v-show="tab === 'relations'" class="pane">
        <p class="tip">
          关系是<strong>有向</strong>的：「A 对 B」与「B 对 A」是两条独立的关系，可以完全不同 （比如
          A 暗恋 B，而 B 只把 A 当妹妹）。这些关系会拼进 1vN 的约束提示词。
        </p>

        <!-- 「添加关系」与视图切换同排、放在内容**上方**：
             原来它在画布/列表之后，420px 的画布把它顶到屏幕外，
             用户经常找不到，看起来就像没有这个功能 -->
        <div class="relbar">
          <div class="cbx-seg viewseg">
            <button
              class="cbx-seg__btn"
              :class="{ 'cbx-seg__btn--active': relView === 'list' }"
              @click="relView = 'list'"
            >
              列表
            </button>
            <button
              class="cbx-seg__btn"
              :class="{ 'cbx-seg__btn--active': relView === 'graph' }"
              @click="relView = 'graph'"
            >
              画布
            </button>
          </div>
          <!-- 画布视图不放这个按钮：在画布上从节点的 ＋ 拉一条线到另一个节点
               就是添加关系，再摆个按钮反而多余。
               列表视图没有连线这个动作，必须保留，否则列表用户根本没法新增。 -->
          <button
            v-if="relView === 'list' && relationNodes.length >= 2"
            class="cbx-btn cbx-btn--soft"
            @click="addRelation()"
          >
            <AppIcon name="Plus" /> 添加关系
          </button>
        </div>

        <!-- 门槛按**节点数**算而不是成员数：加进「我」之后，1 个角色就能配
             「我 对 她：师徒」，不必等到凑够两个角色 -->
        <div v-if="relationNodes.length < 2" class="cbx-empty">
          <span class="cbx-empty__desc">至少添加 1 个成员才能配置关系</span>
        </div>

        <template v-else>
          <RelationGraph
            v-if="relView === 'graph'"
            :members="relationNodes"
            :relations="model.relations"
            :layout="model.layout"
            @update:layout="onLayout"
            @create-relation="addRelation"
            @change="save"
            @remove-relation="removeRelation"
            @swap-relation="swapDirection"
          />

          <div v-else class="rel-list">
            <div v-if="!model.relations.length" class="cbx-empty">
              <span class="cbx-empty__desc">还没有关系</span>
            </div>
            <div v-for="r in model.relations" :key="r.id" class="rel">
              <CbxSelect
                v-model="r.from"
                :options="relationOptions"
                label="关系起点"
                compact
                @change="save"
              />
              <button class="cbx-icon-btn tiny" title="交换方向" @click="swapDirection(r)">
                <AppIcon name="ArrowLeftRight" />
              </button>
              <CbxSelect
                v-model="r.to"
                :options="relationOptions"
                label="关系终点"
                compact
                @change="save"
              />
              <input
                v-model="r.label"
                class="cbx-input rel__label"
                placeholder="关系，如：青梅竹马"
                @change="save"
              />
              <button class="cbx-icon-btn tiny" title="删除" @click="removeRelation(r.id)">
                <AppIcon name="X" tone="danger" />
              </button>
            </div>
          </div>
        </template>
      </section>

      <!-- 发言策略 -->
      <section v-show="tab === 'strategy'" class="pane">
        <div class="cbx-field__label">谁来发言</div>
        <label v-for="s in STRATEGIES" :key="s.v" class="opt">
          <input
            v-model.number="model.activation_strategy"
            type="radio"
            :value="s.v"
            @change="save"
          />
          <span>
            <strong>{{ s.label }}</strong>
            <em>{{ s.desc }}</em>
          </span>
        </label>

        <div class="cbx-divider" />
        <div class="cbx-field__label">角色卡怎么给模型</div>
        <label v-for="m in MODES" :key="m.v" class="opt">
          <input v-model.number="model.generation_mode" type="radio" :value="m.v" @change="save" />
          <span>
            <strong>{{ m.label }}</strong>
            <em>{{ m.desc }}</em>
          </span>
        </label>

        <div class="cbx-divider" />
        <label class="opt">
          <input v-model="model.allow_self_responses" type="checkbox" @change="save" />
          <span><strong>允许连续发言</strong><em>同一角色可以连着说两次</em></span>
        </label>
        <label class="opt">
          <input v-model="model.mergeMemberBooks" type="checkbox" :disabled="!!model.worldBookId" @change="save" />
          <span>
            <strong>合并成员世界书</strong>
            <em>默认只用当前发言者的世界书（同 SillyTavern）；勾选后取全体并集</em>
          </span>
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">主世界书</span>
          <CbxSelect v-model="selectedWorldBook" :options="worldBookOptions" label="主世界书" @change="save" />
        </label>
        <div class="danger">
          <button class="cbx-btn cbx-btn--ghost del" @click="removeGroup">删除演绎</button>
        </div>
      </section>

      <!-- 角色状态 -->
      <section v-show="tab === 'status'" class="pane">
        <p class="note">
          演绎里 AI
          每轮会输出一份状态：场景一份，每个成员和你各一份（漏写的人沿用上一份），在聊天页右上角「状态」里查看。这里设置本演绎的专属字段与开场时的初始状态。
        </p>
        <p v-if="!memberChars.length" class="note">先在「成员」里添加角色。</p>
        <StatusConfigEditor
          v-else
          :config="model.status"
          :people="statusPeople"
          :user-name="effectivePersona.name"
          own-label="使用本演绎专属的状态字段"
          @update:config="setStatusConfig"
        >
          <template #initial-hint>
            会话还没有任何状态时，第一轮就以它为准。某个成员这里留空时，沿用他角色卡「状态」页签里填的本人初始状态。
          </template>
        </StatusConfigEditor>
      </section>

      <section v-show="tab === 'flow'" class="pane">
        <p class="note">
          每条 AI 回复后检查。这里的规则里
          {{ CHAR_MACRO }} 指本轮发言者；成员角色卡「流程」页签里的规则也会一起运行（{{
            CHAR_MACRO
          }}
          指那位成员本人）。
        </p>
        <FlowEditor
          :config="model.flow"
          :fields="flowFields"
          :people="memberChars.map((c) => c.data.name)"
          is-group
          @update:config="setFlowConfig"
        />
        <details v-if="memberChars.length" class="flow-sim">
          <summary>模拟器：不聊天也能试规则（以第一位成员为本轮发言者，只跑本演绎的规则）</summary>
          <FlowSimulator
            :config="model.flow"
            :fields="flowFields"
            :char-name="memberChars[0]!.data.name"
            :user-name="effectivePersona.name"
          />
        </details>
      </section>
    </div>
  </div>

  <ImageGenerationDialog
    v-if="model && coverOpen"
    title="生成演绎封面"
    :candidates="coverCandidates"
    :default-selected="coverDefault"
    require-references
    :build-prompt="coverPrompt"
    :generate-prompt="coverPromptGen"
    :size="COVER_SIZE"
    apply-label="设为演绎封面"
    :apply="applyCover"
    @close="coverOpen = false"
  />
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
/* 与设置页统一：模板里 class="wrap" → class="cbx-form-col"，本规则整条删除。
   「演绎名」原本是全项目最宽的短字段（满 820px），标 --md 后收到 400px。 */
.gcover {
  display: flex;
  gap: var(--cbx-space-4);
  align-items: flex-start;
  margin-bottom: var(--cbx-space-4);
}
.gcover__frame {
  position: relative;
  flex: 0 0 min(100%, 420px);
  aspect-ratio: 3 / 2;
  overflow: hidden;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  background: var(--cbx-bg-secondary);
}
.gcover__frame--zoomable {
  cursor: zoom-in;
}
.gcover__frame--zoomable:focus-visible {
  outline: 2px solid var(--cbx-border-focus);
  outline-offset: 2px;
}
.gcover__img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 0;
  object-fit: cover;
}
.gcover__empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--cbx-space-3);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-tertiary);
}
.gcover__faces {
  display: flex;
}
.gcover__faces > * + * {
  margin-left: -12px;
}
.gcover__faces > * {
  box-shadow: 0 0 0 3px var(--cbx-bg-secondary);
}
.gcover__tilt {
  position: absolute;
  left: 50%;
  bottom: var(--cbx-space-3);
  z-index: 1;
  transform: translateX(-50%);
  white-space: nowrap;
  box-shadow: var(--cbx-shadow-md);
}
.gcover__ops {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  min-width: 160px;
}
.gcover__ops > .cbx-btn {
  gap: var(--cbx-space-1);
}
.gcover__depth {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-1);
  margin-top: var(--cbx-space-1);
}
.gcover__state {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
}
.gcover__state--ok {
  color: var(--cbx-success);
}
.gcover__tiny {
  height: 28px;
  padding: 0 var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
}
@media (max-width: 767px) {
  .gcover {
    flex-direction: column;
    align-items: stretch;
  }
  .gcover__frame {
    flex-basis: auto;
    width: 100%;
  }
  .gcover__ops {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .gcover__ops > .cbx-btn {
    flex: 1;
    min-height: var(--cbx-tap-min);
  }
  .gcover__depth {
    flex-basis: 100%;
  }
  .gcover__tiny {
    height: var(--cbx-tap-min);
  }
}
.note {
  max-width: var(--cbx-read-w);
  margin-bottom: var(--cbx-space-4);
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.7;
}
.pane {
  padding-top: var(--cbx-space-5);
}
.tip {
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  line-height: 1.6;
  margin-bottom: var(--cbx-space-4);
}
.member {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-2);
  border-radius: var(--cbx-radius-md);
}
.member:hover {
  background: var(--cbx-bg-hover);
}
.member__name {
  flex: 1;
  font-size: var(--cbx-fs-sm);
}
.member__name.muted {
  color: var(--cbx-text-tertiary);
  text-decoration: line-through;
}
.member__ops {
  display: flex;
  gap: 2px;
}
.tiny {
  width: 28px;
  height: 28px;
  font-size: var(--cbx-fs-xs);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
/* 视图切换 + 添加关系 同排，贴在内容上方 */
.relbar {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  flex-wrap: wrap;
  margin-bottom: var(--cbx-space-3);
}
.relbar .cbx-btn {
  margin-left: auto;
}
.viewseg {
  margin-bottom: 0;
}
.rel {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-2);
}
.rel__who {
  /* 加进「我」之后选项里会出现「名字（我）」，110px 装不下，放宽一档 */
  width: 132px;
  flex-shrink: 0;
}
.rel__label {
  flex: 1;
}

.me {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.me__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.me__icon {
  font-size: var(--cbx-fs-lg);
}
.me__desc {
  resize: vertical;
}
.mt {
  margin-top: var(--cbx-space-3);
}
.sm {
  height: 30px;
  padding: 0 var(--cbx-space-3);
  font-size: var(--cbx-fs-xs);
}
.opt {
  display: flex;
  align-items: flex-start;
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-2) 0;
  cursor: pointer;
}
.opt strong {
  display: block;
  font-size: var(--cbx-fs-sm);
  font-weight: var(--cbx-fw-medium);
}
.opt em {
  display: block;
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  font-style: normal;
}
.danger {
  margin-top: var(--cbx-space-6);
  padding-top: var(--cbx-space-4);
  border-top: 1px solid var(--cbx-border);
}
.del {
  color: var(--cbx-error);
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .rel {
    flex-wrap: wrap;
  }
  .rel__who {
    width: calc(50% - 20px);
  }
  .rel__label {
    width: 100%;
    flex: none;
  }
  .tiny {
    width: var(--cbx-tap-min);
    height: var(--cbx-tap-min);
  }
}
.flow-sim {
  margin-top: var(--cbx-space-4);
  padding-top: var(--cbx-space-3);
  border-top: 1px solid var(--cbx-border);
}
.flow-sim > summary {
  margin-bottom: var(--cbx-space-3);
  font-size: var(--cbx-fs-sm);
  cursor: pointer;
}
</style>
