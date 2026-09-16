/**
 * 生成流水线：把各层串成一张 WorldGrid。
 *
 * ## 顺序是有依赖的，不能调换
 *   高度 → 水文 → 城镇 → 路网 → 装配 → 装饰 → 连通标号 → 有界修复 → 出生点
 *
 * 城镇要知道哪里是水才不会落进湖里；路网要知道城镇在哪；装饰要知道哪里是路
 * 才不会把树种在街心；连通标号必须在装饰**之后**，因为树会挡路。
 *
 * ## ⚠️ 取消是「检查点式」的，不是抢占式的
 * `AbortController` **不会**中断正在执行的同步计算。所以每一步之间检查一次
 * `signal.aborted`，粒度就是一步。最长的一步是水文（约 200ms），
 * 也就是取消最多延迟 200ms —— 可以接受，换来的是不必把每个循环都改成可中断。
 *
 * 纯 service：不 import vue/pinia/three。可在 Worker 里跑。
 */

import { BIOMES, type Biome, type TerrainPreview, type WorldSettings } from '@/types/infiniteWorld'
import { WORLD_SIZE } from '../core/constants'
import { torusDist2, wrapTile } from '../core/torus'
import { findPath, type Sampler } from '../navigation/path'
import { buildRegionMap } from '../navigation/regions'
import { deriveDecor } from './decor'
import { bakeElevation, createFields } from './fields'
import { createEmptyGrid, Flag, Surface, type WorldGrid } from './grid'
import { buildHydrology, WATER } from './hydrology'
import { buildRoads, type Bridge } from './roads'
import { seedOf } from './rng'
import { planTowns, stampTowns, type Town } from './settlement'

const N = WORLD_SIZE * WORLD_SIZE

export const GENERATOR_VERSION = 'torus-1'

export interface BuildWorldInput {
  seed: string
  settings: Pick<
    WorldSettings,
    'waterRatio' | 'forestDensity' | 'fieldDensity' | 'season' | 'dayMinutes'
  > & {
    townDensity?: number
    riverDensity?: number
  }
  signal?: { aborted: boolean }
  onProgress?: (step: string, ratio: number) => void
}

const STEPS = [
  '塑造地势',
  '汇聚水系',
  '安置村镇',
  '铺设道路',
  '装配地表',
  '播撒草木',
  '勘查通路',
  '连通孤岛',
  '选定落脚处',
] as const

