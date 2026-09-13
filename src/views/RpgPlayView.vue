<script setup lang="ts">
/**
 * 游戏本体。
 *
 * ⚠️ 生命周期要点：引擎持有一个 WebGPU 上下文与一条 rAF 循环，离开本页
 * **必须**整个还回去（这与 parallax.ts 那个刻意常驻的渲染器正相反）。
 * 本页也刻意**不进 App.vue 的 KEEP_ALIVE**：保活会让 onMounted 只跑一次，
 * 而引擎的起停就得改用 onActivated/onDeactivated，徒增一类容易漏的状态。
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import DialogueBar from '@/components/rpg/DialogueBar.vue'
import NpcEditor from '@/components/rpg/NpcEditor.vue'
import Backpack from '@/components/rpg/Backpack.vue'
import TouchPad from '@/components/rpg/TouchPad.vue'
import { useRpgStore } from '@/stores/rpg'
import { useCharactersStore } from '@/stores/characters'
import { useToast } from '@/composables/useToast'
import { createWorld, worldParamsOf } from '@/services/rpg/world'
import { placeRoster } from '@/services/rpg/placement'
import { createEngine, type EngineHandle } from '@/services/rpg/engine'
import { stopTalking, talkToNpc } from '@/services/rpg/dialogue'
import { NPC_MAX, ROUTINE_KIND_LABEL, resolveNpc, type RpgNpc } from '@/types/rpg'
import { TALK_MINUTES, formatTimeOfDay, phaseLabel, phaseOf } from '@/services/rpg/time'
import { ITEMS, TOOLS, cellKey, propLabel, type ToolId } from '@/services/rpg/harvest'

defineOptions({ name: 'RpgPlayView' })

const route = useRoute()
const router = useRouter()
const rpg = useRpgStore()
const chars = useCharactersStore()
const toast = useToast()

const host = ref<HTMLElement | null>(null)
const bar = ref<InstanceType<typeof DialogueBar> | null>(null)
const engine = shallowRef<EngineHandle | null>(null)
const booting = ref(true)
const bootError = ref('')
const backend = ref('')
const nearName = ref('')
/** HUD 日期簇：「第 N 天」 */
const dayText = ref('')
/** HUD 时刻簇：「下午 15:51」 */
const timeText = ref('')
const editorOpen = ref(false)
const bagOpen = ref(false)

/** 当前手持工具。引擎才是真相源，这里只是给模板用的响应式镜像 */
const curTool = ref<ToolId>('hand')
/** 上下文提示气泡的文案（靠近 NPC / 面对可采物 / 空） */
const tip = ref('')

/**
 * 采集覆盖层的**非响应式**镜像：格键 → 长回来的时刻（游戏分钟）。
 *
 * ⚠️ 不直接读 `w.harvested`：那是 pinia 的响应式代理，而 propAt 光是建一次
 * chunk 就要调六万多次，每次多一个代理 get 纯属白烧。这里留一份普通 Map 供查询，
 * 采集时**双写**（Map 管查询、存档对象管落盘）。
 */
const harvestMap = new Map<string, number>()
/** 当前游戏分钟。判断「长回来没有」要用，每帧由 onTick 刷新 */
let nowMinutes = 0

/** 注入世界：这一格此刻是不是空的（被采走且还没长回来） */
function isHarvested(x: number, y: number): boolean {
  const t = harvestMap.get(cellKey(x, y))
  return t !== undefined && t > nowMinutes
}

/** 注入引擎：取走所有到点该长回来的格（引擎据此重建网格） */
function takeExpired(now: number): Array<{ x: number; y: number }> {
  const w = rpg.current
  const out: Array<{ x: number; y: number }> = []
  // ⚠️ 先拷一份再遍历：循环里在删同一张 Map
  for (const [k, t] of [...harvestMap]) {
    if (t > now) continue
    harvestMap.delete(k)
    if (w) delete w.harvested[k]
    const c = k.split(',')
    out.push({ x: Number(c[0]), y: Number(c[1]) })
  }
  return out
}

