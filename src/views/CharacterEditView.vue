<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ImagePlus, Sparkles, Undo2 } from '@/components/icons'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import CbxAvatar from '@/components/ui/CbxAvatar.vue'
import GreetingsEditor from '@/components/character/GreetingsEditor.vue'
import ExampleDialogueEditor from '@/components/character/ExampleDialogueEditor.vue'
import AiCharacterDialog from '@/components/character/AiCharacterDialog.vue'
import ImageGenerationDialog from '@/components/image/ImageGenerationDialog.vue'
import { characterImagePrompt } from '@/services/image/prompts'
import type { GeneratedImage } from '@/types/image'
import type { GeneratedCharacterData } from '@/services/character/generate'
import { useCharactersStore } from '@/stores/characters'
import { useChatsStore } from '@/stores/chats'
import { useWorldsStore } from '@/stores/worlds'
import { useToast } from '@/composables/useToast'
import { blobsRepo } from '@/db/repositories'
import { invalidateObjectUrl } from '@/composables/useObjectUrl'
import { useViewTransition } from '@/composables/useViewTransition'
import { useMorphTarget } from '@/composables/useMorphTarget'
import { useSettingsStore } from '@/stores/settings'
import { generateDepth } from '@/services/depth/generate'
import { attach, detach, move } from '@/services/depth/parallax'
import { exportCharacterJson } from '@/services/io/characterCard'
import { exportCharacterPng } from '@/services/io/characterPng'
import { downloadBlob, safeFileName } from '@/utils/download'
import { MORPH_VT_NAME } from '@/constants/app'
import { toPlain } from '@/utils/plain'
import { DEPTH_PROMPT_DEPTH_DEFAULT, type Character } from '@/types/character'
import { confirmDialog } from '@/composables/useConfirm'

const route = useRoute()
const router = useRouter()
const chars = useCharactersStore()
const chats = useChatsStore()
const worlds = useWorldsStore()
const toast = useToast()

/** 模板里要显示字面的宏，不能直接写 —— Vue 会在内层 }} 提前闭合插值 */
const CHAR_MACRO = '{{char}}'
const ORIGINAL_MACRO = '{{original}}'

const settings = useSettingsStore()
const depthBusy = ref(false)
const depthPct = ref(0)

const model = ref<Character | null>(null)
const tab = ref<'basic' | 'greetings' | 'examples' | 'advanced'>('basic')
const avatarInput = ref<HTMLInputElement | null>(null)
const saving = ref(false)
/** PNG 导出要转码 + 编码，可能几百毫秒；连点会并发跑两遍、下两个文件、内存峰值翻倍 */
const exporting = ref(false)
const aiOpen = ref(false)
const coverOpen = ref(false)
const coverPrompt = ref('')
const avatarBusy = ref(false)
const aiDescription = ref('')
const beforeAiFill = ref<GeneratedCharacterData | null>(null)
const hasCharacterContent = computed(() => {
  const data = model.value?.data
  return (
    !!data &&
    !!(
      (data.name.trim() && data.name !== '新角色') ||
      data.description.trim() ||
      data.personality.trim() ||
      data.scenario.trim() ||
      data.first_mes.trim() ||
      data.mes_example.trim() ||
      data.alternate_greetings.some((item) => item.trim())
    )
  )
})
let dirty = false

function openCover() {
  if (!model.value?.data.description.trim()) {
    toast.info('请先填写角色简介，再生成封面')
    return
  }
  coverPrompt.value = characterImagePrompt(model.value.data)
  coverOpen.value = true
}

async function applyCover(image: GeneratedImage) {
  await replaceAvatar(image.blob)
}

function applyAiCharacter(data: GeneratedCharacterData) {
  if (!model.value) return
  const { name, description, personality, scenario, first_mes, alternate_greetings, mes_example } =
    model.value.data
  beforeAiFill.value = toPlain({
    name,
    description,
    personality,
    scenario,
    first_mes,
    alternate_greetings,
    mes_example,
  })
  Object.assign(model.value.data, data)
  tab.value = 'basic'
  aiOpen.value = false
  toast.success('已填入角色资料，请检查后保存')
}

function undoAiFill() {
  if (!model.value || !beforeAiFill.value) return
  Object.assign(model.value.data, toPlain(beforeAiFill.value))
  beforeAiFill.value = null
  toast.success('已撤销 AI 填入')
}