class Cancelled extends Error {
  constructor() {
    super('generation cancelled')
    this.name = 'Cancelled'
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof Error && e.name === 'Cancelled'
}

export function buildWorld(input: BuildWorldInput): WorldGrid {
  const { seed, settings } = input
  const base = seedOf(seed)
  let step = 0
  const tick = () => {
    if (input.signal?.aborted) throw new Cancelled()
    input.onProgress?.(STEPS[step] ?? '完成', step / STEPS.length)
    step++
  }

  // ── 1. 地势 ──
  tick()
  const fields = createFields({
    seed,
    // 森林旋钮整体平移湿度。⚠️ 必须走 moistureBias 而不是在生态判定里加 ——
    // 湿度有三个消费方（生态、装饰密度、地貌措辞），它们必须一起移动
    moistureBias: (settings.forestDensity - 0.5) * 0.35,
  })
  const baked = bakeElevation(fields, settings.waterRatio)

  // ── 2. 水系 ──
  tick()
  const hydro = buildHydrology({
    elevation: baked.elevation,
    seaLevel: baked.seaLevel,
    fields,
    riverDensity: settings.riverDensity ?? 0.5,
  })

  // ── 3. 城镇 ──
  tick()
  const towns = planTowns({
    seed,
    fields,
    elevation: baked.elevation,
    water: hydro.water,
    marsh: hydro.marsh,
    townDensity: settings.townDensity ?? 0.5,
    fieldDensity: settings.fieldDensity,
  })
  const masks = stampTowns(towns)

  // ── 4. 路网 ──
  tick()
  const roads = buildRoads({
    towns,
    water: hydro.water,
    elevation: baked.elevation,
    townMask: masks.town,
  })

  // ── 5. 装配地表与标志位 ──
  tick()
  const grid = createEmptyGrid(seed, GENERATOR_VERSION, baked.seaLevel)
  grid.elevation.set(baked.elevation)
  grid.towns = towns
  grid.bridges = roads.bridges

  const plazaMask = new Uint8Array(N)
  for (const t of towns) {
    for (let i = 0; i < t.plaza.length; i += 2) plazaMask[t.plaza[i + 1]! * WORLD_SIZE + t.plaza[i]!] = 1
  }

  for (let i = 0; i < N; i++) {
    const w = hydro.water[i]!
    const isBridge = roads.bridge[i] === 1
    const isRoad = roads.road[i] === 1
    const isBuilding = masks.building[i] !== 0
    const isFarm = masks.farm[i] === 1
    const isPlaza = plazaMask[i] === 1
    const isMarsh = hydro.marsh[i] === 1

    let surface: number
    let biome: Biome
    let flags = 0

    if (isBridge) {
      surface = Surface.Dirt
      biome = 'town'
      flags = Flag.Walkable | Flag.Road | Flag.Bridge
    } else if (w === WATER.deep) {
      surface = Surface.DeepWater
      biome = 'river'
    } else if (w === WATER.shallow) {
      surface = Surface.ShallowWater
      biome = 'river'
      // 浅水可缓行 —— 视觉的透明与否不决定能不能走过去
      flags = Flag.Walkable
    } else if (isBuilding) {
      surface = Surface.Cobble
      biome = 'town'
      flags = Flag.Town | Flag.Building
    } else if (isPlaza) {
      surface = Surface.Cobble
      biome = 'town'
      flags = Flag.Walkable | Flag.Town | Flag.Plaza | Flag.Road
    } else if (isRoad) {
      surface = Surface.Dirt
      biome = 'town'
      flags = Flag.Walkable | Flag.Road | (masks.town[i] ? Flag.Town : 0)
    } else if (isFarm) {
      surface = Surface.Tilled
      biome = 'field'
      flags = Flag.Walkable | Flag.Farmland
    } else if (isMarsh) {
      surface = Surface.Marsh
      biome = 'wetland'
      flags = Flag.Walkable
    } else {
      const x = i % WORLD_SIZE
      const y = (i - x) / WORLD_SIZE
      const [wx, wy] = fields.warp(x, y)
      const score = fields.moisture(x + wx, y + wy) + fields.macro(x, y) * 0.45
      if (score > 0.2) {
        surface = Surface.ForestFloor
        biome = 'forest'
      } else {
        surface = Surface.Grass
        biome = 'wild'
      }
      flags = Flag.Walkable
    }

    grid.surface[i] = surface
    grid.biome[i] = BIOMES.indexOf(biome)
    grid.flags[i] = flags
  }

  // 河岸：贴着水的陆地。标 RiverBank（钓鱼点/芦苇用），并把**自然地面**铺成沙滩，
  // 于是水与草之间有一圈沙岸过渡，而不是硬切。两格宽：先标一圈，再标紧挨这圈的一格。
  // ⚠️ 只动 Grass/ForestFloor —— 城镇、路、耕地、湿地各有自己的边界，不能被沙岸吃掉。
  const isNaturalLand = (s: number) => s === Surface.Grass || s === Surface.ForestFloor
  for (let ring = 0; ring < 2; ring++) {
    const touch: number[] = []
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) {
        const i = y * WORLD_SIZE + x
        if (hydro.water[i] !== WATER.none) continue
        if (!isNaturalLand(grid.surface[i]!)) continue
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const ni = wrapTile(y + dy) * WORLD_SIZE + wrapTile(x + dx)
          // 第 0 圈贴水；第 1 圈贴已铺好的沙岸
          const neighbourIsEdge =
            ring === 0 ? hydro.water[ni] !== WATER.none : grid.surface[ni] === Surface.Sand
          if (neighbourIsEdge) {
            touch.push(i)
            break
          }
        }
      }
    }
    for (const i of touch) {
      grid.surface[i] = Surface.Sand
      grid.flags[i] = grid.flags[i]! | Flag.RiverBank
    }
  }

  // ── 6. 装饰（会扣掉被树石挡住的 Walkable）──
  tick()
  deriveDecor(grid.decor, {
    base,
    fields,
    elevation: grid.elevation,
    water: hydro.water,
    marsh: hydro.marsh,
    flags: grid.flags,
    forestDensity: settings.forestDensity,
  })

  // ── 7. 连通标号 ──
  //
  // ⚠️ 必须在装饰**之后**：树和石头会挡路，装饰之前算的连通性是错的
  tick()
  let regions = labelInto(grid)

  // ── 8. 有界修复 ──
  tick()
  const repaired = repairConnectivity(grid, hydro.water, roads.bridges)
  if (repaired > 0) regions = labelInto(grid)

  // ── 9. 出生点 ──
  tick()
  grid.spawn = pickSpawn(grid)

  input.onProgress?.('完成', 1)
  return grid
}

