<script setup lang="ts">
/**
 * 世界地图选点。
 *
 * ## ⚠️ 必须用 <canvas> + 一次性 ImageData，不能用 span 网格
 * 旧预览用 `<span>` 做 CSS grid。512×512 会变成 26 万个 DOM 节点 ——
 * 这不是「优化」问题而是「可行性」问题：每拖一下滑杆重建一次就直接卡死。
 * 这里把整张地形一次 `putImageData` 画进画布，标记用 2D 画笔叠一层，零 DOM。
 *
 * ## 只让落在**主连通域且可通行**的点当出生点
 * 512×512 里手打坐标几乎必然不可通行（湖里、林子里、被树围死的小口袋）。
 * 点选时就近吸附到最近的合法格；找不到就忽略这一下，不给一个走不了的出生点。
 *
 * 受控组件：出生点由父层用 v-model 管，本组件只负责画和吸附。
 */
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { Flag, type WorldGrid } from '@/services/infinite-world/generation/grid'
import { TERRAIN_COLORS } from '@/services/infinite-world/generation/terrain'
import { BIOMES } from '@/types/infiniteWorld'

const props = defineProps<{
  /** 已生成的网格（shallow，不要被 Vue 深度代理） */
  grid: WorldGrid | null
  /** 当前出生点（世界格坐标） */
  spawn: [number, number]
  /** NPC 家的位置标记（可选） */
  homes?: { id: string; name: string; pos: [number, number] }[]
  /** 只读（编辑已有世界时地图参数不可改） */
  disabled?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:spawn', value: [number, number]): void
}>()

/** 画布内部分辨率。512/256 = 每像素 2 格 */
const PX = 256
const SCALE = WORLD_SIZE / PX

const canvas = ref<HTMLCanvasElement | null>(null)
/** 底图（地形）离屏缓存，只在 grid 变时重画一次；标记每帧叠在它上面 */
const base = shallowRef<ImageData | null>(null)