const TABS = [
  { key: 'basic', label: '基本' },
  { key: 'greetings', label: '开场白' },
  { key: 'examples', label: '对话示例' },
  { key: 'advanced', label: '高级' },
] as const

/**
 * 立绘视差（与列表页同一套实现）。
 *
 * 同样的三道闸：只在能 hover 的精确指针设备上、用户没要求减少动效、
 * 且这张图真的有深度图时才挂 —— 触屏没有 hover，移动端连 three.js 都不会下载。
 */
const parallaxAllowed =
  typeof window !== 'undefined' &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches

let parallaxHost: HTMLElement | null = null
let hoverRect: DOMRect | null = null
let liveUrls: string[] = []

async function onAvatarEnter(e: PointerEvent) {
  const m = model.value
  if (!parallaxAllowed || !m || !settings.settings.depth.modelId) return
  // depthBusy 期间深度图正在重算，此刻挂上去用的是旧图，放完还得再摘
  if (depthBusy.value || !m.avatarBlobId || !m.depthBlobId) return
  const el = e.currentTarget as HTMLElement
  hoverRect = el.getBoundingClientRect()
  parallaxHost = el
  const [color, depth] = await Promise.all([
    blobsRepo.get(m.avatarBlobId),
    blobsRepo.get(m.depthBlobId),
  ])
  if (!color || !depth || parallaxHost !== el) return
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

function onAvatarMove(e: PointerEvent) {
  if (!parallaxHost || !hoverRect) return
  const nx = ((e.clientX - hoverRect.left) / hoverRect.width) * 2 - 1
  const ny = ((e.clientY - hoverRect.top) / hoverRect.height) * 2 - 1
  move(nx, ny)
}

function releaseParallax() {
  if (!parallaxHost) return
  detach()
  parallaxHost = null
  hoverRect = null
  for (const u of liveUrls) URL.revokeObjectURL(u)
  liveUrls = []
}

// 离开本页时 canvas 是全局单例、会被下一个宿主接着用，但 objectURL 是本页造的，
// 不收回就是纯泄漏
onBeforeUnmount(releaseParallax)

const title = computed(() => model.value?.data.name || '编辑角色')
const greetingCount = computed(() => {
  const m = model.value
  if (!m) return 0
  return [m.data.first_mes, ...m.data.alternate_greetings].filter((g) => g && g.trim()).length
})

onMounted(async () => {
  if (!chars.loaded) await chars.load()
  if (!worlds.loaded) await worlds.load()
  const id = route.params['id']
  const cid = Array.isArray(id) ? id[0] : id
  const found = cid ? chars.byId(cid) : undefined
  if (!found) {
    toast.error('角色不存在')
    await router.push('/characters')
    return
  }
  // 深拷贝一份编辑草稿，避免未保存的改动直接污染列表。
  // 必须用 toPlain 而非 structuredClone —— found 是 Vue reactive 代理，克隆会抛异常。
  const draft = toPlain(found)
  // 导入的卡片可能没有 depth_prompt，补齐后模板才能安全双向绑定
  draft.data.extensions.depth_prompt ??= {
    prompt: '',
    depth: DEPTH_PROMPT_DEPTH_DEFAULT,
    role: 'system',
  }
  model.value = draft
})

watch(
  model,
  () => {
    dirty = true
  },
  { deep: true },
)

async function save() {
  if (!model.value) return
  saving.value = true
  try {
    await chars.save(model.value)
    dirty = false
    toast.success('已保存')
  } finally {
    saving.value = false
  }
}

async function onAvatar(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (!f) return
  try {
    await replaceAvatar(f)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error))
  } finally {
    ;(e.target as HTMLInputElement).value = ''
  }
}

async function replaceAvatar(source: Blob) {
  const m = model.value
  if (!m || avatarBusy.value || depthBusy.value) throw new Error('图片正在保存，请稍后重试')
  avatarBusy.value = true
  const old = m.avatarBlobId
  const oldDepth = m.depthBlobId
  let id: string | undefined
  try {
    id = await blobsRepo.put(source)
    releaseParallax()
    m.avatarBlobId = id
    m.depthBlobId = undefined
    try {
      await save()
    } catch (error) {
      m.avatarBlobId = old
      m.depthBlobId = oldDepth
      await blobsRepo.remove(id)
      throw error
    }
    // 先保存新引用；旧图片留给引用清理，避免破坏共享该封面的其他角色。
    if (old) invalidateObjectUrl(old)
    if (oldDepth) invalidateObjectUrl(oldDepth)
    await makeDepth(source)
  } finally {
    avatarBusy.value = false
  }
}