function labelInto(grid: WorldGrid): ReturnType<typeof buildRegionMap> {
  const sampler: Sampler = (x, y) => {
    const i = wrapTile(y) * WORLD_SIZE + wrapTile(x)
    return {
      biome: BIOMES[grid.biome[i]!] ?? 'wild',
      height: grid.elevation[i]!,
      walkable: (grid.flags[i]! & Flag.Walkable) !== 0,
      bridge: (grid.flags[i]! & Flag.Bridge) !== 0,
    }
  }
  const map = buildRegionMap(sampler)
  grid.region.set(map.labels)
  grid.mainRegion = map.mainLabel
  return map
}

/** 一次修复最多补几座桥。⚠️ 有界 —— 绝不无限重试 */
const MAX_REPAIR_BRIDGES = 8

/**
 * 取一个镇的**可行走代表点**。
 *
 * ⚠️ 不能直接用镇心 (cx,cy)：那一格正是水井，而水井是 Building、不可行走，
 * `region[镇心]` 恒为 0 —— 于是「这个镇在不在主连通域里」这个判断
 * **永远为否**，所有镇都被误报成孤立，修复逻辑还会对每个镇白跑一次
 * 12 万预算的 A*。
 *
 * 改从广场里找第一个可行走格；广场全被占（极端地形）则退回镇内螺旋搜索。
 */
function townAnchor(grid: WorldGrid, t: Town): number {
  for (let i = 0; i < t.plaza.length; i += 2) {
    const idx = t.plaza[i + 1]! * WORLD_SIZE + t.plaza[i]!
    if (grid.flags[idx]! & Flag.Walkable) return idx
  }
  for (let r = 1; r <= t.radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const idx = wrapTile(t.cy + dy) * WORLD_SIZE + wrapTile(t.cx + dx)
        if (grid.flags[idx]! & Flag.Walkable) return idx
      }
    }
  }
  return wrapTile(t.cy) * WORLD_SIZE + wrapTile(t.cx)
}

/**
 * 把孤立在主连通域之外的城镇接回来。
 *
 * 做法是复用修路那套：允许过水的 A*，把找到的路径铺成路 + 桥。
 * 补满 MAX_REPAIR_BRIDGES 仍未接上的镇就如实留着 ——
 * 由向导提示用户换种子，而不是在这里无限重试。
 */
function repairConnectivity(grid: WorldGrid, water: Uint8Array, bridges: Bridge[]): number {
  if (grid.towns.length < 2) return 0
  const main = grid.mainRegion
  const stranded = grid.towns.filter((t) => grid.region[townAnchor(grid, t)] !== main)
  if (stranded.length === 0) return 0

  const anchorTown = grid.towns.find((t) => grid.region[townAnchor(grid, t)] === main)
  if (!anchorTown) return 0
  const anchorIdx = townAnchor(grid, anchorTown)
  const anchorX = anchorIdx % WORLD_SIZE
  const anchorY = (anchorIdx - anchorX) / WORLD_SIZE

  const STUB = { biome: 'wild' as const, height: 0, walkable: true, bridge: false }
  const sample: Sampler = () => STUB
  const costOf = (_t: unknown, x: number, y: number): number => {
    const i = wrapTile(y) * WORLD_SIZE + wrapTile(x)
    if (grid.flags[i]! & Flag.Road) return 0.35
    if (water[i]! !== WATER.none) return water[i] === WATER.deep ? 40 : 26
    if (!(grid.flags[i]! & Flag.Walkable)) return 6 // 树石可以清掉，但有代价
    return 1
  }

  let used = 0
  for (const t of stranded) {
    if (used >= MAX_REPAIR_BRIDGES) break
    const ai = townAnchor(grid, t)
    const ax = ai % WORLD_SIZE
    const ay = (ai - ax) / WORLD_SIZE
    const path = findPath(sample, [ax, ay], [anchorX, anchorY], {
      budget: 120_000,
      costOf,
      ignoreWalkable: true,
    })
    if (path.length === 0) continue

    let run: number[] = []
    for (const [fx, fy] of path) {
      const x = wrapTile(fx)
      const y = wrapTile(fy)
      const i = y * WORLD_SIZE + x
      if (water[i]! !== WATER.none) {
        run.push(x, y)
      } else {
        if (run.length > 0) {
          for (let k = 0; k < run.length; k += 2) {
            const bi = run[k + 1]! * WORLD_SIZE + run[k]!
            grid.flags[bi] = grid.flags[bi]! | Flag.Walkable | Flag.Road | Flag.Bridge
            grid.surface[bi] = Surface.Dirt
          }
          bridges.push({ cells: Int32Array.from(run), span: run.length / 2 })
          used++
          run = []
        }
        grid.flags[i] = grid.flags[i]! | Flag.Walkable | Flag.Road
        grid.surface[i] = Surface.Dirt
        grid.decor[i] = 0
      }
    }
  }
  return used
}

