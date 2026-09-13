<script setup lang="ts">
/**
 * 世界缩略预览。
 *
 * 采样器是纯函数、只依赖 simplex-noise 与 hash，**不碰 three.js** —— 所以这张图
 * 不用建任何几何体，也不用 WebGPU 上下文，在地图还没渲染过一帧的时候就能画出来。
 *
 * ⚠️ 两条都是给移动端准备的：
 * 1. 采样点固定 128×128，**与世界大小解耦** —— 288² 的世界不会比 192² 的慢，
 *    拖滑块的手感在所有尺寸下一致。放大交给 CSS（image-rendering: pixelated）。
 * 2. **分帧渲染**：每帧画 16 行就让出去。不这么做的话，整张图在中端手机上是一次
 *    200~400ms 的长任务，表现为「拖滑块时滑块自己卡住」—— 桌面上完全看不出来。
 *    换参数时用一个自增令牌作废在途的那一趟，比防抖更跟手。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { createWorld, findSpawn, worldParamsOf, type Village } from '@/services/rpg/world'
import { REGION_TINT, TERRAIN, tintOf } from '@/services/rpg/palette'
import type { RpgGenParams } from '@/types/rpg'

const props = defineProps<{
  seed: number
  width: number
  height: number
  gen: RpgGenParams
}>()

/** 采样分辨率。128 已经能看出海岸线与大区划分，再高只是烧 CPU */
const PREVIEW_N = 128
/** 每帧画多少行 */
const BAND = 16

const canvas = ref<HTMLCanvasElement | null>(null)
const rendering = ref(false)
const stats = shallowRef<{ land: number; water: number; villages: number } | null>(null)
const villages = shallowRef<readonly Village[]>([])
const spawn = shallowRef<{ x: number; y: number } | null>(null)

/** 自增令牌：参数一变就作废在途的那一趟渲染 */
let token = 0
let raf = 0

const landPct = computed(() => (stats.value ? Math.round(stats.value.land * 100) : 0))
const waterPct = computed(() => (stats.value ? Math.round(stats.value.water * 100) : 0))

async function render(): Promise<void> {
  const el = canvas.value
  if (!el) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  const mine = ++token
  rendering.value = true

  const world = createWorld(
    worldParamsOf({ seed: props.seed, width: props.width, height: props.height, gen: props.gen }),
  )
  const img = ctx.createImageData(PREVIEW_N, PREVIEW_N)
  const sx = props.width / PREVIEW_N
  const sy = props.height / PREVIEW_N
  let land = 0
  let water = 0

  // 生态色。与实际进游戏看到的同一套调色板，否则预览没有参考价值
  const put = (i: number, c: { r: number; g: number; b: number }, shade: number) => {
    img.data[i] = Math.min(255, c.r * 255 * shade)
    img.data[i + 1] = Math.min(255, c.g * 255 * shade)
    img.data[i + 2] = Math.min(255, c.b * 255 * shade)
    img.data[i + 3] = 255
  }

  for (let row = 0; row < PREVIEW_N; row += BAND) {
    for (let py = row; py < Math.min(row + BAND, PREVIEW_N); py++) {
      for (let px = 0; px < PREVIEW_N; px++) {
        const wx = Math.floor(px * sx)
        const wy = Math.floor(py * sy)
        const b = world.biomeAt(wx, wy)
        const lv = world.sampler.levelAt(wx, wy)
        const i = (py * PREVIEW_N + px) * 4
        if (b === 0) {
          put(i, TERRAIN.waterDeep, 1)
          water++
        } else if (b === 1) {
          put(i, TERRAIN.waterShallow, 1)
          water++
        } else if (world.pathAt(wx, wy) || world.roadAt(wx, wy)) {
          // 村道 + 村庄之间的大路：陶土色，让路网在缩略图上也看得见
          put(i, TERRAIN.path, 1)
          land++
        } else if (b === 2) {
          put(i, TERRAIN.sand, 1)
          land++
        } else {
          // 用台阶等级做明暗，地势才看得出来；再按生态分区染色，森林/草甸/干草原分得开
          const g0 = TERRAIN.grassLevels[Math.max(0, Math.min(8, lv))] ?? TERRAIN.grassLevels[0]
          const tint = REGION_TINT[world.regionAt(wx, wy) as 'forest' | 'meadow' | 'wilds']
          const g = g0 && tint ? tintOf(g0, tint) : g0
          if (g) put(i, g, 1)
          land++
        }
      }
    }
    ctx.putImageData(img, 0, 0)
    // 让出一帧；回来时若已被新参数作废就直接退出
    await new Promise<void>((r) => {
      raf = requestAnimationFrame(() => r())
    })
    if (mine !== token) return
  }

  const vs = world.listVillages()
  villages.value = vs
  spawn.value = findSpawn(world)
  const total = PREVIEW_N * PREVIEW_N
  stats.value = { land: land / total, water: water / total, villages: vs.length }
  rendering.value = false
}