function toolName(id: ToolId): string {
  return TOOLS.find((t) => t.id === id)?.name ?? id
}

function pickTool(id: ToolId): void {
  engine.value?.setTool(id)
  curTool.value = id
  refreshTip()
}

/**
 * 重算提示气泡。
 *
 * ⚠️ 刻意**不是每帧**算：harvestTarget 要扫 5×5 个格，每格一次 propAt（噪声采样
 * 好几层）。每帧算就是每秒一千多次噪声，白白吃掉移动端的帧。目标只在「玩家换了
 * 格子 / 换了工具 / 世界变了」时才会变，按这三件事触发即可。
 */
function refreshTip(): void {
  const eng = engine.value
  if (!eng) return
  if (nearName.value) {
    tip.value = `面向 ${nearName.value} · 空格交谈`
    return
  }
  const t = eng.harvestTarget()
  if (!t) {
    tip.value = ''
    return
  }
  tip.value = t.ready
    ? `面向${propLabel(t.kind)} · 空格${t.rule.verb}`
    : `面向${propLabel(t.kind)} · 需要${toolName(t.rule.tool)}`
}

/** 玩家位置每帧都在变，但只有跨格时才值得落盘 —— 否则一秒写几十次 IDB */
let lastSavedTile = ''
/** 提示气泡的重算依据：格坐标 + 工具 + 附近 NPC。变了才重算，见 refreshTip */
let lastTipKey = ''
/** 世界时刻的兜底落盘间隔（游戏分钟）。见 onTick 里的说明 */
const CLOCK_SAVE_MINUTES = 30
let lastSavedMinutes = 0

onMounted(async () => {
  const id = route.params['id']
  const wid = Array.isArray(id) ? id[0] : id
  if (!wid) {
    await router.push('/rpg')
    return
  }
  if (!chars.loaded) await chars.load()
  const w = await rpg.open(wid)
  if (!w) {
    toast.error('世界不存在')
    await router.push('/rpg')
    return
  }

  // 采集覆盖层：存档 → 非响应式镜像。必须在 createWorld 之前 —— 建 chunk 时
  // propAt 就要查它，晚一步的话开局那一帧砍掉的树会又长出来
  harvestMap.clear()
  for (const [k, v] of Object.entries(w.harvested)) harvestMap.set(k, v)
  nowMinutes = w.worldMinutes

  try {
    const world = createWorld(worldParamsOf(w), { isHarvested })
    // 向导里配好的名册 NPC 还没坐标（x=-1），第一次进世界按角色落位。
    // ⚠️ 必须在 createEngine 之前 —— 引擎 syncNpcs/initRt 会把 x<0 的人当「站错了」
    // 用通用兜底就近挪走，那样铁匠就不进村、农夫就不到田边了。落位是幂等的：
    // 已经有坐标的人 placeRoster 直接跳过
    if (placeRoster(world, w.npcs)) await rpg.save()
    const el = host.value
    if (!el) return
    const eng = await createEngine({
      world,
      host: el,
      npcs: w.npcs,
      clock0: w.worldMinutes,
      timeScale: w.timeScale,
      harvest: { takeExpired },
      ...(w.playerX >= 0 ? { start: { x: w.playerX, y: w.playerY } } : {}),
      // ?webgl=1 强制走 WebGL 后端。这个入参一直都在，只是从没接到视图层 ——
      // 于是移动端唯一会走的那条回退路径至今**没法验**
      ...(new URLSearchParams(location.search).get('webgl') === '1' ? { forceWebGL: true } : {}),
    })
    engine.value = eng
    // 以存档里的时刻为基准起算，否则一进游戏就先白写一次
    lastSavedMinutes = w.worldMinutes
    // 验收脚本要停掉 rAF 自己驱动 setPlayer/render，才能无竞态地断言接缝
    if (import.meta.env.DEV) (globalThis as Record<string, unknown>)['__rpg'] = eng
    backend.value = eng.scene.backend
    eng.onTick = onTick
    // NPC 漫游跨格时落盘,3 秒节流 —— 不然一群村民能把 IndexedDB 走冒烟
    let lastNpcSave = 0
    eng.onNpcMoved = () => {
      const now = Date.now()
      if (now - lastNpcSave < 3000 || rpg.pending) return
      lastNpcSave = now
      void rpg.save()
    }
    eng.start()
  } catch (e) {
    bootError.value = e instanceof Error ? e.message : String(e)
  } finally {
    booting.value = false
  }
})