/**
 * 生成并保存深度图。模型没启用就直接跳过 —— 这是「勾选启用才生成」的执行点。
 *
 * 任何失败都只弹一条提示，不抛、不回滚：立绘已经换好了，视差有没有是另一回事。
 */
async function makeDepth(source: Blob) {
  const m = model.value
  const modelId = settings.settings.depth.modelId
  if (!m || !modelId) return
  depthBusy.value = true
  depthPct.value = 0
  try {
    const { promise } = generateDepth(source, modelId, (loaded, total) => {
      if (total) depthPct.value = Math.round((loaded / total) * 100)
    })
    const res = await promise
    const blobId = await blobsRepo.put(res.blob)
    m.depthBlobId = blobId
    await save()
    toast.success(`深度图已生成（${res.width}×${res.height}，${(res.ms / 1000).toFixed(1)} 秒）`)
  } catch (err) {
    toast.error(`深度图生成失败：${err instanceof Error ? err.message : String(err)}`)
  } finally {
    depthBusy.value = false
  }
}

/** 给已有立绘补生成。上传时会自动跑，这个按钮是给「先有图、后启用模型」的情况兜底 */
async function regenDepth() {
  const m = model.value
  if (!m?.avatarBlobId || depthBusy.value) return
  const blob = await blobsRepo.get(m.avatarBlobId)
  if (!blob) return
  const oldDepth = m.depthBlobId
  await makeDepth(blob)
  if (oldDepth && m.depthBlobId !== oldDepth) {
    invalidateObjectUrl(oldDepth)
    await blobsRepo.remove(oldDepth)
  }
}

async function startChat() {
  if (!model.value) return
  if (dirty) await save()
  const meta = await chats.createSolo(model.value.id, model.value.data.name)
  await router.push(`/chat/${meta.id}`)
}

async function exportJson() {
  const m = model.value
  if (!m) return
  const at = await downloadBlob(await exportCharacterJson(m), safeFileName(m.data.name, 'json'))
  if (at) toast.success(`已导出到 ${at}`)
}

async function exportPng() {
  const m = model.value
  if (!m || exporting.value) return
  exporting.value = true
  try {
    // 导出的是库里的角色，未保存的改动不会进卡里 —— 先落盘再导
    if (dirty) await save()
    const { blob, notice } = await exportCharacterPng(m)
    const at = await downloadBlob(blob, safeFileName(m.data.name, 'png'))
    if (at) toast.success(`已导出到 ${at}`)
    if (notice) toast.warning(notice)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    exporting.value = false
  }
}

function toggleBook(id: string) {
  const m = model.value
  if (!m) return
  const i = m.worldBookIds.indexOf(id)
  if (i >= 0) m.worldBookIds.splice(i, 1)
  else m.worldBookIds.push(id)
}

const vt = useViewTransition()
const morph = useMorphTarget()
/** 过渡进行中不接受第二次点击：并发两次过渡会互相 skip，观感是「点了没动画」 */
let leaving = false

/**
 * 返回列表，带反向的共享元素过渡：本页的大立绘缩回它在列表里的那张卡。
 *
 * 本页立绘的 view-transition-name 是**无条件**挂着的，所以「旧状态」那端天然就绪；
 * 缺的只是「新状态」那端 —— 列表页得知道给哪张卡挂同名。morph.mark() 就是干这个。
 *
 * 不需要在这里等 nextTick：列表组件此刻被 KeepAlive 停用、DOM 是游离的，
 * 真正的新状态快照发生在 vt.run 内部 update + nextTick 之后，那时绑定早已生效。
 */
async function back() {
  // 与列表页点进来时同理：画框里此刻盖着视差 canvas，不摘掉的话 VT 拍到的
  // 「旧」端是 canvas、列表页那端是 <img>，两端对不上，morph 会变成怪异形变
  releaseParallax()
  const id = model.value?.id
  const go = () => router.push('/characters')
  if (leaving) return
  if (!vt.supported || !id) {
    await go()
    return
  }
  leaving = true
  morph.mark(id)
  try {
    await vt.run(go)
  } finally {
    // 必须清。留着会让下一次无关导航也给那张卡挂上名字，
    // 同名撞车时整个过渡被静默 skip，表现为「动画时灵时不灵」
    morph.clear()
    leaving = false
  }
}

