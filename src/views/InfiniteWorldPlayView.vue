<script setup lang="ts">
import AppIcon from '@/components/icons/AppIcon.vue'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import NpcChatPanel from '@/components/infinite-world/NpcChatPanel.vue'
import { useInfiniteWorldStore } from '@/stores/infiniteWorld'
import { gameworldsRepo } from '@/db/repositories'
import { validateSave } from '@/services/infinite-world/validation'
import { toPlain } from '@/utils/plain'
import { useToast } from '@/composables/useToast'
import { confirmDialog } from '@/composables/useConfirm'
import type { NpcBlueprint, WorldSave } from '@/types/infiniteWorld'
import type { WorldMoment } from '@/services/infinite-world/dialogue/worldDialogue'
import { applyReward } from '@/services/infinite-world/dialogue/relationRules'
import type { WorldSceneHandle } from '@/services/infinite-world/rendering/worldScene'
import { dayPhase, DAY_PHASE_LABEL } from '@/services/infinite-world/simulation/dayNight'

const route = useRoute(), router = useRouter(), worlds = useInfiniteWorldStore(), toast = useToast()
const host = ref<HTMLElement | null>(null)
const ready = ref(false), loading = ref(true), error = ref(''), saving = ref(false), panel = ref<'bag' | 'residents' | null>(null), paused = ref(false)
const summary = ref<WorldSave | null>(null)
/** 交谈范围内最近的居民（来自场景 summary） */
const nearNpc = ref<{ id: string; name: string } | null>(null)
/** 正在交谈的居民蓝图；非空即打开对话面板并暂停世界 */
const talking = ref<NpcBlueprint | null>(null)
const world = computed(() => worlds.active)
const moment = computed<WorldMoment>(() => ({
  day: summary.value?.day ?? 1,
  minute: summary.value?.minute ?? 0,
  weather: summary.value?.weather ?? 'clear',
}))
const dayText = computed(() => {
  const s = summary.value
  return s ? '第 ' + s.day + ' 天 · ' + String(Math.floor(s.minute / 60)).padStart(2, '0') + ':' + String(Math.floor(s.minute % 60)).padStart(2, '0') : ''
})
const pauseText = computed(() => paused.value ? '继续探索' : '暂停')
const phase = computed(() => dayPhase(summary.value?.minute ?? 420))
const message = ref('')
let runtime: WorldSceneHandle | null = null, interval: ReturnType<typeof setInterval> | null = null
let mounted = true, generation = 0, pendingSave: Promise<boolean> | null = null, discard = false

function syncPause() { runtime?.pause(paused.value || !!panel.value || !!talking.value || !!error.value || document.hidden) }
watch([paused, panel, error, talking], syncPause)
/** 走到最近居民跟前开始交谈 */
function talk() {
  if (paused.value || panel.value || error.value || talking.value) return
  const near = runtime?.nearestNpc() ?? nearNpc.value
  if (!near || !world.value) return
  const npc = world.value.npcs.find((n) => n.npcId === near.id)
  if (npc) talking.value = npc
}
/**
 * 关系回写：把交谈奖励并入**内存里的**世界关系（响应式，居民面板与下次对话即时反映）。
 * ⚠️ 暂不落盘：持久化要过存档乐观锁，与自动存档同写一行会冲突，留作后续。
 */