function onTick() {
  const eng = engine.value
  const w = rpg.current
  if (!eng || !w) return
  const near = eng.nearNpc()
  nearName.value = near ? resolveNpc(near, chars.byId(near.characterId)).name : ''

  // 跨格才落盘
  const p = eng.position()
  const tile = `${Math.floor(p.x)},${Math.floor(p.y)}`
  if (tile !== lastSavedTile) {
    lastSavedTile = tile
    w.playerX = p.x
    w.playerY = p.y
  }
  const c = eng.clock()
  w.worldMinutes = c.total
  // propAt 判断「长回来没有」读的就是它
  nowMinutes = c.total
  curTool.value = eng.tool()
  // 提示气泡按「格 + 工具 + 附近 NPC + 世界版本」变化触发重算，不是每帧（见 refreshTip）。
  // ⚠️ 世界版本必须算进来：树被砍掉/长回来是引擎侧发生的，少了它提示会停在过期状态
  const tipKey =
    `${Math.floor(p.x)},${Math.floor(p.y)}|${curTool.value}|${nearName.value}` +
    `|${eng.worldVersion()}`
  if (tipKey !== lastTipKey) {
    lastTipKey = tipKey
    refreshTip()
  }
  // HUD 的日期/时刻簇分两行显示（参考「小岛时光」）：上行「世界名 · 第 N 天」，
  // 下行「时段 HH:MM」。拆成两个 ref 而不是在模板里切字符串 —— 模板里做字符串
  // 处理，改一次格式就要同时改模板与这里，迟早对不上
  dayText.value = `第 ${c.day + 1} 天`
  timeText.value = `${phaseLabel(phaseOf(c.minuteOfDay))} ${formatTimeOfDay(c.minuteOfDay)}`
  // 时刻主要搭既有落盘的顺风车（跨格 / 关对话 / 离开页面）。但只靠顺风车不行：
  // 站着不动看风景半小时再关掉标签页，onBeforeUnmount 在硬刷新/关页时并不保证
  // 跑得到，下次进来世界时间就**倒流**回上一次存档。所以再补一道粗粒度的兜底，
  // 把损失封顶在 CLOCK_SAVE_MINUTES 内。默认流速下这是每 30 秒一次写，
  // 相比 NPC 漫游那 3 秒一次的节流可以忽略
  if (c.total - lastSavedMinutes >= CLOCK_SAVE_MINUTES) {
    lastSavedMinutes = c.total
    if (!rpg.pending) void rpg.save()
  }

  // 交互键一键两用：身边有人就说话，没人就对着脚边的东西动手。
  // 交谈优先 —— 站在树旁边的 NPC 更可能是你想搭话的对象
  if (eng.input.consumeInteract() && !rpg.talkingTo) {
    if (near) openTalk(near)
    else doHarvest()
  }
}

/**
 * 采集一次。
 *
 * 产出与刷新时长全部来自 harvest.ts 的规则表，这里只负责「把结果落到存档、
 * 告诉引擎这格变了、给玩家一个反馈」三件事。
 */