async function remove() {
  if (!model.value) return
  if (
    !(await confirmDialog({
      text: `确定删除角色「${model.value.data.name}」？其全部对话也会一并删除。`,
    }))
  )
    return
  await chars.remove(model.value.id)
  toast.success('已删除')
  await router.push('/characters')
}
</script>

<template>
  <AppTopbar :title="title">
    <template #actions>
      <button class="cbx-btn cbx-btn--ghost" @click="back">返回</button>
      <button class="cbx-btn cbx-btn--soft" @click="startChat">开始聊天</button>
      <button class="cbx-btn cbx-btn--primary" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </AppTopbar>

  <div v-if="model" class="cbx-scroll body">
    <div class="cbx-form-col">
      <div class="ai-entry">
        <button class="cbx-btn cbx-btn--soft" :disabled="saving" @click="aiOpen = true">
          <Sparkles :size="16" />AI 创建角色
        </button>
        <button
          v-if="beforeAiFill"
          class="cbx-btn cbx-btn--ghost"
          :disabled="saving"
          @click="undoAiFill"
        >
          <Undo2 :size="16" />撤销 AI 填入
        </button>
      </div>
      <div class="cbx-tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="cbx-tab"
          :class="{ 'cbx-tab--active': tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span
            v-if="t.key === 'greetings' && greetingCount > 1"
            class="cbx-badge cbx-badge--brand"
          >
            {{ greetingCount }}
          </span>
        </button>
      </div>

      <!-- 基本 -->
      <section v-show="tab === 'basic'" class="pane">
        <div class="head">
          <div class="avatar-col">
            <!-- 画框：与列表页的 .card__frame 同构（2:3 + 同圆角 + overflow:hidden），
                 视差 canvas 挂进它内部（absolute inset:0）。
                 view-transition-name 也挂在画框上，两端配对的才是同一个几何盒子。
                 这一侧是常驻的：本页同一时刻只可能有一个头像，不存在撞名。 -->
            <div
              class="frame"
              :style="{ viewTransitionName: MORPH_VT_NAME }"
              @pointerenter="onAvatarEnter"
              @pointermove="onAvatarMove"
              @pointerleave="releaseParallax"
            >
              <CbxAvatar
                class="frame__img"
                :blob-id="model.avatarBlobId"
                :name="model.data.name"
                card
              />
            </div>
            <button
              class="cbx-btn cbx-btn--ghost full"
              :disabled="depthBusy || avatarBusy"
              @click="avatarInput?.click()"
            >
              更换图片
            </button>
            <input ref="avatarInput" type="file" accept="image/*" hidden @change="onAvatar" />
            <button
              class="cbx-btn cbx-btn--soft full"
              :disabled="depthBusy || avatarBusy"
              @click="openCover"
            >
              <ImagePlus :size="16" />生成封面
            </button>

            <!-- 深度图状态。只有启用了深度模型才出现，没启用时这块完全不存在 -->
            <div v-if="settings.settings.depth.modelId && model.avatarBlobId" class="depth">
              <span v-if="depthBusy" class="depth__state">
                正在生成深度图…{{ depthPct ? ` ${depthPct}%` : '' }}
              </span>
              <template v-else-if="model.depthBlobId">
                <span class="depth__state depth__state--ok"
                  ><AppIcon name="Check" /> 已有深度图 · 卡片可视差</span
                >
                <button class="cbx-btn cbx-btn--ghost tiny" @click="regenDepth">重新生成</button>
              </template>
              <template v-else>
                <span class="depth__state">这张图还没有深度图</span>
                <button class="cbx-btn cbx-btn--soft tiny" @click="regenDepth">生成深度图</button>
              </template>
            </div>
          </div>
          <div class="fields">
            <label class="cbx-field cbx-field--md">
              <span class="cbx-field__label">角色名</span>
              <input v-model="model.data.name" class="cbx-input" placeholder="例：铃" />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">角色简介</span>
              <textarea
                v-model="model.data.description"
                class="cbx-textarea"
                rows="6"
                placeholder="外貌、身份、背景……这是最重要的字段，模型主要靠它理解角色。"
              />
            </label>
          </div>
        </div>

        <label class="cbx-field">
          <span class="cbx-field__label">性格</span>
          <textarea
            v-model="model.data.personality"
            class="cbx-textarea"
            rows="3"
            placeholder="例：沉默寡言，嘴硬心软，讨厌被人看穿。"
          />
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">场景</span>
          <textarea
            v-model="model.data.scenario"
            class="cbx-textarea"
            rows="3"
            placeholder="故事发生的时间、地点与处境。"
          />
        </label>
      </section>

      <!-- 开场白 -->
      <section v-show="tab === 'greetings'" class="pane">
        <GreetingsEditor
          :first-mes="model.data.first_mes"
          :alternates="model.data.alternate_greetings"
          @update:first-mes="model.data.first_mes = $event"
          @update:alternates="model.data.alternate_greetings = $event"
        />
      </section>

      <!-- 对话示例 -->
      <section v-show="tab === 'examples'" class="pane">
        <ExampleDialogueEditor v-model="model.data.mes_example" />
      </section>

      <!-- 高级 -->
      <section v-show="tab === 'advanced'" class="pane">
        <label class="cbx-field">
          <span class="cbx-field__label">角色专属主提示词（覆盖全局）</span>
          <textarea v-model="model.data.system_prompt" class="cbx-textarea" rows="3" />
          <span class="cbx-field__hint">
            留空 = 用设置里的全局主提示词。填了就<b>整块顶掉</b>它；想把全局那段接回来， 在这里写
            {{ ORIGINAL_MACRO }}（只认第一个）。
          </span>
        </label>

        <label class="cbx-field">
          <span class="cbx-field__label">后置指令（放在全部历史之后）</span>
          <textarea v-model="model.data.post_history_instructions" class="cbx-textarea" rows="3" />
        </label>

        <div class="grid2">
          <label class="cbx-field">
            <span class="cbx-field__label">
              发言意愿 {{ model.data.extensions.talkativeness }}
            </span>
            <input
              v-model.number="model.data.extensions.talkativeness"
              class="cbx-input"
              type="number"
              step="0.05"
              min="0"
              max="1"
            />
            <span class="cbx-field__hint">1vN「自然顺序」策略下的发言概率，0~1</span>
          </label>
          <label class="cbx-field cbx-field--sm">
            <span class="cbx-field__label">角色版本</span>
            <input v-model="model.data.character_version" class="cbx-input" />
          </label>
        </div>

        <div class="cbx-collapse">
          <div class="cbx-collapse__head">深度提示词（每轮插入到历史指定深度）</div>
          <div class="cbx-collapse__body">
            <textarea
              v-model="model.data.extensions.depth_prompt!.prompt"
              class="cbx-textarea"
              rows="3"
              :placeholder="`例：[记住：${CHAR_MACRO} 此刻正在发烧，说话有气无力。]`"
            />
            <div class="grid2 mt">
              <label class="cbx-field">
                <span class="cbx-field__label">深度</span>
                <input
                  v-model.number="model.data.extensions.depth_prompt!.depth"
                  class="cbx-input"
                  type="number"
                  min="0"
                  :placeholder="String(DEPTH_PROMPT_DEPTH_DEFAULT)"
                />
              </label>
              <label class="cbx-field">
                <span class="cbx-field__label">角色</span>
                <select v-model="model.data.extensions.depth_prompt!.role" class="cbx-input">
                  <option value="system">system</option>
                  <option value="user">user</option>
                  <option value="assistant">assistant</option>
                </select>
              </label>
            </div>
          </div>
        </div>

        <div class="cbx-field">
          <span class="cbx-field__label">角色世界书（需求 5：与角色关联）</span>
          <div v-if="!worlds.items.length" class="cbx-field__hint">
            还没有世界书，先到「世界书」页创建
          </div>
          <div class="chips">
            <button
              v-for="b in worlds.items"
              :key="b.id"
              class="cbx-chip"
              :class="{ 'cbx-chip--active': model.worldBookIds.includes(b.id) }"
              @click="toggleBook(b.id)"
            >
              {{ b.name }}
            </button>
          </div>
        </div>

        <label class="cbx-field">
          <span class="cbx-field__label">创作者备注（不发给模型）</span>
          <textarea v-model="model.data.creator_notes" class="cbx-textarea" rows="2" />
        </label>

        <div class="ops">
          <!-- PNG 在先：社区（SillyTavern / 各卡站）互相分享角色卡用的都是 PNG，
               JSON 主要用于自己排查或程序处理 -->
          <button class="cbx-btn cbx-btn--soft" :disabled="exporting" @click="exportPng">
            {{ exporting ? '导出中…' : '导出角色卡 PNG' }}
          </button>
          <button class="cbx-btn cbx-btn--ghost" :disabled="exporting" @click="exportJson">
            导出 JSON
          </button>
          <button class="cbx-btn cbx-btn--ghost del" @click="remove">删除角色</button>
        </div>
      </section>
    </div>
  </div>
  <AiCharacterDialog
    v-if="model && aiOpen"
    v-model="aiDescription"
    :has-content="hasCharacterContent"
    @close="aiOpen = false"
    @generated="applyAiCharacter"
  />
  <ImageGenerationDialog
    v-if="model && coverOpen"
    title="生成角色封面"
    :initial-prompt="coverPrompt"
    apply-label="设为角色封面"
    :apply="applyCover"
    @close="coverOpen = false"
  />
