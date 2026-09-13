<script setup lang="ts">
/**
 * 创建世界向导 —— 先把世界与角色、关系定下来，再生成地图（需求 1）。
 *
 * 为什么是**路由**而不是弹窗：多步表单加一张 canvas、一张关系图谱，在软键盘弹起时
 * 塞不进 `cbx-modal` 的 88vh；而且手机上的系统返回手势应该退出向导，而不是退出应用。
 *
 * 步骤是可点的分段控件而非强制线性流程 —— 每一步都有合理默认值，跳着填、
 * 直接点「创建」都必须能用。顺序照需求：世界背景 → NPC 名单 → 我扮演谁 → 关系图谱 → 地形。
 *
 * ⚠️ 名册 NPC 此刻**还没坐标**（x=-1）：地图还没生成，谈不上落位。第一次进世界时
 * 由 placeRoster 按角色确定性安顿（村民进村、农夫到田边、游荡者去野外）。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import WorldPreview from '@/components/rpg/WorldPreview.vue'
import RelationGraph from '@/components/group/RelationGraph.vue'
import { useRpgStore } from '@/stores/rpg'
import { useSettingsStore } from '@/stores/settings'
import { useCharactersStore } from '@/stores/characters'
import { useToast } from '@/composables/useToast'
import {
  emptyWorld,
  DEFAULT_GEN,
  NPC_MAX,
  RPG_WORLD_SIZE,
  ROUTINE_KIND_LABEL,
  resolveNpc,
  type RpgRoutineKind,
  type RpgWorld,
} from '@/types/rpg'
import { USER_NODE_ID, type GroupNodeLayout, type GroupRelation } from '@/types/group'

defineOptions({ name: 'RpgCreateView' })

const router = useRouter()
const rpg = useRpgStore()
const settings = useSettingsStore()
const chars = useCharactersStore()
const toast = useToast()

const STEPS = [
  { key: 'basic', label: '世界' },
  { key: 'cast', label: '角色' },
  { key: 'me', label: '我是谁' },
  { key: 'relations', label: '关系' },
  { key: 'terrain', label: '地形' },
] as const
const step = ref<(typeof STEPS)[number]['key']>('basic')

/** 草稿就是一个完整的 RpgWorld —— 创建时原样落库，没有第二套形状要维护 */
const draft = ref<RpgWorld>(emptyWorld(crypto.randomUUID(), ''))
const busy = ref(false)

if (!chars.loaded) void chars.load()

/**
 * 尺寸只给三档：192 与 288 都是 chunk(32) 与区域(24) 的公倍数；
 * 256 是历史默认值，它本身带一个不完整的末区域，属于既有行为，不去动它。
 * ⚠️ 尺寸创建后不可改 —— 噪声按 x/width 映射到环面，改尺寸等于换一个世界。
 */
const SIZES = [192, RPG_WORLD_SIZE, 288]

/** 地貌预设。直接写成 gen 的覆盖值，避免用户面对五个滑块无从下手 */
const PRESETS = [
  { key: 'balanced', label: '均衡', over: {} },
  { key: 'isles', label: '群岛', over: { seaLevel: 0.06, radius: 2.4 } },
  { key: 'forest', label: '林野', over: { moistureBias: 0.22 } },
  { key: 'arid', label: '荒原', over: { moistureBias: -0.22, villageChance: 0.4 } },
  { key: 'busy', label: '人烟稠密', over: { districtGate: -0.15, villageChance: 0.9 } },
] as const
const preset = ref<string>('balanced')

function applyPreset(key: string): void {
  const p = PRESETS.find((x) => x.key === key)
  if (!p) return
  preset.value = key
  draft.value.gen = { ...DEFAULT_GEN, ...p.over }
}

function reroll(): void {
  draft.value.seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 1
}

/** 手填种子：非数字就忽略，别把 NaN 灌进采样器 */
function onSeedInput(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(v) && v >= 0) draft.value.seed = Math.floor(v)
}

const effectiveMe = computed(() => ({
  name: draft.value.persona.name.trim() || settings.settings.persona.name || '我',
}))

// ── 角色（NPC 名单）──

const roleKinds = Object.keys(ROUTINE_KIND_LABEL) as RpgRoutineKind[]
const full = computed(() => draft.value.npcs.length >= NPC_MAX)
/** 还没被加进名册的角色卡 */
const candidates = computed(() => {
  const used = new Set(draft.value.npcs.map((n) => n.characterId).filter(Boolean))
  return chars.items.filter((c) => !used.has(c.id))
})