function doHarvest(): void {
  const eng = engine.value
  const w = rpg.current
  if (!eng || !w) return
  const t = eng.harvestTarget()
  if (!t) return
  if (!t.ready) {
    toast.error(`需要${toolName(t.rule.tool)}才行`)
    return
  }
  const key = cellKey(t.x, t.y)
  // 存的是**长回来的时刻**而不是采集时刻，见 RpgWorld.harvested 的说明
  const until = w.worldMinutes + t.rule.respawn
  harvestMap.set(key, until)
  w.harvested[key] = until
  const def = ITEMS[t.rule.item]
  w.items[t.rule.item] = (w.items[t.rule.item] ?? 0) + t.rule.count
  // 通行缓存与那一块网格都要跟着变，否则「看到的」与「走得过去的」会对不上
  eng.notifyWorldChanged(t.x, t.y)
  toast.success(`${def.icon} ${def.name} ×${t.rule.count}`)
  // 目标没了，提示气泡必须重算 —— 否则会一直提示去砍一棵已经没有的树
  lastTipKey = ''
  refreshTip()
  void rpg.save()
}

function openTalk(npc: RpgNpc) {
  // 对话期间冻结时钟：模型花的是现实时间，故事里你们只是交换了几句话。
  // 照现实走的话一次对话等于游戏里五小时，提示词里刚说的时段当场作废
  engine.value?.setClockPaused(true)
  rpg.openDialogue(npc)
  // 对话期间不让角色继续走：输入焦点在文本框里，但摇杆还可能被碰到
  engine.value?.input.setStick(0, 0)
  bar.value?.focus()
}

/**
 * ✕ 就是「不聊了」：还在生成就顺手掐掉。
 *
 * ⚠️ 不掐的话这条请求会继续占着 `gen.busy` —— 那是**全局**的，整个应用只有一个。
 * 而对话条一卸载「停止」按钮就跟着没了，玩家再没有任何入口去停它：表现是
 * 之后走到每个 NPC 面前都回「上一句还没说完」，连聊天页的输入框也一起变哑，
 * 且界面上找不到任何原因。已经流出来的字不会丢 —— 管线按 chatId 落库，
 * 中断会连同 stopped 标记一起写下去。
 */
function closeTalk() {
  if (rpg.pending) stopTalking()
  engine.value?.setClockPaused(false)
  rpg.closeDialogue()
  void rpg.save()
}

async function send(text: string) {
  const w = rpg.current
  const npc = rpg.talkingTo
  if (!w || !npc) return
  const me = w.persona.name.trim() || '我'
  rpg.lines.push({ who: 'player', name: me, text })
  const idx = rpg.lines.push({ who: 'npc', name: rpg.talkingName, text: '' }) - 1
  rpg.pending = true
  rpg.dialogueError = ''
  try {
    // 情境随对话带上:NPC 此刻在哪、在干什么,拼进提示词的【场景】
    const situation = engine.value?.npcStateText(npc.id)
    const r = await talkToNpc(
      w,
      npc,
      text,
      (t) => {
        const line = rpg.lines[idx]
        if (line) line.text = t
      },
      situation,
    )
    if (!r.ok) {
      rpg.dialogueError = r.error ?? '对话失败'
      // 没说出话就把空的那条抹掉，别在界面上留一条空白发言
      if (!r.text) rpg.lines.splice(idx, 1)
    }
  } finally {
    rpg.pending = false
    // 说完一句定额推进 —— 时钟虽然冻着，故事总得往前走一点
    engine.value?.addClockMinutes(TALK_MINUTES)
    // chatId 可能是这次才建的，存档要跟上
    void rpg.save()
  }
}

function onPad(x: number, y: number) {
  engine.value?.input.setStick(x, y)
}

/** 互动按钮 = 空格：身边有人就说话，没人就对脚边的东西动手 */
function onAct(): void {
  const eng = engine.value
  if (!eng || rpg.talkingTo) return
  const near = eng.nearNpc()
  if (near) openTalk(near)
  else doHarvest()
}

