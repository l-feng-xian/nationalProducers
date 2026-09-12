/**
 * NPC 的生活作息：按周边地貌确定性推导一份日程。
 *
 * 推导一次、随存档落盘一次 —— 与 homeX/homeY 同一套路。之后算法再怎么调，
 * 老 NPC 的家也不会悄悄搬走。
 *
 * 纯 service：不 import three / vue / pinia。
 */

import { fnv1a } from '@/services/hash'
import { findStandSpot, type PropKind, type World } from './world'
import type { RpgNpc, RpgPoi, RpgRoutine, RpgRoutineKind, RpgRoutineSlot } from '@/types/rpg'
import { MINUTES_PER_DAY } from './time'

/** 找地标时的搜索半径（格） */
const SCAN_R = 12

/**
 * 各类角色的时段表（当天分钟 → 用第几个 POI）。
 * POI 索引约定：0=家 1=干活的地方 2=社交的地方
 */
const SCHEDULES: Record<RpgRoutineKind, ReadonlyArray<[number, number]>> = {
  // 农夫：天不亮就起，午间回家吃饭，傍晚串门
  farmer: [
    [330, 0],
    [390, 1],
    [690, 0],
    [780, 1],
    [1080, 2],
    [1230, 0],
  ],
  villager: [
    [420, 0],
    [510, 2],
    [720, 0],
    [840, 1],
    [1110, 2],
    [1260, 0],
  ],
  keeper: [
    [390, 1],
    [720, 0],
    [810, 1],
    [1140, 2],
    [1290, 0],
  ],
  // 游荡者没有家可回，白天四处走、夜里找个地方歇
  wanderer: [
    [480, 1],
    [1140, 0],
  ],
}

/** 地标 → 找到它时该怎么描述这个地方、在这儿干什么 */
const WORK_OF: Partial<Record<PropKind, { label: string; act: string }>> = {
  crop: { label: '田里', act: '照看庄稼' },
  scarecrow: { label: '田边', act: '照看庄稼' },
  haystack: { label: '谷仓边', act: '收拾杂物' },
  haybale: { label: '谷仓边', act: '收拾杂物' },
  well: { label: '水井旁', act: '打水' },
  bench: { label: '长椅旁', act: '与邻里闲话' },
}

interface Found {
  x: number
  y: number
  kind: PropKind
  d2: number
}

/**
 * 一趟螺旋扫描，记下每种地标最近的那个。
 * 一趟扫完所有想要的种类 —— 分别扫的话同一片格子要走好几遍。
 */
function scanLandmarks(world: World, cx: number, cy: number): Map<PropKind, Found> {
  const out = new Map<PropKind, Found>()
  for (let dy = -SCAN_R; dy <= SCAN_R; dy++) {
    for (let dx = -SCAN_R; dx <= SCAN_R; dx++) {
      const pr = world.propAt(cx + dx, cy + dy)
      if (!pr) continue
      const d2 = dx * dx + dy * dy
      const prev = out.get(pr.kind)
      if (!prev || d2 < prev.d2) out.set(pr.kind, { x: pr.x, y: pr.y, kind: pr.kind, d2 })
    }
  }
  return out
}

/**
 * 地标本身多半是**挡路的**（房、井、稻草人都在 BLOCKERS 里），人只能站**旁边**。
 * 找不到就退回地标自身 —— 宁可站得不那么对，也不要没有 POI。
 */
function standNear(world: World, x: number, y: number): { x: number; y: number } {
  const spot = findStandSpot(world, x, y, { maxR: 3 })
  return spot ?? { x, y }
}

/** 这个 NPC 属于哪一类：看它周围有什么 */
function kindOf(marks: Map<PropKind, Found>, inVillage: boolean): RpgRoutineKind {
  const field = marks.get('crop') ?? marks.get('scarecrow')
  if (field && field.d2 <= 100) return 'farmer'
  if (!inVillage) return 'wanderer'
  if (marks.has('house') && marks.has('well')) return 'villager'
  return 'keeper'
}

/**
 * 按周边地貌给一个 NPC 推导作息。
 *
 * @param anchor 锚点（格坐标）。通常就是 NPC 的出生格
 */