function onReward(delta: { dScore: number; dTrust: number }) {
  if (!world.value || !talking.value) return
  applyReward(world.value, talking.value.npcId, delta)
}
async function start(id: string) {
  const token = ++generation
  loading.value = true; ready.value = false; error.value = ''; discard = false
  try {
    const opened = await worlds.open(id)
    if (!mounted || token !== generation) return
    if (!opened) throw new Error('此世界不存在或已被删除。')
    if (!worlds.save) throw new Error('找不到世界存档，请尝试恢复备份。')
    const progress = toPlain(worlds.save)
    validateSave(progress, opened)
    summary.value = progress
    await nextTick()

    const { SUPPORTED_GENERATOR_VERSIONS } = await import('@/services/infinite-world/generation/pipeline')
    // ⚠️ 老世界（terrain-1 / dual-grid-0.1）是 WORLD_LIMIT=100000 的无限平面，
    // 而新渲染器是为 512×512 环面建的。把无限平面塞进环面必然挪动房屋与树木 ——
    // 那正是「不能用新噪声默默重建旧存档」要避免的失败方式。
    // 所以这里**拦截**而不是硬着头皮渲染，并给出导出这条退路。
    if (!SUPPORTED_GENERATOR_VERSIONS.some(v => v === opened.generatorVersion)) {
      throw new Error(
        '这个世界由旧版地图生成器（' + opened.generatorVersion + '）创建。\n' +
        '新版地图是固定 512×512 的环面，无法原样迁移 —— 强行载入会让房屋和树木整体移位。\n' +
        '你可以在「数据管理」里导出这个存档，或用相同的世界观与居民创建一个新世界。',
      )
    }

    const { buildWorldAsync } = await import('@/services/infinite-world/generation/worldSource')
    const grid = await buildWorldAsync({
      seed: opened.seed,
      settings: opened.settings,
      generatorVersion: opened.generatorVersion,
      onProgress: (step) => { if (mounted && token === generation) message.value = step + '…' },
    })
    if (!mounted || token !== generation || !host.value) return

    const { mountWorldScene } = await import('@/services/infinite-world/rendering/worldScene')
    if (!mounted || token !== generation || !host.value) return
    const instance = await mountWorldScene({
      host: host.value,
      grid,
      save: progress,
      npcs: opened.npcs,
      dayMinutes: opened.settings.dayMinutes,
      forceWebGL: route.query.renderer === 'webgl',
      onSummary: (s) => {
        if (!mounted || token !== generation) return
        summary.value = { ...progress, day: s.day, minute: s.minute, playerPosition: [s.x, s.y] }
        nearNpc.value = s.nearNpcId ? { id: s.nearNpcId, name: s.nearNpcName ?? '居民' } : null
      },
      onMessage: (text) => { message.value = text },
      onDeviceLost: (reason) => { error.value = 'GPU 设备丢失：' + reason },
    })
    message.value = ''
    if (!mounted || token !== generation) { instance.dispose(); return }
    runtime = instance; ready.value = true; syncPause()
  } catch (e) { if (mounted && token === generation) error.value = e instanceof Error ? e.message : String(e) }
  finally { if (mounted && token === generation) loading.value = false }
}
async function persist(): Promise<boolean> {
  if (!runtime || discard) return true
  // Serialize saves; capture after any previous transaction so its revision is current.
  while (pendingSave) { if (!await pendingSave) return false }
  if (!runtime) return true
  const scene = runtime
  saving.value = true
  const task = (async () => {
    try {
      const saved = await gameworldsRepo.saveProgress(scene.snapshot())
      scene.revision(saved.revision)
      if (runtime === scene) {
        summary.value = scene.snapshot()
        worlds.save = saved
        error.value = ''
      }
      return true
    } catch (e) {
      if (runtime === scene) { error.value = e instanceof Error ? e.message : String(e); scene.pause(true) }
      return false
    }
  })()
  pendingSave = task
  try { return await task }
  finally { if (pendingSave === task) { pendingSave = null; saving.value = false } }
}
async function manualSave() { if (await persist()) toast.success('世界进度已保存') }
async function leaveWithoutSaving() {
  if (!await confirmDialog({ text: '放弃当前未保存的移动进度并离开？最近一次成功存档会保留。' })) return
  discard = true
  await router.push('/game-worlds')
}
async function reloadSave() {
  if (!await confirmDialog({ text: '重新读取最近一次成功存档？当前未保存的移动进度将丢弃。' })) return
  discard = true; runtime?.dispose(); runtime = null
  if (pendingSave) await pendingSave
  await start(String(route.params.id))
}
function stopMoving() { runtime?.direction(0, 0) }
function startMoving(e: PointerEvent, x: number, y: number) {
  if (paused.value || panel.value || error.value) return
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  runtime?.direction(x, y)
}
function visibility() { syncPause(); if (document.hidden && runtime && !error.value) void persist() }
function shortcut(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (e.key.toLowerCase() === 'b') panel.value = panel.value === 'bag' ? null : 'bag'
  if (e.key.toLowerCase() === 'e') talk()
  if (e.key === 'Escape') { if (talking.value) talking.value = null; else if (panel.value) panel.value = null; else paused.value = !paused.value }
}
onMounted(() => {
  void start(String(route.params.id))
  document.addEventListener('visibilitychange', visibility)
  window.addEventListener('keydown', shortcut)
  interval = setInterval(() => { if (runtime && !error.value && !document.hidden && !saving.value) void persist() }, 30_000)
})
onBeforeRouteLeave(async () => {
  runtime?.pause(true)
  return await persist()
})
onBeforeRouteUpdate(async (to) => {
  runtime?.pause(true)
  if (!await persist()) return false
  runtime?.dispose(); runtime = null
  await start(String(to.params.id))
})
onUnmounted(() => {
  mounted = false; generation++
  runtime?.dispose(); runtime = null
  if (interval) clearInterval(interval)
  document.removeEventListener('visibilitychange', visibility)
  window.removeEventListener('keydown', shortcut)
})
</script>

