<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import RelationGraph from '@/components/group/RelationGraph.vue'
import WorldMapPicker from '@/components/infinite-world/WorldMapPicker.vue'
import { useInfiniteWorldStore } from '@/stores/infiniteWorld'
import { useCharactersStore } from '@/stores/characters'
import { useSettingsStore } from '@/stores/settings'
import { useWorldsStore } from '@/stores/worlds'
import { useToast } from '@/composables/useToast'
import { USER_NODE_ID, type GroupRelation } from '@/types/group'
import { BIOME_LABEL, type GameWorld, type NpcBlueprint, type TerrainPreview } from '@/types/infiniteWorld'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { Flag, type WorldGrid } from '@/services/infinite-world/generation/grid'
import { validateWorld } from '@/services/infinite-world/validation'
import { toPlain } from '@/utils/plain'

const router = useRouter(), route = useRoute()
const worlds = useInfiniteWorldStore(), chars = useCharactersStore(), settings = useSettingsStore(), books = useWorldsStore()
const toast = useToast()
const step = ref(0), ready = ref(false), busy = ref(false), error = ref(''), draftStatus = ref('')
const editing = computed(() => !!route.params.id)
const draft = ref<GameWorld>(worlds.draft())
const draftKey = 'infinite-world-draft-v1'
const relationView = ref<'graph' | 'list'>('graph')
const relationFrom = ref(USER_NODE_ID), relationTo = ref('')
const steps = ['世界观', '玩家身份', '选择居民', '关系图谱', '生成预览']
const members = computed(() => [
  { id: USER_NODE_ID, name: draft.value.player.name || '我', isUser: true },
  ...draft.value.npcs.map((n) => ({ id: n.npcId, name: n.name })),
])
/**
 * 地形预览。
 *
 * ⚠️ 必须是**异步 + 防抖 + 走 Worker**，不能是 computed。
 * 新生成器要跑完整的 512×512 流水线（约 1 秒）；放在 computed 里的话，
 * 每拖一下滑杆就冻结主线程一秒，滑杆根本没法用。
 *
 * 过期请求用自增序号丢弃 —— 拖动会连发几十次，晚到的结果必须能识别出
 * 「这不是当前要的那个」。
 */
const preview = ref<TerrainPreview | null>(null)
/** ⚠️ shallowRef：网格是 3.4MB 定型数组，绝不能被 Vue 深度代理 */
const previewGrid = shallowRef<WorldGrid | null>(null)
const previewBusy = ref(false)
const previewStep = ref('')
const previewInfo = ref('')
let previewSeq = 0
let previewTimer: ReturnType<typeof setTimeout> | null = null

/** 传给地图选点的 NPC 家标记 */
const npcHomes = computed(() =>
  draft.value.npcs.map((n) => ({ id: n.npcId, name: n.name, pos: n.home })),
)