/**
 * 出生点：主连通域里、离某个镇的广场最近的可行走格。
 *
 * ⚠️ 必须在主连通域里。落在孤岛上的话玩家永远走不到任何 NPC 那儿，
 * 而这在创建向导的预览图上完全看不出来。
 */
function pickSpawn(grid: WorldGrid): [number, number] {
  const main = grid.mainRegion
  for (const t of grid.towns) {
    for (let r = 0; r <= 12; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
          const x = wrapTile(t.cx + dx)
          const y = wrapTile(t.cy + dy)
          const i = y * WORLD_SIZE + x
          if (grid.region[i] !== main) continue
          if (!(grid.flags[i]! & Flag.Walkable)) continue
          if (grid.flags[i]! & Flag.Building) continue
          return [x, y]
        }
      }
    }
  }
  // 没有镇（或镇全在孤岛上）：退而取主连通域里任意一格
  for (let i = 0; i < N; i++) {
    if (grid.region[i] === main && grid.flags[i]! & Flag.Walkable) {
      const x = i % WORLD_SIZE
      return [x, (i - x) / WORLD_SIZE]
    }
  }
  return [0, 0]
}

/** 供向导用的连通性体检 */
export function auditConnectivity(grid: WorldGrid): {
  strandedTowns: string[]
  mainShare: number
  regionCount: number
} {
  const main = grid.mainRegion
  let mainCells = 0
  let walkable = 0
  const seen = new Set<number>()
  for (let i = 0; i < N; i++) {
    const r = grid.region[i]!
    if (r === 0) continue
    walkable++
    seen.add(r)
    if (r === main) mainCells++
  }
  const stranded = grid.towns.filter((t) => grid.region[townAnchor(grid, t)] !== main).map((t) => t.name)
  return {
    strandedTowns: stranded,
    mainShare: walkable > 0 ? mainCells / walkable : 0,
    regionCount: seen.size,
  }
}

/**
 * 从 grid 降采样出向导用的缩略预览。
 *
 * ⚠️ 用「格内众数」而不是取左上角那一格：
 * 512→48 是 10 倍降采样，取单格会让细长的河流与道路整条消失，
 * 预览图上看起来像个没有水系的世界，而实际进去河网密布。
 */
export function makeTerrainPreview(grid: WorldGrid, size = 48): TerrainPreview {
  const biome = new Uint8Array(size * size)
  const heightMap = new Float32Array(size * size)
  const walkable = new Uint8Array(size * size)
  const counts = Object.fromEntries(BIOMES.map((b) => [b, 0])) as Record<Biome, number>

  const cell = WORLD_SIZE / size
  const tally = new Int32Array(BIOMES.length)

  for (let sy = 0; sy < size; sy++) {
    for (let sx = 0; sx < size; sx++) {
      tally.fill(0)
      let h = 0
      let walk = 0
      let n = 0
      const x0 = Math.floor(sx * cell)
      const y0 = Math.floor(sy * cell)
      const x1 = Math.min(WORLD_SIZE, Math.floor((sx + 1) * cell))
      const y1 = Math.min(WORLD_SIZE, Math.floor((sy + 1) * cell))
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * WORLD_SIZE + x
          tally[grid.biome[i]!]!++
          h += grid.elevation[i]!
          if (grid.flags[i]! & Flag.Walkable) walk++
          n++
        }
      }
      // 众数。⚠️ 平局时偏向「稀有」生态（索引靠后的 river/wetland/town），
      // 否则 wild 会把所有细节吃掉
      let best = 0
      for (let k = 1; k < tally.length; k++) if (tally[k]! >= tally[best]!) best = k
      const si = sy * size + sx
      biome[si] = best
      heightMap[si] = n > 0 ? h / n : 0
      walkable[si] = walk * 2 > n ? 1 : 0
      const name = BIOMES[best]
      if (name) counts[name]++
    }
  }
  return { width: size, height: size, biome, heightMap, walkable, counts }
}

/** 距离最近城镇的平方距离，供调试 */
export function nearestTownDist2(grid: WorldGrid, x: number, y: number): number {
  let best = Infinity
  for (const t of grid.towns) best = Math.min(best, torusDist2(x, y, t.cx, t.cy))
  return best
}