export function autoRoutine(
  world: World,
  npc: RpgNpc,
  anchor: { x: number; y: number },
): RpgRoutine {
  const marks = scanLandmarks(world, anchor.x, anchor.y)
  // ⚠️ 问世界，不要嗅 describeArea 的字面量：村名后缀有 村/庄/屯/寨/坞/铺/集 七种（names.ts VILLAGE_SUFFIX），
  // `includes('村')` 只认得出其中一种，剩下五种的村民会被判成「游荡者」——
  // 而游荡者没有社交时段，整个村子于是白天各走各的、傍晚也不串门
  const inVillage = world.villageAt(anchor.x, anchor.y) !== null
  const kind = kindOf(marks, inVillage)
  const h = fnv1a(npc.id)

  // 家：最近的房子旁；没有房子就守着锚点
  const house = marks.get('house')
  const homeSpot = house ? standNear(world, house.x, house.y) : { x: anchor.x, y: anchor.y }
  const home: RpgPoi = {
    ...homeSpot,
    label: house ? '家门口' : '落脚处',
    act: '歇着',
    r: 1.5,
  }

  // 干活的地方：按类别挑最合适的地标
  const workOrder: PropKind[] =
    kind === 'farmer'
      ? ['crop', 'scarecrow', 'haystack']
      : kind === 'keeper'
        ? ['haystack', 'haybale', 'bench']
        : ['well', 'bench', 'haystack']
  let work: RpgPoi | null = null
  for (const k of workOrder) {
    const m = marks.get(k)
    const info = WORK_OF[k]
    if (!m || !info) continue
    work = { ...standNear(world, m.x, m.y), label: info.label, act: info.act, r: 2 }
    break
  }
  if (!work) {
    // 荒野里的人：在锚点周围一块地方转悠。方位由 id 哈希定，全村不会都朝一边
    const ang = ((h >>> 8) % 360) * (Math.PI / 180)
    const rr = 4 + (h % 4)
    const spot = standNear(
      world,
      Math.round(anchor.x + Math.cos(ang) * rr),
      Math.round(anchor.y + Math.sin(ang) * rr),
    )
    work = {
      ...spot,
      label: world.describeArea(spot.x, spot.y),
      act: '四处走走',
      r: 3,
    }
  }

  // 社交：长椅 > 水井 > 指示牌 > 村心。
  // 跳过已经被「干活」占掉的那一格 —— 两段落在同一格的话，这个 NPC 一整天
  // 就只在一个点上换措辞，作息看上去等于没有
  let social: RpgPoi | null = null
  for (const pass of [0, 1]) {
    for (const k of ['bench', 'well', 'signpost'] as PropKind[]) {
      const m = marks.get(k)
      if (!m) continue
      const spot = standNear(world, m.x, m.y)
      if (pass === 0 && spot.x === work.x && spot.y === work.y) continue
      const info = WORK_OF[k] ?? { label: '村口', act: '与邻里闲话' }
      social = { ...spot, label: info.label, act: '与邻里闲话', r: 2 }
      break
    }
    if (social) break
  }
  if (!social) social = { ...home, act: '独自待着' }

  const pois: RpgPoi[] = [home, work, social]

  // 时段边界加 ±40 分钟的抖动 —— 不抖的话整个村子会**同一秒集体转身**，
  // 比不动还出戏
  const slots: RpgRoutineSlot[] = SCHEDULES[kind].map(([from, poi], i) => {
    const j = (fnv1a(`${npc.id}:${i}`) % 81) - 40
    return { from: (((from + j) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY, poi }
  })
  slots.sort((a, b) => a.from - b.from)

  return { kind, pois, slots }
}

/**
 * 完全推导不出来时的兜底：一个落在锚点的 POI，全天有效。
 * 这**就是引入作息之前的行为**，所以老 NPC 在用户没动过任何东西之前零变化。
 */
export function fallbackRoutine(world: World, anchor: { x: number; y: number }): RpgRoutine {
  return {
    kind: 'wanderer',
    pois: [
      {
        x: anchor.x,
        y: anchor.y,
        label: world.describeArea(anchor.x, anchor.y),
        act: '四处走走',
        r: 3,
      },
    ],
    slots: [{ from: 0, poi: 0 }],
  }
}

/**
 * 当前时刻该用第几个 POI。
 * 一天是个圈：早于第一段起点的时刻属于**最后一段**（昨夜延续下来的那段）。
 */
export function slotIndexAt(routine: RpgRoutine, minuteOfDay: number): number {
  const slots = routine.slots
  if (!slots.length) return 0
  let cur = slots[slots.length - 1] as RpgRoutineSlot
  for (const s of slots) {
    if (minuteOfDay >= s.from) cur = s
  }
  return Math.min(cur.poi, routine.pois.length - 1)
}