function placeNpc() {
  const eng = engine.value
  if (!eng) return
  // ⚠️ 先查上限再找落点。反过来的话，满编时用户会先收到「附近找不到能站人的
  // 地方」—— 一个**假原因**，他会跑去别处一遍遍试
  if (rpg.npcFull) {
    toast.error(`一个世界最多 ${NPC_MAX} 个 NPC，先删掉一个再放`)
    return
  }
  const p = eng.position()
  // 脚下未必能站人(浅水/房子里) —— 先找最近的有效落点
  const spot = eng.findNpcSpot(p.x, p.y)
  if (!spot) {
    toast.error('附近找不到能站人的地方')
    return
  }
  const npc = rpg.addNpc(spot.x, spot.y)
  if (!npc) return
  eng.setNpcs(rpg.current?.npcs ?? [])
  editorOpen.value = true
  const moved = spot.x !== Math.floor(p.x) || spot.y !== Math.floor(p.y)
  toast.success(moved ? '已放到最近的可站立位置' : '已在脚下放置一个 NPC')
}

function onNpcsChanged() {
  engine.value?.setNpcs(rpg.current?.npcs ?? [])
  void rpg.save()
}

/**
 * 重新推导某个 NPC 的作息。
 *
 * 由引擎来做而不是编辑器自己算：引擎手里才有 World，也只有它能把运行时的
 * 段号清掉让改动立刻生效（见 engine.rederiveRoutine 的说明）。
 */
function onRederive(id: string) {
  const r = engine.value?.rederiveRoutine(id)
  if (!r) {
    toast.error('这个 NPC 还没在世界里挂载，先回到世界里待一会儿')
    return
  }
  void rpg.save()
  toast.success(`已按当前位置重新推导：${ROUTINE_KIND_LABEL[r.kind]}`)
}

/**
 * HUD 快捷键：N = 身份面板，B = 背包 —— 按键提示芯片上写了什么，就必须真的能按，
 * 否则 UI 在撒谎。
 *
 * ⚠️ 正在输入时绝不抢键：对话框里打「n」不该弹出身份面板。带修饰键也放过，
 * 那些是浏览器/系统的快捷键。
 */
function onKey(e: KeyboardEvent): void {
  const k = e.key.toLowerCase()
  if (k !== 'n' && k !== 'b') return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const t = e.target as HTMLElement | null
  if (t && (t.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return
  if (rpg.talkingTo) return
  e.preventDefault()
  if (k === 'n') editorOpen.value = !editorOpen.value
  else bagOpen.value = !bagOpen.value
}
window.addEventListener('keydown', onKey)

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  // 同 closeTalk：离开本页后 RPG 侧再也没有停止入口，不掐就会把全局 busy
  // 一直占着，殃及聊天页
  if (rpg.pending) stopTalking()
  // 位置与 chatId 都要留住
  void rpg.save()
  engine.value?.dispose()
  engine.value = null
  if (import.meta.env.DEV) delete (globalThis as Record<string, unknown>)['__rpg']
  rpg.reset()
})
</script>