<template>
  <AppTopbar :title="world?.name ?? '无限世界'">
    <template #actions><button class="cbx-btn cbx-btn--ghost" :disabled="saving" @click="router.push('/game-worlds')">保存并离开</button></template>
  </AppTopbar>
  <div class="play">
    <div ref="host" class="scene" />
    <div v-if="loading" class="center-card">正在铺开这片世界…</div>
    <div v-if="error" class="center-card error" role="alert">
      <p>{{ error }}</p>
      <div class="actions"><button v-if="runtime" class="cbx-btn cbx-btn--soft" :disabled="saving" @click="manualSave">重试保存</button><button class="cbx-btn cbx-btn--ghost" @click="reloadSave">重新读取存档</button><button v-if="ready" class="cbx-btn cbx-btn--ghost" :disabled="saving" @click="leaveWithoutSaving">放弃未保存进度并离开</button><button v-else class="cbx-btn cbx-btn--ghost" @click="router.push('/game-worlds')">返回列表</button></div>
    </div>
    <template v-if="ready && world && summary">
      <div class="hud time" :data-phase="phase">
        <div class="time-heading"><strong>{{ dayText }}</strong><span class="time-phase"><AppIcon :name="phase === 'night' ? 'Moon' : 'Sun'" :size="16" /> {{ DAY_PHASE_LABEL[phase] }}</span></div>
        <span>{{ ['春', '夏', '秋', '冬'][world.settings.season] }} · {{ summary.weather === 'clear' ? '晴' : summary.weather === 'storm' ? '雷雨' : '雨' }}</span>
        <div class="time-track" role="progressbar" aria-label="一天的进度" :aria-valuemin="0" :aria-valuemax="1440" :aria-valuenow="summary.minute" :aria-valuetext="dayText"><i :style="{ left: `${summary.minute / 1440 * 100}%` }" /></div>
      </div>
      <div class="hud player-info"><strong>{{ world.player.name }}</strong><span>{{ world.player.identity || '旅行者' }}</span><span>体力 {{ summary.stamina }} / 100 · 金币 {{ summary.money }}</span></div>
      <div class="hud toolbar"><button @click="paused = !paused">{{ pauseText }}</button><button @click="panel = panel === 'bag' ? null : 'bag'">背包</button><button @click="panel = panel === 'residents' ? null : 'residents'">居民</button><button :disabled="saving" @click="manualSave">{{ saving ? '保存中…' : '保存进度' }}</button></div>
      <p class="hud guide">WASD / 方向键移动 · 走近居民按 E 交谈 · B 背包 · Esc 暂停<br />每 30 秒自动保存 · {{ message || '沿着主路走过河桥，看看更远处的森林。' }}</p>
      <div class="touch-pad" aria-label="移动控制">
        <button aria-label="向上移动" @pointerdown.prevent="startMoving($event, 0, -1)" @pointerup="stopMoving" @pointercancel="stopMoving" @lostpointercapture="stopMoving"><AppIcon name="ArrowUp" /></button>
        <button aria-label="向左移动" @pointerdown.prevent="startMoving($event, -1, 0)" @pointerup="stopMoving" @pointercancel="stopMoving" @lostpointercapture="stopMoving"><AppIcon name="ArrowLeft" /></button>
        <button aria-label="向下移动" @pointerdown.prevent="startMoving($event, 0, 1)" @pointerup="stopMoving" @pointercancel="stopMoving" @lostpointercapture="stopMoving"><AppIcon name="ArrowDown" /></button>
        <button aria-label="向右移动" @pointerdown.prevent="startMoving($event, 1, 0)" @pointerup="stopMoving" @pointercancel="stopMoving" @lostpointercapture="stopMoving"><AppIcon name="ArrowRight" /></button>
      </div>
      <button
        v-if="nearNpc && !talking && !panel && !paused"
        class="interact"
        @click="talk"
      >按 E 与 {{ nearNpc.name }} 交谈</button>
      <div v-if="paused && !panel && !error" class="center-card"><p>世界已暂停</p><button class="cbx-btn cbx-btn--soft" @click="paused = false">继续探索</button></div>
      <div v-if="panel" class="panel-mask" @click.self="panel = null">
        <section class="panel cbx-card">
          <div class="actions"><h2>{{ panel === 'bag' ? '背包' : '世界居民' }}</h2><button class="cbx-btn cbx-btn--ghost" @click="panel = null">关闭</button></div>
          <template v-if="panel === 'bag'"><p v-if="!Object.keys(summary.inventory).length">背包还是空的。采集与农业将在后续玩法中开放。</p><p v-for="(n, id) in summary.inventory" :key="id">{{ id }} × {{ n }}</p></template>
          <template v-else><p v-if="!world.npcs.length">这片世界暂时没有居民。</p><article v-for="npc in world.npcs" :key="npc.npcId"><h3>{{ npc.name }} · {{ npc.profession }}</h3><p>{{ npc.cardSnapshot?.personality || '一位定居在此的居民。' }}</p></article><p class="hint">目前可探索地形、保存进度和管理居民设定，居民日程与交谈将在后续开放。</p></template>
        </section>
      </div>
      <NpcChatPanel
        v-if="talking && world"
        :npc="talking"
        :world="world"
        :moment="moment"
        @reward="onReward"
        @close="talking = null"
      />
    </template>
  </div>