/** 名册每项要显示的名字（关联卡就用卡名） */
function npcLabel(id: string): string {
  const n = draft.value.npcs.find((x) => x.id === id)
  if (!n) return '？'
  return resolveNpc(n, chars.byId(n.characterId)).name
}

function addFromCard(cardId: string): void {
  if (full.value) {
    toast.error(`最多 ${NPC_MAX} 个 NPC`)
    return
  }
  const c = chars.byId(cardId)
  if (!c) return
  draft.value.npcs.push({
    id: crypto.randomUUID(),
    x: -1,
    y: -1,
    characterId: c.id,
    name: c.data.name,
    description: '',
    role: 'villager',
  })
}

function addBlank(): void {
  if (full.value) {
    toast.error(`最多 ${NPC_MAX} 个 NPC`)
    return
  }
  draft.value.npcs.push({
    id: crypto.randomUUID(),
    x: -1,
    y: -1,
    name: '新 NPC',
    description: '',
    role: 'villager',
  })
}

function removeNpc(id: string): void {
  const d = draft.value
  d.npcs = d.npcs.filter((n) => n.id !== id)
  // 图谱里连着它的边与坐标一并清掉，否则关系图会渲染悬空节点
  d.relations = d.relations.filter((r) => r.from !== id && r.to !== id)
  delete d.layout[id]
}

// ── 关系图谱 ──

/** 节点 = 玩家（哨兵）+ 全体名册。玩家排最前，画布初始圆周布局最稳 */
const relationNodes = computed(() => [
  { id: USER_NODE_ID, name: effectiveMe.value.name, isUser: true },
  ...draft.value.npcs.map((n) => ({ id: n.id, name: npcLabel(n.id), isUser: false })),
])

// ⚠️ 全部改内存 draft，创建时一次落库 —— 不像群聊那套每次 save()
function addRelation(from?: string, to?: string): void {
  const nodes = relationNodes.value
  if (nodes.length < 2) return
  const f = from ?? nodes[0]?.id
  const t = to ?? nodes[1]?.id
  if (!f || !t) return
  draft.value.relations.push({ id: crypto.randomUUID(), from: f, to: t, label: '' })
}
function onLayout(layout: Record<string, GroupNodeLayout>): void {
  draft.value.layout = layout
}
function removeRelation(id: string): void {
  draft.value.relations = draft.value.relations.filter((r) => r.id !== id)
}
function swapDirection(r: GroupRelation): void {
  const from = r.from
  r.from = r.to
  r.to = from
}