<template>
  <div class="page">
    <!-- 顶栏只留标题与抽屉入口：游戏控件全部挪进画面里的 HUD（参考「小岛时光」）-->
    <AppTopbar :title="rpg.current?.name ?? '世界'" />

    <div class="stage">
      <div ref="host" class="canvas-host" />

      <p v-if="booting" class="overlay">正在生成世界…</p>
      <p v-else-if="bootError" class="overlay overlay--err">⚠️ 渲染器启动失败：{{ bootError }}</p>

      <!-- ── 左上：日期 / 时刻簇 ── -->
      <div v-if="!booting && !bootError && dayText" class="hud hud--tl">
        <span class="hud__sun" aria-hidden="true">☀</span>
        <span class="hud__clock">
          <b class="hud__day">{{ dayText }}</b>
          <span class="hud__time">{{ timeText }}</span>
        </span>
      </div>

      <!-- ── 右上：胶囊按钮 ── -->
      <div v-if="!booting && !bootError" class="hud hud--tr">
        <!-- 满编就先灰掉：点了才被拒绝是最差的一种反馈 -->
        <button
          class="pill"
          :disabled="rpg.npcFull"
          :title="rpg.npcFull ? `已达上限 ${NPC_MAX} 个` : '在脚下放一个 NPC'"
          @click="placeNpc"
        >
          放 NPC
        </button>
        <button class="pill" @click="bagOpen = true">背包<kbd class="pill__key">B</kbd></button>
        <button class="pill" @click="editorOpen = true">身份<kbd class="pill__key">N</kbd></button>
        <!-- 后端不能藏掉 —— 它正是移动端回退路径 (?webgl=1) 唯一的观测点 -->
        <span v-if="backend" class="pill pill--flat">
          {{ backend === 'webgpu' ? 'WebGPU' : 'WebGL' }}
        </span>
      </div>

      <!-- ── 底部：上下文提示气泡（面前是什么 + 手里这件工具能做什么）── -->
      <div v-if="tip && !rpg.talkingTo" class="tip">{{ tip }}</div>

      <!-- ── 底部中央：工具快捷栏。数字键与点击等价 ── -->
      <nav v-if="!booting && !bootError && !rpg.talkingTo" class="hotbar">
        <button
          v-for="(t, i) in TOOLS"
          :key="t.id"
          class="slot"
          :class="{ 'slot--on': curTool === t.id }"
          :title="`${t.name}（按 ${i + 1}）`"
          @click="pickTool(t.id)"
        >
          <span class="slot__n">{{ i + 1 }}</span>
          <span class="slot__icon">{{ t.icon }}</span>
          <span class="slot__name">{{ t.name }}</span>
        </button>
      </nav>

      <!-- ── 右下：互动按钮（桌面与触屏都给，参考站即如此）── -->
      <button v-if="tip && !rpg.talkingTo" class="act" @click="onAct">
        互动<kbd class="act__key">空格</kbd>
      </button>

      <TouchPad v-if="!rpg.talkingTo" @move="onPad" />

      <Backpack v-if="bagOpen" :items="rpg.current?.items ?? {}" @close="bagOpen = false" />

      <DialogueBar
        v-if="rpg.talkingTo"
        ref="bar"
        @close="closeTalk"
        @send="send"
        @stop="stopTalking"
      />
    </div>

    <NpcEditor
      v-if="editorOpen"
      @close="editorOpen = false"
      @changed="onNpcsChanged"
      @rederive="onRederive"
    />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;

  /* ── cozy HUD 令牌（参考「小岛时光」，色值取自该站实测）──
     ⚠️ 刻意**写死字面值、不接 --cbx-***：全局是 ChatboxAI 设计系统且带明暗主题，
     而游戏 HUD 永远浮在明亮的世界之上；跟着暗色主题走会糊成一团看不清。
     作用域只到本页，聊天端的观感一个像素都不动。*/
  --rpg-cream: rgba(247, 245, 221, 0.93);
  --rpg-cream-light: rgba(255, 253, 240, 0.95);
  --rpg-ink: #244f4a;
  --rpg-green: #507f50;
  --rpg-green-soft: #93b075;
  --rpg-active: #fff5c4;
  --rpg-radius: 19px;
  --rpg-radius-sm: 11px;
  --rpg-radius-pill: 30px;
  /* 无模糊的硬投影是这套视觉的签名 —— 纸片/贴纸感，而不是常见的柔和浮起 */
  --rpg-shadow: 0 5px 0 rgba(71, 115, 84, 0.19);
  --rpg-shadow-sm: 0 4px 0 rgba(40, 95, 90, 0.12);
  --rpg-font: ui-rounded, 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
