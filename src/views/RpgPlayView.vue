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
import TouchPad from '@/components/rpg/TouchPad.vue'
import { useRpgStore } from '@/stores/rpg'
import { useCharactersStore } from '@/stores/characters'
import { useToast } from '@/composables/useToast'
import { createWorld } from '@/services/rpg/world'
import { createEngine, type EngineHandle } from '@/services/rpg/engine'
import { stopTalking, talkToNpc } from '@/services/rpg/dialogue'
import { resolveNpc, type RpgNpc } from '@/types/rpg'

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
const editorOpen = ref(false)

/** 玩家位置每帧都在变，但只有跨格时才值得落盘 —— 否则一秒写几十次 IDB */
let lastSavedTile = ''

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

  try {
    const world = createWorld({ width: w.width, height: w.height, seed: w.seed })
    const el = host.value
    if (!el) return
    const eng = await createEngine({
      world,
      host: el,
      npcs: w.npcs,
      ...(w.playerX >= 0 ? { start: { x: w.playerX, y: w.playerY } } : {}),
      // ?webgl=1 强制走 WebGL 后端。这个入参一直都在，只是从没接到视图层 ——
      // 于是移动端唯一会走的那条回退路径至今**没法验**
      ...(new URLSearchParams(location.search).get('webgl') === '1' ? { forceWebGL: true } : {}),
    })
    engine.value = eng
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

  // 靠近时按交互键
  if (eng.input.consumeInteract() && near && !rpg.talkingTo) openTalk(near)
}

function openTalk(npc: RpgNpc) {
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
    // chatId 可能是这次才建的，存档要跟上
    void rpg.save()
  }
}

function onPad(x: number, y: number) {
  engine.value?.input.setStick(x, y)
}

function placeNpc() {
  const eng = engine.value
  if (!eng) return
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

onBeforeUnmount(() => {
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
    <AppTopbar :title="rpg.current?.name ?? '世界'">
      <template #actions>
        <span v-if="backend" class="chip">{{ backend === 'webgpu' ? 'WebGPU' : 'WebGL' }}</span>
        <!-- 窄屏放不下全称：390px 下两颗全称按钮会把标题挤成一条缝 -->
        <button class="cbx-btn cbx-btn--ghost sm" @click="placeNpc">
          <span class="wide">在脚下放 NPC</span><span class="narrow">＋NPC</span>
        </button>
        <button class="cbx-btn cbx-btn--ghost sm" @click="editorOpen = true">
          <span class="wide">NPC 与身份</span><span class="narrow">身份</span>
        </button>
      </template>
    </AppTopbar>

    <div class="stage">
      <div ref="host" class="canvas-host" />

      <p v-if="booting" class="overlay">正在生成世界…</p>
      <p v-else-if="bootError" class="overlay overlay--err">⚠️ 渲染器启动失败：{{ bootError }}</p>

      <!-- 靠近 NPC 的提示。对话开着时不显示 -->
      <div v-if="nearName && !rpg.talkingTo" class="prompt">
        <strong>{{ nearName }}</strong>
        <span class="prompt__key">按 E / 空格 交谈</span>
        <button class="cbx-btn cbx-btn--primary sm talk-btn" @click="openTalk(engine!.nearNpc()!)">
          交谈
        </button>
      </div>

      <TouchPad v-if="!rpg.talkingTo" @move="onPad" />

      <DialogueBar
        v-if="rpg.talkingTo"
        ref="bar"
        @close="closeTalk"
        @send="send"
        @stop="stopTalking"
      />
    </div>

    <NpcEditor v-if="editorOpen" @close="editorOpen = false" @changed="onNpcsChanged" />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
/* 舞台是定位上下文：canvas、摇杆、对话条、提示都 absolute 在它内部 */
.stage {
  /* 摇杆直径在这里定义、由 TouchPad 继承使用：靠近提示要抬到摇杆之上，
     两处尺寸必须同源，否则改了一边就会重新叠上去 */
  --rpg-pad-size: 112px;
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
.prompt {
  position: absolute;
  left: 50%;
  bottom: max(var(--cbx-space-5), var(--cbx-safe-b));
  transform: translateX(-50%);
  z-index: 4;
  display: flex;
  align-items: center;
  gap: var(--cbx-space-3);
  padding: var(--cbx-space-2) var(--cbx-space-4);
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  white-space: nowrap;
}
.prompt__key {
  font-size: var(--cbx-fs-xs);
  opacity: 0.8;
}
.chip {
  padding: 0 var(--cbx-space-2);
  border-radius: var(--cbx-radius-pill);
  background: var(--cbx-bg-secondary);
  font-size: var(--cbx-fs-xs);
  color: var(--cbx-text-secondary);
}
.narrow {
  display: none;
}

/* 桌面用键盘，不需要那颗按钮；触屏没有键盘，必须给 */
@media (hover: hover) and (pointer: fine) {
  .talk-btn {
    display: none;
  }
}
@media (max-width: 767px) {
  .prompt__key {
    display: none;
  }
  .talk-btn {
    min-height: var(--cbx-tap-min);
  }
  /* 手机上摇杆就在左下角，居中的提示条会压在它上面 —— 抬到摇杆之上 */
  .prompt {
    bottom: calc(
      max(var(--cbx-space-4), var(--cbx-safe-b)) + var(--rpg-pad-size) + var(--cbx-space-3)
    );
  }
  .wide {
    display: none;
  }
  .narrow {
    display: inline;
  }
}
</style>