function idx(x: number, y: number): number {
  const wx = ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  const wy = ((y % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  return wy * WORLD_SIZE + wx
}

/** 把整张地形烤成一张 ImageData —— 一次，之后只在 grid 变时重来 */
function bakeBase(grid: WorldGrid): ImageData {
  const img = new ImageData(PX, PX)
  const d = img.data
  for (let py = 0; py < PX; py++) {
    for (let px = 0; px < PX; px++) {
      const i = idx(Math.floor(px * SCALE), Math.floor(py * SCALE))
      const hex = TERRAIN_COLORS[grid.biome[i]!] ?? TERRAIN_COLORS[BIOMES.indexOf('wild')]!
      const r = parseInt(hex.slice(1, 3), 16)
      const g = parseInt(hex.slice(3, 5), 16)
      const b = parseInt(hex.slice(5, 7), 16)
      // 不可通行处压暗一档，让能走的区域一眼可辨
      const walk = (grid.flags[i]! & Flag.Walkable) !== 0
      const k = walk ? 1 : 0.72
      const o = (py * PX + px) * 4
      d[o] = r * k
      d[o + 1] = g * k
      d[o + 2] = b * k
      d[o + 3] = 255
    }
  }
  return img
}

/** 世界格 → 画布像素中心 */
function worldToPx(x: number, y: number): [number, number] {
  return [(x / SCALE), (y / SCALE)]
}

/** 就近吸附到最近的「主连通域 + 可通行」格；找不到返回 null */
function snapValid(x: number, y: number): [number, number] | null {
  const grid = props.grid
  if (!grid) return null
  const main = grid.mainRegion
  for (let r = 0; r <= 24; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const wx = ((Math.round(x) + dx) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE
        const wy = ((Math.round(y) + dy) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE
        const i = wy * WORLD_SIZE + wx
        if (grid.region[i] !== main) continue
        if (!(grid.flags[i]! & Flag.Walkable)) continue
        if (grid.flags[i]! & Flag.Building) continue
        return [wx, wy]
      }
    }
  }
  return null
}

/** 推荐出生点：每个镇的镇口各取一个（最多 3 个） */
const recommended = computed<{ label: string; pos: [number, number] }[]>(() => {
  const grid = props.grid
  if (!grid) return []
  const out: { label: string; pos: [number, number] }[] = []
  for (const t of grid.towns) {
    const p = snapValid(t.cx, t.cy)
    if (p) out.push({ label: t.name || '聚落', pos: p })
    if (out.length >= 3) break
  }
  return out
})

function paint() {
  const el = canvas.value
  const img = base.value
  if (!el || !img) return
  const ctx = el.getContext('2d')
  if (!ctx) return
  ctx.putImageData(img, 0, 0)

  // NPC 家：小方点
  ctx.lineWidth = 1
  for (const h of props.homes ?? []) {
    const [hx, hy] = worldToPx(h.pos[0], h.pos[1])
    ctx.fillStyle = 'rgba(200,150,60,0.95)'
    ctx.fillRect(hx - 2, hy - 2, 4, 4)
  }

  // 推荐点：空心圈
  for (const rec of recommended.value) {
    const [rx, ry] = worldToPx(rec.pos[0], rec.pos[1])
    ctx.beginPath()
    ctx.arc(rx, ry, 4, 0, Math.PI * 2)
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // 出生点：实心 + 光环
  const [sx, sy] = worldToPx(props.spawn[0], props.spawn[1])
  ctx.beginPath()
  ctx.arc(sx, sy, 6, 0, Math.PI * 2)
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(sx, sy, 3.2, 0, Math.PI * 2)
  ctx.fillStyle = '#e0533a'
  ctx.fill()
}

function onPointer(ev: PointerEvent) {
  if (props.disabled) return
  const el = canvas.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  // 画布 CSS 尺寸 → 内部像素 → 世界格
  const px = ((ev.clientX - rect.left) / rect.width) * PX
  const py = ((ev.clientY - rect.top) / rect.height) * PX
  const snapped = snapValid(px * SCALE, py * SCALE)
  if (snapped) emit('update:spawn', snapped)
}

function rebake() {
  base.value = props.grid ? bakeBase(props.grid) : null
  paint()
}

onMounted(rebake)
watch(() => props.grid, rebake)
watch([() => props.spawn, () => props.homes, recommended], paint, { deep: true })
</script>

<template>
  <div class="picker">
    <canvas
      ref="canvas"
      :width="PX"
      :height="PX"
      class="map"
      :class="{ empty: !grid }"
      @pointerdown="onPointer"
    />
    <p v-if="!grid" class="placeholder">正在铺开这片世界…</p>
    <template v-else>
      <p v-if="disabled" class="hint">已创建世界的出生点不可修改。</p>
      <p v-else class="hint">在地图上点选一个可通行的位置作为出生点，或从推荐点里挑一个。</p>
      <div v-if="recommended.length && !disabled" class="chips">
        <button
          v-for="rec in recommended"
          :key="rec.label + rec.pos[0] + '-' + rec.pos[1]"
          type="button"
          class="cbx-btn cbx-btn--soft chip"
          @click="emit('update:spawn', rec.pos)"
        >
          {{ rec.label }} ({{ rec.pos[0] }}, {{ rec.pos[1] }})
        </button>
      </div>
      <p class="hint pos">出生点：({{ spawn[0] }}, {{ spawn[1] }})</p>
    </template>
  </div>
</template>

<style scoped>
.picker { display: flex; flex-direction: column; gap: 12px; }
.map {
  width: min(100%, 480px);
  aspect-ratio: 1;
  image-rendering: pixelated; /* 放大保持像素块，别糊成一团 */
  border-radius: 12px;
  border: 1px solid var(--cbx-border);
  cursor: crosshair;
  touch-action: none; /* 移动端点选不要变成页面滚动 */
  background: var(--cbx-bg-secondary);
}
.map.empty { cursor: default; }
.placeholder { color: var(--cbx-text-tertiary); font-size: var(--cbx-fs-sm); }
.hint { color: var(--cbx-text-secondary); font-size: var(--cbx-fs-sm); line-height: 1.6; margin: 0; }
.hint.pos { color: var(--cbx-text); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; }
.chip { min-height: 44px; } /* 触控目标不小于 44px */
</style>