</template>

<style scoped>
.play { flex: 1; min-height: 0; position: relative; overflow: hidden; background: #c3cbb0; }
.scene { position: absolute; inset: 0; }
.hud { position: absolute; padding: 12px 16px; border: 1px solid #fff7dbaa; border-radius: 14px; color: #3c5043; background: #fff9e9ed; box-shadow: 0 4px 16px #354a3b1a; font-size: 13px; }
.interact {
  position: absolute;
  left: 50%;
  bottom: 128px;
  transform: translateX(-50%);
  padding: 10px 20px;
  min-height: 44px;
  border: 0;
  border-radius: 22px;
  color: #fff;
  background: var(--cbx-brand);
  box-shadow: 0 6px 20px #354a3b33;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  animation: interact-pop 1.4s ease-in-out infinite;
}
@keyframes interact-pop { 50% { transform: translateX(-50%) translateY(-3px); } }
.time { top: 20px; left: 20px; display: grid; gap: 4px; }
.time-heading { display: flex; align-items: center; gap: 16px; }
.time-phase { font-size: 11px; opacity: .85; }
.time[data-phase="night"] { color: #e1e8f0; background: #25364ae8; border-color: #a3bed26b; }
.time[data-phase="dawn"], .time[data-phase="dusk"] { background: #f4dfc6ed; border-color: #dfb27eaa; }
.time-track { position: relative; height: 4px; margin-top: 6px; border-radius: 4px; background: linear-gradient(90deg, #354b76 0% 18%, #e9a976 27%, #f7df99 38% 65%, #cd855f 77%, #354b76 87%); }
.time-track i { position: absolute; top: -2px; width: 8px; height: 8px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px #fff8; transform: translateX(-50%); }
.player-info { top: 20px; right: 20px; display: grid; gap: 4px; }
.toolbar { bottom: 92px; left: 20px; display: flex; gap: 12px; }
.toolbar button { border: 0; color: inherit; background: transparent; cursor: pointer; font: inherit; }
.guide { bottom: 16px; left: 20px; line-height: 1.7; max-width: calc(100% - 220px); pointer-events: none; }
.touch-pad { position: absolute; bottom: 24px; right: 24px; display: grid; grid-template-columns: repeat(3, 42px); gap: 4px; }
.touch-pad button { height: 42px; border: 1px solid #fff7dbaa; border-radius: 12px; background: #fff9e9df; color: #3c5043; font-size: 20px; touch-action: none; user-select: none; }
.touch-pad button:first-child { grid-column: 2; }.touch-pad button:nth-child(2) { grid-column: 1; }
.center-card { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); max-width: calc(100% - 32px); width: max-content; padding: 24px; background: var(--cbx-bg); color: var(--cbx-text); border-radius: 16px; box-shadow: 0 8px 40px #30433333; display: grid; gap: 16px; z-index: 3; }
.error { color: var(--cbx-danger); }
.actions { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
.panel-mask { position: absolute; inset: 0; background: #1c362b44; display: grid; place-items: center; z-index: 2; padding: 16px; }
.panel { width: min(520px, 100%); max-height: 85%; overflow: auto; display: grid; gap: 20px; }
.panel article { padding-bottom: 12px; border-bottom: 1px solid var(--cbx-border); }
.hint { color: var(--cbx-text-secondary); }
@media (max-width: 767px) { .time { top: 12px; left: 12px; } .player-info { top: 90px; left: 12px; right: auto; } .toolbar { left: 12px; bottom: 120px; padding: 12px; gap: 8px; } .guide { left: 12px; bottom: 12px; max-width: calc(100% - 162px); font-size: 11px; padding: 8px; } .touch-pad { right: 12px; bottom: 12px; } }
</style>