</template>

<style scoped>
.body {
  flex: 1;
  padding: var(--cbx-space-5);
}
.ai-entry {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
  margin-bottom: var(--cbx-space-4);
}
/* 与设置页统一：宽度/对齐/字段上限由 base.css 的 .cbx-form-col 提供
   （模板里 class="wrap" → class="cbx-form-col"，本规则整条删除）。
   本页 .pane 没有 .cbx-card 底色，820 的边界本来就不可见，
   左对齐 + 字段收窄后视觉锚点反而更清楚。 */
.pane {
  padding-top: var(--cbx-space-5);
}
.head {
  display: flex;
  gap: var(--cbx-space-5);
  margin-bottom: var(--cbx-space-4);
}
.avatar-col {
  width: 160px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
/* 与列表页 .card__frame 同构：几何稳定、负责裁切，视差 canvas 挂进它内部
   （absolute inset:0）。⚠️ 画框自身不能有 transform —— 它是 VT 的配对元素，
   几何必须和列表页那端一致 */
.frame {
  position: relative;
  overflow: hidden;
  border-radius: var(--cbx-radius-md);
  aspect-ratio: 2 / 3;
}
.frame__img {
  width: 100%;
  height: 100%;
  /* 画框已经负责圆角与裁切，图片再来一次只会在边缘露出锯齿 */
  border-radius: 0;
}
/* 同列表页：display:block 只给 <img>，不能压到没有立绘时那个 grid 居中的占位块 */
img.frame__img {
  display: block;
}
.full {
  width: 100%;
}
.depth {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--cbx-space-1);
  margin-top: var(--cbx-space-2);
}
.depth__state {
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-tertiary);
  text-align: center;
}
.depth__state--ok {
  color: var(--cbx-success);
}
.tiny {
  height: 28px;
  padding: 0 var(--cbx-space-2);
  font-size: var(--cbx-fs-xs);
}
.fields {
  flex: 1;
  min-width: 0;
}
.grid2 {
  display: grid;
  /* auto-fill 而非 auto-fit：auto-fit 会折叠空轨道，把 2 项的网格各拉到约 400px */
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--cbx-space-3);
}
.mt {
  margin-top: var(--cbx-space-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.ops {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
  margin-top: var(--cbx-space-6);
  padding-top: var(--cbx-space-4);
  border-top: 1px solid var(--cbx-border);
}
/* 删除推到最右，跟两个导出按钮拉开距离，避免误点 */
.ops .del {
  margin-left: auto;
}
.del {
  color: var(--cbx-error);
}

@media (max-width: 767px) {
  .body {
    padding: var(--cbx-space-4) var(--cbx-space-3);
  }
  .head {
    flex-direction: column;
  }
  .avatar-col {
    width: 140px;
    align-self: center;
  }
  /* 三个按钮在 375px 下并排会被压成两三个字，各占一整行更好点 */
  .ops .cbx-btn {
    width: 100%;
  }
  .ops .del {
    margin-left: 0;
  }
  .grid2 {
    grid-template-columns: 1fr;
  }
}
</style>