/* 舞台是定位上下文：canvas、摇杆、对话条、提示都 absolute 在它内部 */
.stage {
  /* 摇杆直径在这里定义、由 TouchPad 继承使用：靠近提示要抬到摇杆之上，
     两处尺寸必须同源，否则改了一边就会重新叠上去 */
  --rpg-pad-size: 112px;
  /* 快捷栏高度。提示气泡要抬到它之上，两处必须同源 */
  --rpg-hotbar-h: 74px;
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  /* 与场景背景同色：启动遮罩、渲染间隙都不露深色 */
  background: #ece9df;
}
.canvas-host {
  position: absolute;
  inset: 0;
  /* 画布上的手势自己处理，别让它变成滚页面 */
  touch-action: none;
  overscroll-behavior: contain;
}
.overlay {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  color: #6b6353;
  font-size: var(--cbx-fs-md);
  padding: var(--cbx-space-5);
  text-align: center;
}
.overlay--err {
  color: var(--cbx-warning);
}
/* ── HUD 通用 ── */
.hud {
  position: absolute;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--rpg-font);
  color: var(--rpg-ink);
  /* HUD 只是浮层，不该吃掉画布上的拖拽；内部可点元素各自再打开 */
  pointer-events: none;
}
.hud button {
  pointer-events: auto;
}
.hud--tl {
  left: max(14px, var(--cbx-safe-l, 0px));
  top: 12px;
}
.hud--tr {
  right: max(14px, var(--cbx-safe-r, 0px));
  top: 12px;
}

/* 左上：日期 / 时刻 */
.hud__sun {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--rpg-cream-light);
  box-shadow: var(--rpg-shadow-sm);
  font-size: 16px;
  line-height: 1;
}
.hud__clock {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  /* 直接压在世界上，用一点白描边保证在深色树冠上也读得清 */
  text-shadow:
    0 1px 0 rgba(255, 255, 255, 0.75),
    0 0 6px rgba(255, 255, 255, 0.5);
}
.hud__day {
  font-size: var(--cbx-fs-sm);
  font-weight: 700;
}
.hud__time {
  font-size: var(--cbx-fs-xs);
  opacity: 0.85;
}

/* 右上：胶囊按钮 */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--rpg-radius-sm);
  background: var(--rpg-cream);
  box-shadow: var(--rpg-shadow-sm);
  color: var(--rpg-ink);
  font-family: inherit;
  font-size: var(--cbx-fs-sm);
  font-weight: 700;
  white-space: nowrap;
  cursor: pointer;
}
.pill:hover:not(:disabled) {
  background: var(--rpg-cream-light);
}
/* 按下时把硬投影压掉并下沉 1px —— 贴纸被按到纸面上的手感 */
.pill:active:not(:disabled) {
  transform: translateY(3px);
  box-shadow: 0 1px 0 rgba(40, 95, 90, 0.12);
}
.pill:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.pill--flat {
  font-weight: 400;
  font-size: var(--cbx-fs-xs);
  opacity: 0.8;
  cursor: default;
}
.pill__key {
  padding: 1px 6px;
  border-radius: 6px;
  background: var(--rpg-active);
  box-shadow: inset 0 0 0 1px var(--rpg-green-soft);
  color: var(--rpg-green);
  font-family: inherit;
  font-size: var(--cbx-fs-xs);
  font-weight: 700;
}

/* 底部中央：上下文提示气泡 */
.tip {
  position: absolute;
  left: 50%;
  /* 抬到快捷栏之上 —— 参考站也是「提示在上、工具栏在下」 */
  bottom: calc(
    max(var(--cbx-space-4), var(--cbx-safe-b)) + var(--rpg-hotbar-h) + var(--cbx-space-2)
  );
  transform: translateX(-50%);
  z-index: 4;
  padding: 11px 22px;
  border-radius: var(--rpg-radius-pill);
  background: var(--rpg-cream-light);
  box-shadow: var(--rpg-shadow-sm);
  color: var(--rpg-ink);
  font-family: var(--rpg-font);
  font-size: var(--cbx-fs-sm);
  white-space: nowrap;
  pointer-events: none;
}