function tileIdx(x: number, y: number): number {
  const wx = ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  const wy = ((y % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  return wy * WORLD_SIZE + wx
}

/** 出生点在这张网格里是否合法（主连通域、可通行、非建筑） */
function spawnValid(grid: WorldGrid, [x, y]: [number, number]): boolean {
  const i = tileIdx(x, y)
  return (
    grid.region[i] === grid.mainRegion &&
    (grid.flags[i]! & Flag.Walkable) !== 0 &&
    (grid.flags[i]! & Flag.Building) === 0
  )
}

/**
 * 把每个 NPC 的家安排到出生点附近、主连通域内、彼此错开的可走格。
 *
 * ⚠️ 这修的是真缺陷：旧默认 `home:[15+i%4,14]` 是**写死坐标**，绝大多数种子
 * 的镇不在那儿，`validatePlacement`（要求家与出生点同连通域）会当场失败，
 * 而向导没有任何设家的 UART —— 用户卡在「创建世界」按钮上无从下手。
 * 确定性 ring 搜索：同样的 grid+spawn 永远得到同样的安排。
 */
function assignHomes(grid: WorldGrid, spawn: [number, number]): void {
  const main = grid.mainRegion
  const used = new Set<number>()
  used.add(tileIdx(spawn[0], spawn[1]))
  const spaced = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) if (used.has(tileIdx(x + dx, y + dy))) return false
    return true
  }
  for (const npc of draft.value.npcs) {
    let placed: [number, number] | null = null
    for (let r = 1; r <= 48 && !placed; r++) {
      for (let dy = -r; dy <= r && !placed; dy++) {
        for (let dx = -r; dx <= r && !placed; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const x = ((spawn[0] + dx) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE
          const y = ((spawn[1] + dy) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE
          const i = y * WORLD_SIZE + x
          if (grid.region[i] !== main) continue
          if (!(grid.flags[i]! & Flag.Walkable)) continue
          if (grid.flags[i]! & Flag.Building) continue
          if (!spaced(x, y)) continue
          placed = [x, y]
        }
      }
    }
    if (placed) {
      npc.home = placed
      used.add(tileIdx(placed[0], placed[1]))
    }
  }
}

/** 用户在地图上选了出生点：更新并把居民重新安置到附近 */
function pickSpawn(pos: [number, number]) {
  draft.value.player.spawn = pos
  if (previewGrid.value) assignHomes(previewGrid.value, pos)
}

function schedulePreview() {
  if (step.value !== 4) return
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => void runPreview(), 300)
}

async function runPreview() {
  const token = ++previewSeq
  previewBusy.value = true
  try {
    const [{ buildWorldAsync }, { makeTerrainPreview }] = await Promise.all([
      import('@/services/infinite-world/generation/worldSource'),
      import('@/services/infinite-world/generation/pipeline'),
    ])
    const grid = await buildWorldAsync({
      seed: draft.value.seed,
      settings: draft.value.settings,
      generatorVersion: draft.value.generatorVersion,
      onProgress: (label) => { if (token === previewSeq) previewStep.value = label },
    })
    if (token !== previewSeq) return
    preview.value = makeTerrainPreview(grid)
    previewGrid.value = grid
    // 创建模式：出生点若还没选（或换了种子后失效）就落到生成器建议点，并安置居民
    if (!editing.value) {
      if (!spawnValid(grid, draft.value.player.spawn)) draft.value.player.spawn = [grid.spawn[0], grid.spawn[1]]
      assignHomes(grid, draft.value.player.spawn)
    }
    previewInfo.value = grid.towns.length + ' 个聚落'
  } catch (e) {
    if (token === previewSeq) previewInfo.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (token === previewSeq) { previewBusy.value = false; previewStep.value = '' }
  }
}

watch([step, () => draft.value.seed, () => draft.value.settings], schedulePreview, { deep: true })
const biomeSummary = computed(() => {
  const p = preview.value
  if (!p) return ''
  const total = p.width * p.height
  return Object.entries(p.counts)
    .filter(([, n]) => n > 0)
    .map(([key, n]) => BIOME_LABEL[key as keyof typeof BIOME_LABEL] + ' ' + Math.round((n / total) * 100) + '%')
    .join(' · ')
})
const chosen = (id: string) => draft.value.npcs.some((n) => n.sourceCharacterId === id)

onMounted(async () => {
  try {
    await Promise.all([chars.load(), settings.loaded ? Promise.resolve() : settings.load(), books.load()])
    if (editing.value) {
      const world = await worlds.open(String(route.params.id))
      if (!world) throw new Error('此世界不存在或已被删除。')
      draft.value = toPlain(world)
    } else {
      draft.value.player.name = settings.settings.persona.name || '我'
      draft.value.player.description = settings.settings.persona.description
      try {
        const raw = localStorage.getItem(draftKey)
        if (raw) {
          const saved = JSON.parse(raw)
          validateWorld(saved.world)
          draft.value = saved.world
          step.value = Math.max(0, Math.min(4, Number(saved.step) || 0))
          draftStatus.value = '已恢复上次的创建草稿'
        }
      } catch { draftStatus.value = '上次草稿不可用，已开启新草稿' }
    }
    ready.value = true
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
})
watch([draft, step], () => {
  if (!ready.value || editing.value || busy.value) return
  try {
    localStorage.setItem(draftKey, JSON.stringify({ world: toPlain(draft.value), step: step.value }))
    draftStatus.value = '草稿已保存在此设备'
  } catch { draftStatus.value = '草稿保存失败，请保持此页面打开' }
}, { deep: true })

function removeNpc(id: string) {
  draft.value.npcs = draft.value.npcs.filter((n) => n.npcId !== id)
  draft.value.relations = draft.value.relations.filter((r) => r.from !== id && r.to !== id)
  delete draft.value.relationLayout[id]
  if (relationTo.value === id) relationTo.value = ''
  if (relationFrom.value === id) relationFrom.value = USER_NODE_ID
}
function baseNpc(name: string, profession = '居民'): NpcBlueprint {
  return { npcId: crypto.randomUUID(), name, profession, home: [15 + draft.value.npcs.length % 4, 14], speed: 2, useLlm: false, schedule: [] }
}
function toggleNpc(id: string) {
  const existing = draft.value.npcs.find((n) => n.sourceCharacterId === id)
  if (existing) return removeNpc(existing.npcId)
  const character = chars.byId(id)
  if (!character) return
  draft.value.npcs.push({ ...baseNpc(character.data.name), sourceCharacterId: id, sourceUpdatedAt: character.updatedAt,
    cardSnapshot: toPlain(character.data), avatarBlobId: character.avatarBlobId })
}
function addResidents() {
  for (const [name, profession] of [['小禾', '农夫'], ['阿栗', '店主'], ['林悠', '巡林员']]) {
    if (!draft.value.npcs.some((npc) => npc.name === name)) draft.value.npcs.push(baseNpc(name!, profession))
  }
}
function createRelation(from: string, to: string) {
  if (from === to || !members.value.some((m) => m.id === from) || !members.value.some((m) => m.id === to)) return
  if (draft.value.relations.some((r) => r.from === from && r.to === to)) return toast.info('这两个节点已经有同向关系')
  draft.value.relations.push({ id: crypto.randomUUID(), from, to, label: '熟人', score: 0, trust: 50, desc: '' })
}
function swapRelation(relation: GroupRelation) {
  if (draft.value.relations.some((r) => r.id !== relation.id && r.from === relation.to && r.to === relation.from)) return toast.info('反向关系已存在')
  const from = relation.from
  relation.from = relation.to
  relation.to = from
}
function next() {
  error.value = ''
  if (step.value === 0 && (!draft.value.name.trim() || !draft.value.lore.premise.trim())) { error.value = '请填写世界名称和背景。'; return }
  if (step.value === 1 && !draft.value.player.name.trim()) { error.value = '请填写玩家名字。'; return }
  step.value = Math.min(4, step.value + 1)
}
async function finish() {
  if (busy.value) return
  error.value = ''
  try {
    validateWorld(draft.value)
    busy.value = true

    // ⚠️ 出生点必须来自**生成出来的地形**，不能用 emptyWorld() 那个写死的 [16,16]。
    // 写死的坐标完全可能落在湖里、林子里或某个被树围住的小口袋里 ——
    // 创建时一切正常，进游戏才发现动不了，而向导的预览图上看不出任何异常。
    //
    // 新建时才做：已创建的世界地图参数不可变，出生点属于地图参数。
    if (!editing.value) {
      const [{ buildWorldAsync }, { validatePlacement }] = await Promise.all([
        import('@/services/infinite-world/generation/worldSource'),
        import('@/services/infinite-world/validation'),
      ])
      // 缓存命中（向导预览刚算过同一个种子），所以这里通常是瞬时的
      const grid = await buildWorldAsync({
        seed: draft.value.seed,
        settings: draft.value.settings,
        generatorVersion: draft.value.generatorVersion,
      })
      // 用户在地图上选的出生点优先；没选/失效才落到生成器建议点
      if (!spawnValid(grid, draft.value.player.spawn)) draft.value.player.spawn = [grid.spawn[0], grid.spawn[1]]
      // 居民住处重新落到出生点附近的可走格，保证与出生点同连通域
      assignHomes(grid, draft.value.player.spawn)
      // 兜底校验：这一步会指出具体是哪位居民出了问题
      validatePlacement(toPlain(draft.value), grid)
    }

    const result = editing.value ? await worlds.persist(toPlain(draft.value)) : await worlds.create(toPlain(draft.value))
    if (!editing.value) { try { localStorage.removeItem(draftKey) } catch { /* world is already saved */ } }
    toast.success(editing.value ? '世界设定已保存' : '世界已创建')
    await router.push('/game-worlds/' + result.world.id)
  } catch (e) { error.value = e instanceof Error ? e.message : String(e) }
  finally { busy.value = false }
}
</script>

<template>
  <AppTopbar :title="editing ? '编辑无限世界' : '创建无限世界'">
    <template #actions><button class="cbx-btn cbx-btn--ghost" :disabled="busy" @click="router.push('/game-worlds')">返回世界列表</button></template>
  </AppTopbar>
  <div class="cbx-scroll body">
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="!ready && !error">正在加载世界资料…</p>
    <template v-if="ready">
      <div class="steps"><span v-for="(label, i) in steps" :key="label" :class="{ active: i === step, done: i < step }">{{ i + 1 }}. {{ label }}</span></div>
      <section class="cbx-card panel">
        <template v-if="step === 0">
          <h2>先决定这片土地是什么样</h2>
          <label class="cbx-field"><span class="cbx-field__label">世界名称</span><input v-model="draft.name" class="cbx-input" maxlength="80" placeholder="例如：橡果谷" /></label>
          <label class="cbx-field"><span class="cbx-field__label">世界背景</span><textarea v-model="draft.lore.premise" class="cbx-textarea" rows="4" /></label>
          <label class="cbx-field"><span class="cbx-field__label">故事基调</span><input v-model="draft.lore.tone" class="cbx-input" /></label>
          <label class="cbx-field"><span class="cbx-field__label">叙事规则</span><textarea v-model="draft.lore.rules" class="cbx-textarea" rows="3" placeholder="例如：小镇居民相信森林深处藏着古老的秘密。" /></label>
          <label class="cbx-field"><span class="cbx-field__label">地理风貌</span><textarea v-model="draft.lore.geography" class="cbx-textarea" rows="3" placeholder="例如：一条大河把小镇一分为二，北岸是田野，南岸是老林。" /></label>
          <p class="hint">这些文字用于记录世界设定；营业、农业等生活规则将在后续玩法中加入。</p>
          <fieldset v-if="books.items.length"><legend>关联世界书（创建时保存副本）</legend><label v-for="book in books.items" :key="book.id" class="book"><input v-model="draft.lore.worldBookIds" type="checkbox" :value="book.id" />{{ book.name }}</label></fieldset>
        </template>
        <template v-else-if="step === 1">
          <h2>玩家身份</h2>
          <label class="cbx-field"><span class="cbx-field__label">名字</span><input v-model="draft.player.name" class="cbx-input" /></label>
          <label class="cbx-field"><span class="cbx-field__label">身份 / 职业</span><input v-model="draft.player.identity" class="cbx-input" placeholder="例如：返乡农人" /></label>
          <label class="cbx-field"><span class="cbx-field__label">经历</span><textarea v-model="draft.player.description" class="cbx-textarea" rows="4" /></label>
          <label class="cbx-field"><span class="cbx-field__label">目标</span><input v-model="draft.player.goal" class="cbx-input" placeholder="你希望在这里实现什么？" /></label>
        </template>
        <template v-else-if="step === 2">
          <h2>选择居民（可选）</h2>
          <p class="hint">从角色库选择居民，或添加三位基础居民。也可以直接创建无居民的世界。</p>
          <button class="cbx-btn cbx-btn--soft" @click="addResidents">添加推荐居民</button>
          <div class="characters"><button v-for="character in chars.items" :key="character.id" class="character" :class="{ selected: chosen(character.id) }" @click="toggleNpc(character.id)"><strong>{{ character.data.name }}</strong><span>{{ character.data.personality || '尚未填写性格' }}</span></button></div>
          <div v-for="npc in draft.npcs" :key="npc.npcId" class="npc-row">
            <input v-model="npc.name" class="cbx-input" aria-label="居民名字" />
            <input v-model="npc.profession" class="cbx-input" aria-label="居民职业" />
            <button class="cbx-btn cbx-btn--ghost" :aria-label="'移除' + npc.name" @click="removeNpc(npc.npcId)">移除</button>
          </div>
        </template>
        <template v-else-if="step === 3">
          <h2>配置关系图谱</h2>
          <div class="actions"><button class="cbx-btn cbx-btn--soft" @click="relationView = relationView === 'graph' ? 'list' : 'graph'">{{ relationView === 'graph' ? '切换到关系列表' : '切换到图谱' }}</button></div>
          <div v-if="relationView === 'graph'" class="graph-wrap"><RelationGraph :members="members" :relations="draft.relations" :layout="draft.relationLayout" @update:layout="draft.relationLayout = $event" @create-relation="createRelation" @remove-relation="(id) => draft.relations = draft.relations.filter((r) => r.id !== id)" @swap-relation="swapRelation" /></div>
          <div class="relation-add">
            <select v-model="relationFrom" class="cbx-input" aria-label="关系起点"><option v-for="m in members" :key="m.id" :value="m.id">{{ m.name }}</option></select><span>→</span>
            <select v-model="relationTo" class="cbx-input" aria-label="关系终点"><option value="" disabled>选择对象</option><option v-for="m in members.filter((m) => m.id !== relationFrom)" :key="m.id" :value="m.id">{{ m.name }}</option></select>
            <button class="cbx-btn cbx-btn--soft" :disabled="!relationTo || relationFrom === relationTo" @click="createRelation(relationFrom, relationTo)">添加关系</button>
          </div>
          <div v-for="r in draft.relations" :key="r.id" class="relation-row">
            <strong>{{ members.find((m) => m.id === r.from)?.name }} → {{ members.find((m) => m.id === r.to)?.name }}</strong>
            <label>关系名称<input v-model="r.label" class="cbx-input" /></label>
            <label>说明<input v-model="r.desc" class="cbx-input" /></label>
            <div class="npc-row"><label>好感<input v-model.number="r.score" class="cbx-input" type="number" min="-100" max="100" /></label><label>信任<input v-model.number="r.trust" class="cbx-input" type="number" min="0" max="100" /></label><button class="cbx-btn cbx-btn--ghost" @click="draft.relations = draft.relations.filter((item) => item.id !== r.id)">删除关系</button></div>
          </div>
        </template>
        <template v-else>
          <h2>生成预览</h2>
          <p class="hint">{{ editing ? '已创建世界保留原地图参数。身份、居民和关系可以继续编辑。' : '沿主路可以经过城镇、田野和河桥；预览与进入后的地图使用同一颗种子。' }}</p>
          <fieldset :disabled="editing">
            <label class="cbx-field"><span class="cbx-field__label">世界种子</span><input v-model="draft.seed" class="cbx-input" /></label>
            <label class="cbx-field"><span class="cbx-field__label">一天时长（分钟）</span><input v-model.number="draft.settings.dayMinutes" type="number" min="5" max="120" class="cbx-input" /></label>
            <label class="cbx-field">初始季节<select v-model.number="draft.settings.season" class="cbx-input"><option v-for="(s, i) in ['春', '夏', '秋', '冬']" :key="s" :value="i">{{ s }}</option></select></label>
            <label class="cbx-field">森林覆盖<input v-model.number="draft.settings.forestDensity" type="range" min="0" max="1" step="0.05" /></label>
            <label class="cbx-field">田野比例<input v-model.number="draft.settings.fieldDensity" type="range" min="0" max="1" step="0.05" /></label>
            <label class="cbx-field">河流宽度<input v-model.number="draft.settings.waterRatio" type="range" min="0" max="1" step="0.05" /></label>
          </fieldset>
          <div class="preview">
            <div v-if="previewBusy" class="preview__busy">{{ previewStep || '正在铺开这片世界' }}…</div>
            <WorldMapPicker
              v-else
              :grid="previewGrid"
              :spawn="draft.player.spawn"
              :homes="npcHomes"
              :disabled="editing"
              @update:spawn="pickSpawn"
            />
            <p v-if="preview && !previewBusy" class="hint">{{ biomeSummary }}</p>
            <p v-if="previewInfo && !previewBusy" class="hint">{{ previewInfo }}</p>
          </div>
        </template>
        <div class="actions"><button class="cbx-btn cbx-btn--ghost" :disabled="step === 0 || busy" @click="step--; error = ''">上一步</button><button v-if="step < 4" class="cbx-btn cbx-btn--primary" @click="next">下一步</button><button v-else class="cbx-btn cbx-btn--primary" :disabled="busy" @click="finish">{{ busy ? '正在保存…' : editing ? '保存设定' : '创建世界' }}</button></div>
        <p v-if="!editing" class="hint">{{ draftStatus }}</p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.body { flex: 1; padding: var(--cbx-space-5); }
.steps { display: flex; gap: 8px; margin: 0 auto 20px; max-width: 920px; overflow-x: auto; }
.steps span { padding: 8px 12px; border-radius: 24px; color: var(--cbx-text-tertiary); white-space: nowrap; background: var(--cbx-bg-secondary); }
.steps .active { color: var(--cbx-brand); background: var(--cbx-brand-light); font-weight: 700; }
.steps .done { color: var(--cbx-success); }
.panel { max-width: 920px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.hint { color: var(--cbx-text-secondary); font-size: var(--cbx-fs-sm); line-height: 1.7; }
.error { color: var(--cbx-danger); margin: 0 auto 16px; max-width: 920px; }
.characters { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.character { display: flex; flex-direction: column; gap: 6px; padding: 16px; text-align: left; color: var(--cbx-text); background: var(--cbx-bg-secondary); border: 1px solid var(--cbx-border); border-radius: 12px; cursor: pointer; }
.character span { color: var(--cbx-text-secondary); font-size: var(--cbx-fs-sm); max-height: 4em; overflow: hidden; }
.character.selected { border-color: var(--cbx-brand); background: var(--cbx-brand-light); }
.graph-wrap { height: 460px; border: 1px solid var(--cbx-border); border-radius: 12px; overflow: hidden; }
.preview__busy { display: grid; place-items: center; width: min(100%, 480px); aspect-ratio: 1; border-radius: 12px; background: var(--cbx-bg-secondary); color: var(--cbx-text-tertiary); font-size: var(--cbx-fs-sm); }
.actions, .npc-row, .relation-add { display: flex; align-items: center; gap: 10px; }
.actions { justify-content: space-between; }
.npc-row > *, .relation-add > select { flex: 1; min-width: 0; }
.relation-row { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--cbx-border); border-radius: 12px; }
fieldset { display: grid; gap: 16px; border: 0; padding: 0; min-width: 0; }
fieldset:disabled { opacity: .65; }
.book { display: flex; gap: 8px; align-items: center; }
@media (max-width: 767px) { .body { padding: 12px; } .graph-wrap { height: 380px; } .relation-add { flex-wrap: wrap; } }
</style>