async function create(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const w = draft.value
    w.name = w.name.trim() || '新世界'
    const saved = await rpg.createFrom(w)
    await router.push(`/rpg/${saved.id}`)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <AppTopbar title="新建世界">
      <template #actions>
        <button class="cbx-btn cbx-btn--ghost sm" @click="router.back()">取消</button>
        <button class="cbx-btn cbx-btn--primary sm" :disabled="busy" @click="create">创建</button>
      </template>
    </AppTopbar>

    <div class="steps">
      <button
        v-for="s in STEPS"
        :key="s.key"
        class="seg"
        :class="{ 'seg--on': step === s.key }"
        @click="step = s.key"
      >
        {{ s.label }}
      </button>
    </div>

    <div class="cbx-scroll body">
      <!-- 世界背景 -->
      <section v-show="step === 'basic'" class="sec">
        <label class="cbx-field">
          <span class="cbx-field__label">世界名</span>
          <input v-model="draft.name" class="cbx-input" placeholder="新世界" />
          <span class="cbx-field__hint">会出现在 NPC 会话标题里，也用于无卡 NPC 的兜底身份</span>
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">世界简介</span>
          <textarea
            v-model="draft.description"
            class="cbx-textarea"
            rows="4"
            placeholder="例：艾尔王国，战后第三年。魔法被教会垄断，边境村镇仍有游荡的残兵。"
          />
          <span class="cbx-field__hint">
            作为【场景】进入这个世界里每一段对话。它<b>不参与</b>地形生成 ——
            地貌由「地形」步的旋钮决定
          </span>
        </label>
      </section>

      <!-- 角色（NPC 名单）-->
      <section v-show="step === 'cast'" class="sec">
        <div class="cbx-field">
          <div class="sec__head">
            <span class="cbx-field__label"
              >NPC 名单（{{ draft.npcs.length }} / {{ NPC_MAX }}）</span
            >
            <span v-if="full" class="cbx-badge">已满</span>
          </div>
          <p class="cbx-field__hint">
            现在只是把「有哪些人」定下来 —— 进世界后按各自身份自动落到村里/田边/野外，
            也可以进去再走到某处补放。
          </p>
        </div>

        <div v-if="candidates.length" class="chips">
          <button
            v-for="c in candidates"
            :key="c.id"
            class="chip"
            :disabled="full"
            @click="addFromCard(c.id)"
          >
            ＋ {{ c.data.name }}
          </button>
        </div>
        <button class="cbx-btn cbx-btn--soft sm selfadd" :disabled="full" @click="addBlank">
          ＋ 自填一个 NPC（不关联角色卡）
        </button>

        <div v-for="npc in draft.npcs" :key="npc.id" class="npc">
          <div class="npc__head">
            <span class="npc__name">{{ npcLabel(npc.id) }}</span>
            <button class="cbx-btn cbx-btn--ghost sm danger" @click="removeNpc(npc.id)">
              删除
            </button>
          </div>
          <label class="cbx-field">
            <span class="cbx-field__label">身份 / 作息</span>
            <select v-model="npc.role" class="cbx-input">
              <option v-for="k in roleKinds" :key="k" :value="k">
                {{ ROUTINE_KIND_LABEL[k] }}
              </option>
            </select>
            <span class="cbx-field__hint">决定它落在哪、每天怎么过</span>
          </label>
          <template v-if="!npc.characterId">
            <label class="cbx-field">
              <span class="cbx-field__label">名字</span>
              <input v-model="npc.name" class="cbx-input" />
            </label>
            <label class="cbx-field">
              <span class="cbx-field__label">人物简介</span>
              <textarea
                v-model="npc.description"
                class="cbx-textarea"
                rows="3"
                placeholder="它是谁、什么身份、说话什么调子 —— 这段会进提示词"
              />
            </label>
          </template>
          <p v-else class="cbx-field__hint">
            用角色卡「{{ npcLabel(npc.id) }}」，名字与简介以卡为准
          </p>
        </div>
      </section>

      <!-- 我是谁 -->
      <section v-show="step === 'me'" class="sec">
        <p class="cbx-field__hint">
          只作用于这个世界。留空则回落到设置里的全局人设 —— 当前实际生效的是 「{{
            effectiveMe.name
          }}」。
        </p>
        <label class="cbx-field">
          <span class="cbx-field__label">我的名字</span>
          <input
            v-model="draft.persona.name"
            class="cbx-input"
            :placeholder="settings.settings.persona.name || '我'"
          />
        </label>
        <label class="cbx-field">
          <span class="cbx-field__label">我的身份</span>
          <textarea
            v-model="draft.persona.description"
            class="cbx-textarea"
            rows="4"
            placeholder="你在这个世界里是谁、什么身份、为什么在这里"
          />
        </label>
      </section>

      <!-- 关系图谱 -->
      <section v-show="step === 'relations'" class="sec">
        <p class="cbx-field__hint">
          拖动摆位、点节点上的 ＋ 拉一条关系线。这些关系会进每个相关 NPC 的对话提示词，
          让「你是她哥哥」「你暗恋村长女儿」这类设定真正影响它怎么跟你说话。
        </p>
        <p v-if="draft.npcs.length === 0" class="cbx-field__hint warn">
          还没有 NPC —— 先去「角色」步加人，才有关系可连。
        </p>
        <template v-else>
          <button class="cbx-btn cbx-btn--soft sm" @click="addRelation()">＋ 加一条关系</button>
          <div class="graphbox">
            <RelationGraph
              :members="relationNodes"
              :relations="draft.relations"
              :layout="draft.layout"
              @update:layout="onLayout"
              @create-relation="addRelation"
              @remove-relation="removeRelation"
              @swap-relation="swapDirection"
            />
          </div>
        </template>
      </section>

      <!-- 地形 -->
      <section v-show="step === 'terrain'" class="sec">
        <div class="cbx-field">
          <span class="cbx-field__label">地貌预设</span>
          <div class="segs">
            <button
              v-for="p in PRESETS"
              :key="p.key"
              class="seg"
              :class="{ 'seg--on': preset === p.key }"
              @click="applyPreset(p.key)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <div class="cbx-field">
          <span class="cbx-field__label">种子</span>
          <div class="seedrow">
            <input
              class="cbx-input"
              type="number"
              min="0"
              :value="draft.seed"
              @input="onSeedInput"
            />
            <button class="cbx-btn cbx-btn--soft" @click="reroll">🎲 重掷</button>
          </div>
          <span class="cbx-field__hint">同一个种子必然长出同一个世界</span>
        </div>

        <div class="cbx-field">
          <span class="cbx-field__label">世界尺寸（创建后不可更改）</span>
          <div class="segs">
            <button
              v-for="s in SIZES"
              :key="s"
              class="seg"
              :class="{ 'seg--on': draft.width === s }"
              @click="((draft.width = s), (draft.height = s))"
            >
              {{ s }}²
            </button>
          </div>
        </div>

        <WorldPreview
          :seed="draft.seed"
          :width="draft.width"
          :height="draft.height"
          :gen="draft.gen"
        />

        <details class="adv">
          <summary>进阶：逐项微调</summary>
          <label class="cbx-field">
            <span class="cbx-field__label">海平面 {{ draft.gen.seaLevel.toFixed(2) }}</span>
            <input
              v-model.number="draft.gen.seaLevel"
              type="range"
              min="-0.3"
              max="0.25"
              step="0.01"
            />
            <span class="cbx-field__hint"
              >越高水越多。它同时是台阶的基准面，抬高会让陆地整体变平</span
            >
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">地貌尺度 {{ draft.gen.radius.toFixed(1) }}</span>
            <input v-model.number="draft.gen.radius" type="range" min="0.8" max="3.6" step="0.1" />
            <span class="cbx-field__hint">越大绕一圈经过的噪声越多，大陆碎成群岛</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">湿润度 {{ draft.gen.moistureBias.toFixed(2) }}</span>
            <input
              v-model.number="draft.gen.moistureBias"
              type="range"
              min="-0.4"
              max="0.4"
              step="0.02"
            />
            <span class="cbx-field__hint">&gt;0 更多森林，&lt;0 更多荒原与沙地</span>
          </label>
          <label class="cbx-field">
            <span class="cbx-field__label">聚落密度 {{ draft.gen.villageChance.toFixed(2) }}</span>
            <input
              v-model.number="draft.gen.villageChance"
              type="range"
              min="0"
              max="1"
              step="0.02"
            />
            <span class="cbx-field__hint">村庄数量直接看上面的读数</span>
          </label>
        </details>
      </section>
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
.steps {
  display: flex;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3) var(--cbx-space-5) 0;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.segs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.seg {
  padding: var(--cbx-space-2) var(--cbx-space-4);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg);
  color: var(--cbx-text-secondary);
  cursor: pointer;
  font-size: var(--cbx-fs-sm);
}
.seg--on {
  background: var(--cbx-brand);
  border-color: var(--cbx-brand);
  color: #fff;
}
.body {
  flex: 1;
  min-height: 0;
  padding: var(--cbx-space-5);
}
.sec {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-4);
  max-width: 560px;
}
.sec__head {
  display: flex;
  align-items: center;
  gap: var(--cbx-space-2);
}
.seedrow {
  display: flex;
  gap: var(--cbx-space-2);
}
.seedrow .cbx-input {
  flex: 1;
  min-width: 0;
}
/* ── 角色 ── */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--cbx-space-2);
}
.chip {
  padding: var(--cbx-space-2) var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg);
  color: var(--cbx-text-secondary);
  cursor: pointer;
  font-size: var(--cbx-fs-sm);
}
.chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.selfadd {
  align-self: flex-start;
}
.npc {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
  padding: var(--cbx-space-3);
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
}
.npc__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.npc__name {
  font-weight: 600;
}
.danger {
  color: var(--cbx-error);
}
.warn {
  color: var(--cbx-warning);
}
/* ── 关系画布 ── */
.graphbox {
  height: 60vh;
  min-height: 320px;
  border: 1px solid var(--cbx-border);
  border-radius: var(--cbx-radius-md);
  overflow: hidden;
}
.adv summary {
  cursor: pointer;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
  padding: var(--cbx-space-2) 0;
}
.adv {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-3);
}
.adv .cbx-field {
  margin-top: var(--cbx-space-3);
}
input[type='range'] {
  width: 100%;
}
@media (max-width: 767px) {
  .steps {
    padding: var(--cbx-space-3) var(--cbx-space-3) 0;
  }
  .body {
    padding: var(--cbx-space-3);
  }
  .seg {
    min-height: var(--cbx-tap-min);
  }
}
</style>