/* 底部中央：工具快捷栏 */
.hotbar {
  position: absolute;
  left: 50%;
  bottom: max(var(--cbx-space-4), var(--cbx-safe-b));
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  gap: 6px;
  padding: 8px;
  border-radius: var(--rpg-radius);
  border: 1px solid rgba(255, 252, 231, 0.9);
  background: var(--rpg-cream);
  box-shadow: var(--rpg-shadow);
  font-family: var(--rpg-font);
}
.slot {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  width: 58px;
  padding: 5px 3px;
  border: 2px solid transparent;
  border-radius: var(--rpg-radius-sm);
  background: rgba(255, 255, 255, 0.55);
  color: #4d6b51;
  font-family: inherit;
  font-size: var(--cbx-fs-xs);
  cursor: pointer;
}
/* 选中态：暖黄底 + 绿描边 + 外圈浅绿，与参考站一致 */
.slot--on {
  background: var(--rpg-active);
  border-color: var(--rpg-green);
  box-shadow: 0 0 0 2px var(--rpg-green-soft);
}
.slot__n {
  position: absolute;
  top: 1px;
  left: 5px;
  font-size: 10px;
  opacity: 0.55;
}
.slot__icon {
  font-size: 20px;
  line-height: 1.1;
}
.slot__name {
  font-weight: 700;
  white-space: nowrap;
}

/* 右下：互动按钮 */
.act {
  position: absolute;
  right: max(16px, var(--cbx-safe-r, 0px));
  bottom: max(var(--cbx-space-5), var(--cbx-safe-b));
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 13px 22px;
  border: 0;
  border-radius: var(--rpg-radius-pill);
  background: var(--rpg-cream);
  box-shadow: var(--rpg-shadow);
  color: var(--rpg-ink);
  font-family: var(--rpg-font);
  font-size: var(--cbx-fs-md);
  font-weight: 700;
  cursor: pointer;
}
.act:active {
  transform: translateY(4px);
  box-shadow: 0 1px 0 rgba(71, 115, 84, 0.19);
}
.act__key {
  padding: 2px 8px;
  border-radius: 7px;
  background: var(--rpg-active);
  box-shadow: inset 0 0 0 1px var(--rpg-green-soft);
  color: var(--rpg-green);
  font-family: inherit;
  font-size: var(--cbx-fs-xs);
  font-weight: 700;
}

@media (max-width: 767px) {
  /* 390px 下两个 HUD 簇会正面相撞（左簇右缘 ~111px，右簇宽 ~347px）。
     触屏本来就没有键盘，按键提示芯片在这里纯属占地方 —— 收掉它并收紧内边距，
     右簇就落回两百出头，两边不再打架 */
  .pill__key {
    display: none;
  }
  .pill {
    padding: 6px 9px;
    gap: 0;
    font-size: var(--cbx-fs-xs);
  }
  .hud--tl,
  .hud--tr {
    top: 8px;
  }
  .hud__sun {
    width: 26px;
    height: 26px;
    font-size: 14px;
  }
  /* 手机上左下是摇杆、右下是互动键，中间塞不下快捷栏 —— 整摞往上挪：
     摇杆/互动键一层，快捷栏在其上，提示气泡再在其上 */
  .hotbar {
    bottom: calc(
      max(var(--cbx-space-4), var(--cbx-safe-b)) + var(--rpg-pad-size) + var(--cbx-space-2)
    );
    padding: 6px;
    gap: 4px;
  }
  .slot {
    width: 50px;
  }
  .tip {
    bottom: calc(
      max(var(--cbx-space-4), var(--cbx-safe-b)) + var(--rpg-pad-size) + var(--rpg-hotbar-h) +
        var(--cbx-space-3)
    );
    font-size: var(--cbx-fs-xs);
  }
  .act {
    min-height: var(--cbx-tap-min);
  }
  .act__key {
    display: none;
  }
}
</style>