// ⚠️ 首绘走 onMounted 而不是 watch 的 immediate：immediate 的回调在 setup 期间
// 同步执行，那时模板 ref 还是 null，render() 会直接 early-return 且**永不重试** ——
// 表现为一张永远空白的预览图
onMounted(() => void render())
watch(
  () => [props.seed, props.width, props.height, { ...props.gen }] as const,
  () => void render(),
  { deep: true },
)

onBeforeUnmount(() => {
  token++
  if (raf) cancelAnimationFrame(raf)
})

/** 村庄/出生点的叠加标记按百分比定位，跟着 canvas 一起缩放 */
function pct(v: number, span: number): string {
  return `${(v / span) * 100}%`
}
</script>

<template>
  <div class="wrap">
    <div class="map">
      <canvas ref="canvas" :width="PREVIEW_N" :height="PREVIEW_N" />
      <span
        v-for="(v, i) in villages"
        :key="i"
        class="dot dot--village"
        :style="{ left: pct(v.cx, width), top: pct(v.cy, height) }"
        :title="`村庄 (${v.cx}, ${v.cy})`"
      />
      <span
        v-if="spawn"
        class="dot dot--spawn"
        :style="{ left: pct(spawn.x, width), top: pct(spawn.y, height) }"
        title="出生点"
      />
      <span v-if="rendering" class="busy">绘制中…</span>
    </div>
    <p class="read">
      陆地 {{ landPct }}% · 水域 {{ waterPct }}% ·
      <strong :class="{ warn: stats?.villages === 0 }">村庄 {{ stats?.villages ?? 0 }} 座</strong>
    </p>
    <p v-if="stats?.villages === 0" class="cbx-field__hint warn">
      这个种子/密度下没有村庄。可以照常创建，但与村庄绑定的 NPC 落点会退回出生点附近。
    </p>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-2);
}
.map {
  position: relative;
  width: 100%;
  max-width: 320px;
  aspect-ratio: 1;
  border-radius: var(--cbx-radius-md);
  overflow: hidden;
  border: 1px solid var(--cbx-border);
  background: var(--cbx-bg-secondary);
}
.map canvas {
  width: 100%;
  height: 100%;
  display: block;
  /* 128² 放大到 320px：保持硬像素，插值会糊成一团看不出海岸线 */
  image-rendering: pixelated;
}
.dot {
  position: absolute;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
}
.dot--village {
  background: #c0392b;
  box-shadow: 0 0 0 1.5px rgba(255, 255, 255, 0.85);
}
.dot--spawn {
  width: 9px;
  height: 9px;
  background: var(--cbx-brand);
  box-shadow: 0 0 0 2px #fff;
}
.busy {
  position: absolute;
  right: var(--cbx-space-2);
  bottom: var(--cbx-space-2);
  padding: 0 var(--cbx-space-2);
  border-radius: var(--cbx-radius-pill);
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: var(--cbx-fs-xs);
}
.read {
  margin: 0;
  font-size: var(--cbx-fs-sm);
  color: var(--cbx-text-secondary);
}
.warn {
  color: var(--cbx-warning-hover);
}
</style>
