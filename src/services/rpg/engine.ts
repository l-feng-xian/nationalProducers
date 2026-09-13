/**
 * 游戏主循环。
 *
 * 把世界、输入、渲染串起来，对外只暴露 `{ start, stop, dispose }` 与几个读值。
 * 刻意做成「可停可弃」而不是全局单例：游戏页会被路由卸载，rAF 与 WebGPU 上下文
 * 都必须干净还回去（这一点与 parallax.ts 那个刻意常驻的渲染器正相反）。
 *
 * 纯 service：不 import vue/pinia。
 */

import type { PropKind, World } from './world'
import { findSpawn, findStandSpot, wrapDelta } from './world'
import { TOOLS, propLabel, ruleFor, type ItemId, type ToolId } from './harvest'
import { pickSpecies, type CreatureDef, type CreatureKind } from './creatures'
import { BIOME, WATER_SURFACE_Y } from './noise'
import { findPath } from './pathfind'
import { autoRoutine, fallbackRoutine, slotIndexAt } from './routine'
import {
  DEFAULT_TIME_SCALE,
  MINUTES_PER_DAY,
  clockOf,
  phaseLabel,
  phaseOf,
  type WorldClock,
} from './time'
import type { CharacterRig } from './rig'
import { createInput, type InputHandle } from './input'
import { createScene, type SceneHandle } from './scene'
import { createFigureRig } from './figureRig'
import { NPC_REACH, nearestNpc, type RpgNpc, type RpgRoutine } from '@/types/rpg'
import { fnv1a } from '@/services/hash'

/** 移动速度，格/秒 */
const SPEED = 5.2
/** NPC 漫游速度。明显慢于玩家 —— 村民散步,不是赶路 */
const NPC_SPEED = 1.6
/** 通勤速度。赶路是有目的的,散步不是;也免得一段通勤吃掉整个时段 */
const NPC_TRAVEL_SPEED = 2.2
/** NPC 的落点判定半径(格),比玩家略小,贴着树走不至于卡死 */
const NPC_RADIUS = 0.2
/**
 * 单帧最大步进。
 *
 * 标签页切走再回来时 rAF 的 dt 可能是几秒，不夹住的话角色会**瞬移一大段**、
 * 甚至直接穿过水面到对岸 —— 碰撞是按步进采样的，步子迈太大就跨过去了。
 */
const MAX_DT = 0.05

/** 角色的碰撞半径（格）。比 0.5 小，免得贴着岸边就卡住 */
const RADIUS = 0.28

/**
 * 采集够得着的距离（格）。比交谈的 NPC_REACH(1.4) 略大 ——
 * 树/石都是**挡路**道具，玩家只能站在它旁边而不能站上去，贴着站时中心距就已经
 * 接近 1.0～1.4；给到 1.7 才不会出现「明明贴着树却说够不着」。
 */
const HARVEST_REACH = 1.7

// ── 生物（鱼 / 虫）──
/** 生成环带（格）：太近会当着面凭空冒出来，太远看不见白算 */
const CRE_SPAWN_MIN = 6
const CRE_SPAWN_MAX = 18
/** 离这么远就收走。比生成环带外沿再宽一圈，免得在边界上反复生成/收走 */
const CRE_DESPAWN = 28
/** 每类同时最多几只 */
const CRE_MAX_PER_KIND = 6
/** 补生成的间隔（秒） */
const CRE_SPAWN_EVERY = 1.6
/**
 * 够得着的距离。钓鱼是**站在岸上够水里**，必须比捕虫宽得多 ——
 * 按捕虫那 1.9 来的话，玩家得站进水里才钓得到，而水是走不进去的（深水不可行走）。
 */
const FISH_REACH = 3.4
const BUG_REACH = 1.9
/** 游动/飞舞速度（格/秒）。都比玩家慢得多，抓得住才有乐趣 */
const FISH_SPEED = 0.55
const BUG_SPEED = 0.95

/**
 * 此刻够得着的那个可动作对象 —— 可能是地上的道具（树/石/花），也可能是
 * 会动的生物（鱼/虫）。两者归一成同一个形状，HUD 的提示气泡与执行动作
 * 就只需要认一种东西。
 */
export interface ActionTarget {
  type: 'prop' | 'creature'
  /** 提示气泡里的名字：「树木」「鲫鱼」 */
  label: string
  /** 动作词：「砍伐」「钓起」「捕捉」 */
  verb: string
  /** 需要的工具 */
  tool: ToolId
  /** 手里这件工具对不对 —— 不对就只提示「需要斧头」，不执行 */
  ready: boolean
  /** 产出 */
  item: ItemId
  count: number
  /** type='prop' 时有：格坐标与刷新所需的游戏分钟 */
  cell?: { x: number; y: number; respawn: number }
  /** type='creature' 时有：运行时 id，抓到后交给 consumeCreature */
  creatureId?: string
}

export interface EngineHandle {
  readonly scene: SceneHandle
  readonly input: InputHandle
  /** 当前手持工具 */
  tool(): ToolId
  setTool(t: ToolId): void
  /** 此刻够得着的可动作对象（道具或生物；没有就是 null）。HUD 与动作共用 */
  actionTarget(): ActionTarget | null
  /** 抓走一只生物（钓/捕成功后调）。找不到返回 false */
  consumeCreature(id: string): boolean
  /**
   * 世界内容的版本号，每次 notifyWorldChanged 自增。
   *
   * HUD 的提示气泡不能每帧重算（要扫 5×5 格、每格一次带噪声的 propAt），只能在
   * 「可能变了」时重算。玩家挪格、换工具都由视图自己知道，但**树被砍掉 / 长回来**
   * 是引擎侧发生的 —— 没有这个版本号，刷新后提示气泡会一直停在过期状态
   * （树明明回来了却不提示，或树没了还提示去砍）。
   */
  worldVersion(): number
  /**
   * 告诉引擎某一格的世界内容变了（采集掉了 / 刷新长回来了）。
   *
   * ⚠️ 必须调：引擎把「能不能站」按格记忆化了（standCache），而 chunk 网格是
   * 启动时一次性烘焙的静态几何。不通知的话，砍掉的树**碰撞还在**（走不过去）
   * 且**画面还在**；长回来的树则是碰撞有了、画面没有。
   */
  notifyWorldChanged(x: number, y: number): void
  /** 玩家当前格坐标（浮点，已回绕） */
  position(): { x: number; y: number }
  /** 本帧是否在移动，UI 上要显示 */
  moving(): boolean
  /** 当前够得着的 NPC，UI 上据此显示「按 E 交谈」。够不着为 null */
  nearNpc(): RpgNpc | null
  /** NPC 增删改后重新挂载 */
  setNpcs(npcs: RpgNpc[]): void
  /**
   * 从 (x,y) 螺旋找最近一块能站 NPC 的格（陆地、无实体道具、离别的 NPC
   * 至少 1.5 格）。找不到返回 null。放 NPC 前先问它,别把人放进水里
   */
  findNpcSpot(x: number, y: number): { x: number; y: number } | null
  /** NPC 此刻的处境一句话（在哪、在干什么），拼进对话提示词的【场景】 */
  npcStateText(id: string): string
  /**
   * 按 NPC **当前所在位置**重新推导一份作息，写回 npc.routine 并立即生效。
   *
   * ⚠️ 必须由引擎来做，不能让 UI 自己算完塞进 npc.routine：运行时还记着
   * `rt.slot`，而 `enterSlot` 在 `idx === rt.slot` 时直接 return —— 换了新
   * routine 却不清 slot 的话，「重新推导」要等到下一个时段才看得出效果，
   * 在用户眼里就是**点了没反应**。这里把 slot 归零，下一帧必然重新进段。
   *
   * 找不到这个 NPC（比如刚被删）返回 null。
   */
  rederiveRoutine(id: string): RpgRoutine | null
  /** 当前世界时刻 */
  clock(): WorldClock
  /** 对话期间冻结时钟 —— 见 time.ts 的 TALK_MINUTES */
  setClockPaused(v: boolean): void
  /** 说完一句话后定额推进 */
  addClockMinutes(n: number): void
  /** 任一 NPC 跨过格边界时回调（store 侧节流落盘用） */
  onNpcMoved?: (() => void) | undefined
  start(): void
  stop(): void
  dispose(): void
  /** 每帧回调，交给 store 同步响应式状态 */
  onTick?: ((dt: number) => void) | undefined
}

export interface CreateEngineArgs {
  world: World
  host: HTMLElement
  /** 初始位置，不给就找一块靠近世界中心的陆地 */
  start?: { x: number; y: number }
  forceWebGL?: boolean
  /** 世界里的 NPC。位置是格坐标 */
  npcs?: RpgNpc[]
  /** 起始世界时刻（总游戏分钟）。存档续上用 */
  clock0?: number
  /** 时间流速。0 = 冻结 */
  timeScale?: number
  /**
   * 采集状态的读写口。数据归游戏页（它才有存档），**定时**归引擎（它才有时钟）。
   *
   * 引擎每跨一个游戏分钟问一次 takeExpired：到点该长回来的格子由它取走，
   * 引擎据此重建那几块 chunk。不这么分工的话，要么视图层得自己跑一条 rAF 去
   * 轮询刷新，要么引擎得认识 IndexedDB —— 两种都更糟。
   */
  harvest?: {
    /** 取走所有「刷新时刻 ≤ now」的格并从表中删除，返回它们 */
    takeExpired(now: number): ReadonlyArray<{ x: number; y: number }>
  }
}

export async function createEngine(args: CreateEngineArgs): Promise<EngineHandle> {
  const { world, host } = args
  const scene = await createScene({ world, forceWebGL: args.forceWebGL === true })
  host.appendChild(scene.canvas)

  const input = createInput()
  const spawn = args.start ?? findSpawn(world)
  let px = spawn.x
  let py = spawn.y
  let isMoving = false

  // 玩家固定草帽农夫造型；NPC 按 id 哈希取配色
  const player: CharacterRig = createFigureRig({
    THREE: scene.THREE,
    player: true,
    material: scene.figureMaterial,
  })
  scene.addRig(player)

  // ── NPC ──
  // 每个 NPC 一份独立 rig（配色由 id 派生）+ 一份漫游运行时状态。
  // 运行时只留内存（位置写回 npc.x/y 落盘），动画相位在 rig 内部随机
  interface NpcRt {
    /** 浮点中心坐标。npc.x/y 是它向下取整的落盘投影 */
    x: number
    y: number
    /** 漫游锚点中心 */
    hx: number
    hy: number
    roam: number
    /**
     * travel = 正在赶去当前时段的 POI。
     *
     * 作息刻意**不新增一套状态机**：把当前时段的 POI 直接设成锚点 (hx,hy)，
     * 「在这点附近走走停停」就白捡了原有的 idle↔walk。真正需要新增的只有
     * 换段那一刻的长距离位移 —— 而那恰恰是硬拴绳会把人**瞬移**拽回去的地方。
     */
    phase: 'idle' | 'walk' | 'travel'
    /** idle 剩余秒数 / walk 的目标点 */
    t: number
    tx: number
    ty: number
    /** 当前生效的作息段。只在游戏分钟变化时才重算，不是每帧 */
    slot: number
    /**
     * 上次进段时那个 POI 的格心坐标。**只用来判断「POI 变没变」**。
     *
     * ⚠️ 不能拿 `hx/hy` 来判：那对字段是**共用槽位** —— 卡死阶梯放弃时会把它
     * 改写成「就地漫游的锚点」（当前浮点坐标）。用它判身份的话，放弃之后
     * `poi.x + 0.5 !== rt.hx` 恒成立，下一个游戏分钟 enterSlot 就会当成
     * 「POI 变了」重新进段：`stranded` 被清、重新 travel —— 「体面放弃」变成
     * 「放弃一秒后无限重试」，而 npcStateText 那句诚实的「本想去…一时没能过去」
     * 成了死代码。
     */
    poiX: number
    poiY: number
    /** 连续多少次检查都没靠近目标 —— 卡死阶梯用 */
    stuck: number
    /** 上次测距时离目标多远，配合 stuck 判定「有没有进展」 */
    lastD: number
    /** 绕行点；非 null 时先去它，到了再续原目标（A* 失败时的贪心兜底用） */
    detour: { x: number; y: number } | null
    /** 这一段没能走到 POI（卡死阶梯的最后一级）。只影响提示词措辞 */
    stranded: boolean
    /**
     * A* 算出的航点（格心），沿它逐点走。空 = 没有路可循 → 回落到贪心 + 卡死阶梯。
     *
     * ⚠️ **只在起程时算一次**（世界静态，路不会失效）。为了不让「同一分钟全村同时
     * 通勤」在一帧里挤爆 A*，起程时先只标 routePending，真正的求路在 tick 里按每帧
     * 预算摊开算（见 astarBudget）。算好之前这一两帧先用贪心，NPC 照样在动。
     */
    route: { x: number; y: number }[]
    routeIdx: number
    routePending: boolean
  }
  const npcRigs = new Map<string, CharacterRig>()
  const npcRt = new Map<string, NpcRt>()
  let npcs: RpgNpc[] = args.npcs ?? []
  let near: RpgNpc | null = null

  // ── 世界时钟 ──
  let clockTotal = args.clock0 ?? 480
  const timeScale = args.timeScale ?? DEFAULT_TIME_SCALE
  let clockPaused = false
  /** 上一帧结束时的整分钟。跨帧记住，见 tick 里的说明 */
  let lastMinute = Math.floor(clockTotal)

  const W = world.params.width
  const H = world.params.height

  /**
   * 能站人：陆地且没有实体道具。
   *
   * ⚠️ **按格记忆化**。引擎只问整数格，而世界是确定且静态的，所以这份缓存是
   * **精确**的、不是近似。不缓存的话每次调用要重算 biome/湿度/台阶三个 fBm ——
   * 每个移动中的 NPC 每帧至少问两次，20 个 NPC @60fps 就是每秒七万次噪声取样。
   * 作息会让 NPC 走得更多，所以这不是镀金，是必要的。
   */
  const standCache = new Map<number, boolean>()
  const canStand = (x: number, y: number): boolean => {
    const gx = ((Math.floor(x) % W) + W) % W
    const gy = ((Math.floor(y) % H) + H) % H
    const key = gy * W + gx
    const hit = standCache.get(key)
    if (hit !== undefined) return hit
    const v = world.walkableAt(x, y) && !world.blockedAt(x, y)
    standCache.set(key, v)
    return v
  }

  /** 环面距离（格） */
  const torusDist = (ax: number, ay: number, bx: number, by: number): number =>
    Math.hypot(wrapDelta(ax - bx, W), wrapDelta(ay - by, H))

  // ── 采集 ──

  let curTool: ToolId = 'hand'

  /**
   * 找此刻够得着的那个可采道具：5×5 邻域里离玩家最近的一个。
   *
   * 用「最近的」而不是「正前方那一格」：后者要求玩家先把朝向对准，在 2.5D 斜视
   * 加摇杆的操作下相当别扭 —— 明明贴着树，只因为朝向差一点就采不到。
   *
   * 返回值带上「占自身够得着距离的比例」，好与生物目标公平比较。
   */
  /**
   * 5×5 邻域里的可采道具**候选**，按「所在格 + 世界版本」缓存。
   *
   * ⚠️ 缓存的是**扫描结果**而不是最终目标：扫描要 25 次 propAt（每次好几层噪声），
   * 是这里唯一贵的部分，且只在玩家换格或世界变了时才会不同；而距离要拿**当前**
   * 的浮点坐标算 —— 把距离也一起缓存的话，在同一格内挪动时目标会僵住，
   * 边缘处就会出现「明明走近了却还说够不着」。
   */
  let propScan: {
    key: string
    cells: Array<{ x: number; y: number; cx: number; cy: number; kind: PropKind }>
  } | null = null

  function propCandidates(): ReadonlyArray<{
    x: number
    y: number
    cx: number
    cy: number
    kind: PropKind
  }> {
    const gx = Math.floor(px)
    const gy = Math.floor(py)
    const key = `${gx},${gy}|${worldVer}`
    if (propScan && propScan.key === key) return propScan.cells
    const cells: Array<{ x: number; y: number; cx: number; cy: number; kind: PropKind }> = []
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = (((gx + dx) % W) + W) % W
        const y = (((gy + dy) % H) + H) % H
        const pr = world.propAt(x, y)
        if (!pr || !ruleFor(pr.kind)) continue
        // 记道具的**实际落点**（含亚格偏移）：贴着一棵偏了半格的树不该判成够不着
        cells.push({ x, y, cx: x + 0.5 + pr.ox, cy: y + 0.5 + pr.oy, kind: pr.kind })
      }
    }
    propScan = { key, cells }
    return cells
  }

  /**
   * 找此刻够得着的那个可采道具：邻域里离玩家最近的一个。
   *
   * 用「最近的」而不是「正前方那一格」：后者要求玩家先把朝向对准，在 2.5D 斜视
   * 加摇杆的操作下相当别扭 —— 明明贴着树，只因为朝向差一点就采不到。
   *
   * 返回值带上「占自身够得着距离的比例」，好与生物目标公平比较。
   */
  function propTarget(): { t: ActionTarget; ratio: number } | null {
    let best: { t: ActionTarget; ratio: number } | null = null
    let bestD = HARVEST_REACH
    for (const c of propCandidates()) {
      const d = torusDist(px, py, c.cx, c.cy)
      if (d >= bestD) continue
      const rule = ruleFor(c.kind)
      if (!rule) continue
      bestD = d
      best = {
        ratio: d / HARVEST_REACH,
        t: {
          type: 'prop',
          label: propLabel(c.kind),
          verb: rule.verb,
          tool: rule.tool,
          ready: rule.tool === curTool,
          item: rule.item,
          count: rule.count,
          cell: { x: c.x, y: c.y, respawn: rule.respawn },
        },
      }
    }
    return best
  }

  // ── 生物运行时：鱼在水里游、虫在草上飞。只活在内存里，不进存档 ──

  interface CreatureRt {
    id: string
    def: CreatureDef
    obj: ReturnType<SceneHandle['addCreature']>
    /** 浮点世界坐标 */
    x: number
    y: number
    /** 当前游动目标 */
    tx: number
    ty: number
    /** 换目标倒计时（秒） */
    t: number
    /** 飞舞相位，只给虫用 —— 上下浮动才像在飞 */
    bob: number
  }
  const creatures: CreatureRt[] = []
  let creSeq = 0
  let creSpawnT = 0

  const reachOf = (k: CreatureKind): number => (k === 'fish' ? FISH_REACH : BUG_REACH)

  /** 这一格能不能放某类生物：鱼要水，虫要能站人的草地 */
  function creatureCellOk(kind: CreatureKind, x: number, y: number): boolean {
    const b = world.biomeAt(x + 0.5, y + 0.5)
    if (kind === 'fish') return b === BIOME.water || b === BIOME.shallow
    return b === BIOME.grass && canStand(x + 0.5, y + 0.5)
  }

  /** 在玩家周围的环带里随机找一个能放的格 */
  function findCreatureCell(kind: CreatureKind): { x: number; y: number } | null {
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2
      const r = CRE_SPAWN_MIN + Math.random() * (CRE_SPAWN_MAX - CRE_SPAWN_MIN)
      const x = ((Math.floor(px + Math.cos(a) * r) % W) + W) % W
      const y = ((Math.floor(py + Math.sin(a) * r) % H) + H) % H
      if (creatureCellOk(kind, x, y)) return { x, y }
    }
    return null
  }

  function spawnCreature(kind: CreatureKind): void {
    const night = phaseOf(Math.floor(clockTotal) % MINUTES_PER_DAY)
    const isNight = night === 'night' || night === 'lateNight'
    const def = pickSpecies(kind, Math.random(), isNight)
    if (!def) return
    const cell = findCreatureCell(kind)
    if (!cell) return
    const obj = scene.addCreature(def.color, def.size, kind === 'fish')
    creatures.push({
      id: `c${++creSeq}`,
      def,
      obj,
      x: cell.x + 0.5,
      y: cell.y + 0.5,
      tx: cell.x + 0.5,
      ty: cell.y + 0.5,
      t: 0,
      bob: Math.random() * Math.PI * 2,
    })
  }

  function despawnCreature(i: number): void {
    const c = creatures[i]
    if (!c) return
    scene.removeCreature(c.obj)
    creatures.splice(i, 1)
  }

  function updateCreatures(dt: number): void {
    // 补生成：每类都维持在上限附近
    creSpawnT -= dt
    if (creSpawnT <= 0) {
      creSpawnT = CRE_SPAWN_EVERY
      for (const k of ['fish', 'bug'] as const) {
        if (creatures.filter((c) => c.def.kind === k).length < CRE_MAX_PER_KIND) spawnCreature(k)
      }
    }
    for (let i = creatures.length - 1; i >= 0; i--) {
      const c = creatures[i]!
      // 走远了就收走 —— 否则玩家绕世界一圈会拖着一长串鱼
      if (torusDist(c.x, c.y, px, py) > CRE_DESPAWN) {
        despawnCreature(i)
        continue
      }
      // 换个目标点接着晃
      c.t -= dt
      if (c.t <= 0) {
        c.t = 1.5 + Math.random() * 2.5
        const a = Math.random() * Math.PI * 2
        const r = 1 + Math.random() * 3
        const nx = ((Math.floor(c.x + Math.cos(a) * r) % W) + W) % W
        const ny = ((Math.floor(c.y + Math.sin(a) * r) % H) + H) % H
        if (creatureCellOk(c.def.kind, nx, ny)) {
          c.tx = nx + 0.5
          c.ty = ny + 0.5
        }
      }
      const speed = c.def.kind === 'fish' ? FISH_SPEED : BUG_SPEED
      const step = Math.min(speed * dt, 0.2)
      const mdx = wrapDelta(c.tx - c.x, W)
      const mdy = wrapDelta(c.ty - c.y, H)
      const len = Math.hypot(mdx, mdy)
      if (len > 0.05) {
        const nx2 = c.x + (mdx / len) * step
        const ny2 = c.y + (mdy / len) * step
        // 只在自己的介质里游：鱼绝不上岸，虫绝不下水
        if (creatureCellOk(c.def.kind, Math.floor(nx2), Math.floor(ny2))) {
          c.x = ((nx2 % W) + W) % W
          c.y = ((ny2 % H) + H) % H
        } else {
          c.t = 0 // 撞边界，立刻换个方向
        }
      }
      c.bob += dt * 3
      const y =
        c.def.kind === 'fish'
          ? WATER_SURFACE_Y + 0.04
          : world.heightAt(c.x, c.y) + 0.55 + Math.sin(c.bob) * 0.12
      scene.placeCreature(c.obj, c.x, c.y, y)
    }
  }

  /** 最近的、够得着的一只生物 */
  function creatureTarget(): { t: ActionTarget; ratio: number } | null {
    let best: { t: ActionTarget; ratio: number } | null = null
    let bestRatio = 1
    for (const c of creatures) {
      const reach = reachOf(c.def.kind)
      const ratio = torusDist(c.x, c.y, px, py) / reach
      if (ratio >= bestRatio) continue
      bestRatio = ratio
      best = {
        ratio,
        t: {
          type: 'creature',
          label: c.def.name,
          verb: c.def.verb,
          tool: c.def.tool,
          ready: c.def.tool === curTool,
          item: c.def.item,
          count: 1,
          creatureId: c.id,
        },
      }
    }
    return best
  }

  /** 道具与生物里挑「相对更够得着」的那个 —— 两者的够得着距离不同，比绝对距离不公平 */
  function actionTarget(): ActionTarget | null {
    const a = propTarget()
    const b = creatureTarget()
    if (a && b) return a.ratio <= b.ratio ? a.t : b.t
    return a?.t ?? b?.t ?? null
  }

  function consumeCreature(id: string): boolean {
    const i = creatures.findIndex((c) => c.id === id)
    if (i < 0) return false
    despawnCreature(i)
    return true
  }

  /** 世界内容版本号。见 EngineHandle.worldVersion */
  let worldVer = 0

  /** 某格内容变了：作废通行缓存、重建那一块网格、并让 HUD 知道该重算了 */
  function notifyWorldChanged(x: number, y: number): void {
    const gx = ((Math.floor(x) % W) + W) % W
    const gy = ((Math.floor(y) % H) + H) % H
    standCache.delete(gy * W + gx)
    scene.rebuildAt(gx, gy)
    worldVer++
  }

  /**
   * 找 NPC 落点。实现搬到了 world.ts（创建向导要在没有引擎、没有 WebGPU 的
   * 情况下也能定位 NPC），这里只补上「避开别的 NPC」所需的实时坐标。
   *
   * ⚠️ 传的是 npcRt 里的**浮点**位置而不是落盘的整数格：NPC 在漫游，
   * 用整数格判拥挤会在它走到半格时误判。
   */
  function findNpcSpot(x: number, y: number): { x: number; y: number } | null {
    return findStandSpot(world, x, y, {
      maxR: 12,
      avoid: [...npcRt.values()],
      minDist: 1.5,
    })
  }

  /** 首次挂载一个 NPC 的运行时：校正非法落点、补默认锚点与漫游半径 */
  function initRt(n: RpgNpc): NpcRt {
    let rt = npcRt.get(n.id)
    if (rt) return rt
    let fx = n.x + 0.5
    let fy = n.y + 0.5
    // 旧版本放的 NPC 可能站在水里/房里 —— 挪到最近可站点
    if (!canStand(fx, fy)) {
      const spot = findNpcSpot(fx, fy)
      if (spot) {
        fx = spot.x + 0.5
        fy = spot.y + 0.5
        n.x = spot.x
        n.y = spot.y
      }
    }
    if (n.homeX === undefined || n.homeY === undefined) {
      n.homeX = Math.floor(fx)
      n.homeY = Math.floor(fy)
    }
    if (n.roamR === undefined) n.roamR = 3 + (fnv1a(n.id) % 4)
    // 作息与 homeX/homeY 同一套路：惰性推导一次并写回，随既有节流落盘。
    // 之后算法再怎么调，这个 NPC 的家也不会悄悄搬走
    if (!n.routine) {
      const anchor = { x: n.homeX, y: n.homeY }
      n.routine = autoRoutine(world, n, anchor) ?? fallbackRoutine(world, anchor)
    }
    rt = {
      x: fx,
      y: fy,
      hx: n.homeX + 0.5,
      hy: n.homeY + 0.5,
      roam: n.roamR,
      phase: 'idle',
      t: 1 + Math.random() * 3,
      tx: fx,
      ty: fy,
      slot: -1, // -1 = 还没定过，首帧必然触发一次换段
      // NaN 与任何数都不相等 —— 首次进段必然走完整分支
      poiX: NaN,
      poiY: NaN,
      stuck: 0,
      lastD: Infinity,
      detour: null,
      stranded: false,
      route: [],
      routeIdx: 0,
      routePending: false,
    }
    npcRt.set(n.id, rt)
    return rt
  }

  /**
   * 起程去 travel：进入 travel 相位并**标记待求路**（真正的 A* 在 tick 里按每帧
   * 预算摊开算，见 astarBudget）。求出来之前的一两帧先走贪心，NPC 不会呆站。
   */
  const beginTravel = (rt: NpcRt): void => {
    rt.phase = 'travel'
    rt.route = []
    rt.routeIdx = 0
    rt.routePending = true
  }

  /**
   * 换段：把当前时段的 POI 设成锚点，并让 NPC 走过去。
   *
   * ⚠️ travel 期间**挂起拴绳** —— 拴绳的意义是「别走丢」，而通勤时目的地本身
   * 就是绳子。不挂起的话第一帧就被拽回去，人永远到不了田里。
   */
  function enterSlot(n: RpgNpc, rt: NpcRt, minuteOfDay: number): void {
    const routine = n.routine
    if (!routine) return
    const idx = slotIndexAt(routine, minuteOfDay)
    const poi = routine.pois[idx]
    if (!poi) return
    const hx = poi.x + 0.5
    const hy = poi.y + 0.5
    // ⚠️ 半径要自己校验，`?? 2` 兜不住。编辑器的 `v-model.number` 在输入框被清空
    // 的那一刻写的是**空串**，而 `'' ?? 2` 还是 `''` —— 拿去比大小会当 0 用，
    // NPC 当场被拴绳夹到锚点上。导入的存档同理可能带着任何东西
    const roam = typeof poi.r === 'number' && Number.isFinite(poi.r) && poi.r > 0 ? poi.r : 2

    // ⚠️ 判「POI 变没变」只能用 poiX/poiY，不能用 hx/hy —— 见 NpcRt.poiX 的说明
    if (idx === rt.slot && hx === rt.poiX && hy === rt.poiY) {
      // 同一个 POI，那就只可能是**半径**被编辑过了
      rt.roam = roam
      // ⚠️ 半径收窄后人可能已经在圈外，这时**必须让它自己走回去**。
      // 拴绳是一帧到位的夹取（`k = (roam+0.5)/dd`），不是逐帧收敛 ——
      // 把 12 改成 1，下一帧人就被瞬移十来格
      if (rt.phase !== 'travel' && torusDist(rt.x, rt.y, rt.hx, rt.hy) > rt.roam) {
        rt.tx = rt.hx
        rt.ty = rt.hy
        rt.detour = null
        rt.stuck = 0
        rt.lastD = Infinity
        beginTravel(rt)
      }
      return
    }
    rt.slot = idx
    rt.poiX = hx
    rt.poiY = hy
    rt.hx = hx
    rt.hy = hy
    rt.roam = roam
    rt.detour = null
    rt.stuck = 0
    rt.lastD = Infinity
    rt.stranded = false
    // 已经在目的地附近就不必专程走一趟
    if (torusDist(rt.x, rt.y, rt.hx, rt.hy) <= rt.roam) return
    rt.tx = rt.hx
    rt.ty = rt.hy
    beginTravel(rt)
  }

  function makeNpcRig(npc: RpgNpc): CharacterRig {
    return createFigureRig({
      THREE: scene.THREE,
      seed: fnv1a(npc.id),
      material: scene.figureMaterial,
    })
  }

  function syncNpcs(): void {
    // 删掉已经不存在的
    for (const [id, rig] of npcRigs) {
      if (npcs.some((n) => n.id === id)) continue
      scene.removeRig(rig)
      rig.dispose()
      npcRigs.delete(id)
      npcRt.delete(id)
    }
    for (const n of npcs) {
      let rig = npcRigs.get(n.id)
      if (!rig) {
        rig = makeNpcRig(n)
        npcRigs.set(n.id, rig)
        scene.addRig(rig)
      }
      const rt = initRt(n)
      scene.placeRig(rig, rt.x, rt.y)
    }
  }
  // ⚠️ 先立锚点再摆人：placeRig 按「离玩家最近的环面镜像」定位，
  // 而 scene 里的锚点默认在世界中心。start() 走不到（比如启动报错）时，
  // 首次摆放会永久停在错误的镜像上
  scene.setPlayer(px, py)
  syncNpcs()
  // 天色要在**第一帧之前**就定好。只在 minuteChanged 时刷新的话，存档记着
  // 深夜 23:00 进游戏会先亮一下白天再暗下去；timeScale=0（冻结）的世界
  // 更是永远停在白天
  scene.setTimeOfDay(Math.floor(clockTotal) % MINUTES_PER_DAY)

  // 窗口/容器尺寸变化要跟着走，否则转屏后画面被拉伸
  const ro = new ResizeObserver(() => scene.resize(host.clientWidth, host.clientHeight))
  ro.observe(host)
  scene.resize(host.clientWidth, host.clientHeight)

  /**
   * 轴分离的碰撞。
   *
   * 两个轴分开试探，而不是整体一次判定 —— 这样贴着墙斜着走时会**沿墙滑行**，
   * 而不是整个停住。后者手感很差：明明只有 x 方向被挡，人却完全动不了。
   */
  function tryMove(nx: number, ny: number): void {
    if (world.walkableAt(nx + Math.sign(nx - px) * RADIUS, py)) px = nx
    if (world.walkableAt(px, ny + Math.sign(ny - py) * RADIUS)) py = ny
    // 回绕：走出世界边界就从另一头进来，这是「绕一圈」的落点
    px = ((px % world.params.width) + world.params.width) % world.params.width
    py = ((py % world.params.height) + world.params.height) % world.params.height
  }

  let raf = 0
  let last = 0
  let running = false

  const handle: EngineHandle = {
    scene,
    input,
    position: () => ({ x: px, y: py }),
    moving: () => isMoving,
    nearNpc: () => near,
    tool: () => curTool,
    setTool(t) {
      curTool = t
    },
    actionTarget,
    consumeCreature,
    worldVersion: () => worldVer,
    notifyWorldChanged,
    setNpcs(list) {
      npcs = list
      syncNpcs()
    },
    findNpcSpot,
    /**
     * NPC 此刻的处境一句话。
     *
     * ⚠️ **不带自己的【】标签** —— 外层 builder 会把整块包进【场景】，
     * 自带一个就成了标签套标签。
     *
     * ⚠️ 地点永远报**实际所在**，不是意图。走不到目的地时（卡死阶梯的最后一级）
     * 说的是「在森林里，正要去田里干活」—— 诚实，而且比假装它已经到了更有戏。
     */
    npcStateText(id: string): string {
      const rt = npcRt.get(id)
      if (!rt) return ''
      const n = npcs.find((x) => x.id === id)
      const c = clockOf(clockTotal)
      const hh = String(Math.floor(c.minuteOfDay / 60)).padStart(2, '0')
      const mm = String(c.minuteOfDay % 60).padStart(2, '0')
      const when = `${phaseLabel(phaseOf(c.minuteOfDay))} ${hh}:${mm}`
      const area = world.describeArea(rt.x, rt.y)
      const poi = n?.routine?.pois[rt.slot]
      let act: string
      if (rt.phase === 'travel' && poi) act = `正赶去${poi.label}`
      // 没走到就照实说「正要去」。地点报的是实际所在，于是整句读作
      //「在谷仓边，正要去田里照看庄稼」—— 诚实，而且比假装它已经到了更有戏
      else if (rt.stranded && poi) act = `本想去${poi.label}${poi.act}，一时没能过去`
      else if (rt.phase === 'walk') act = '正在附近踱步'
      else if (poi && phaseOf(c.minuteOfDay) === 'lateNight' && rt.slot === 0) act = '已经歇下'
      else act = poi ? `正${poi.act}` : '正站在原地歇脚'
      return `此刻是${when}，对方在${area}，${act}。你走上前与它搭话。`
    },
    rederiveRoutine(id: string): RpgRoutine | null {
      const n = npcs.find((x) => x.id === id)
      const rt = npcRt.get(id)
      if (!n || !rt) return null
      // 以**此刻站的地方**为锚点，而不是 homeX/homeY：用户按这个键，多半正是
      // 因为把 NPC 挪到了新地方，想让它按新邻里过日子
      const anchor = { x: Math.floor(rt.x), y: Math.floor(rt.y) }
      n.homeX = anchor.x
      n.homeY = anchor.y
      n.routine = autoRoutine(world, n, anchor) ?? fallbackRoutine(world, anchor)
      rt.slot = -1
      rt.poiX = NaN
      rt.poiY = NaN
      rt.detour = null
      rt.stuck = 0
      rt.lastD = Infinity
      rt.stranded = false
      rt.route = []
      rt.routeIdx = 0
      rt.routePending = false
      rt.phase = 'idle'
      rt.t = 0.2
      return n.routine
    },
    clock: () => clockOf(clockTotal),
    setClockPaused(v: boolean) {
      clockPaused = v
    },
    addClockMinutes(n: number) {
      clockTotal += n
    },
    start() {
      if (running) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(tick)
    },
    stop() {
      running = false
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    },
    dispose() {
      handle.stop()
      ro.disconnect()
      for (const rig of npcRigs.values()) {
        scene.removeRig(rig)
        rig.dispose()
      }
      npcRigs.clear()
      npcRt.clear()
      // 生物的几何是一只一份，交还给场景去释放
      for (let i = creatures.length - 1; i >= 0; i--) despawnCreature(i)
      scene.removeRig(player)
      player.dispose()
      input.dispose()
      scene.dispose()
      scene.canvas.remove()
    },
  }

  function tick(now: number): void {
    if (!running) return
    const dt = Math.min((now - last) / 1000, MAX_DT)
    last = now

    // 时钟跟着 dt 走，不反推墙钟 —— dt 已被 MAX_DT 夹住，所以切走标签页再回来
    // **不会快进**，世界在你不看的时候就该是停着的（见 time.ts 的说明）。
    // 对话期间冻结：模型花的是现实时间，故事里你们只是交换了几句话
    //
    // ⚠️ 「上一分钟」必须**跨帧记住**，不能在本帧开头现读 clockTotal。
    // addClockMinutes（每说完一句推进 5 分钟）是在两帧**之间**改的值，
    // 现读的话那 5 分钟已经算进 prevMinute 里，minuteChanged 恒为 false ——
    // 换段与天色都收不到这次跳变。timeScale=0 的世界里这就是永久的。
    if (!clockPaused) clockTotal += dt * timeScale
    const clockMinuteOfDay = Math.floor(clockTotal) % MINUTES_PER_DAY
    const minuteChanged = Math.floor(clockTotal) !== lastMinute
    lastMinute = Math.floor(clockTotal)
    // 天色也是每游戏分钟更新一次，不是每帧
    if (minuteChanged) scene.setTimeOfDay(clockMinuteOfDay)

    // 到点的采集格长回来。每游戏分钟问一次，不是每帧 —— 刷新粒度本来就是分钟级
    if (minuteChanged && args.harvest) {
      for (const c of args.harvest.takeExpired(clockTotal)) notifyWorldChanged(c.x, c.y)
    }

    // 数字键选工具。槽位号从 1 起（与快捷栏上印的数字一致）
    const slot = input.consumeSlot()
    if (slot !== null) {
      const t = TOOLS[slot - 1]
      if (t) curTool = t.id
    }

    const dir = input.direction()
    isMoving = dir.active
    if (dir.active) {
      // 输入是屏幕方向（W=屏幕上方），相机带着 45° 偏航 —— 旋进世界坐标后
      // 角色才真正朝屏幕上方走。旋转矩阵与 scene 的 yaw 同源，手感与视角解耦
      const cy = Math.cos(scene.yaw)
      const sy = Math.sin(scene.yaw)
      const wx = dir.x * cy + dir.y * sy
      const wy = -dir.x * sy + dir.y * cy
      tryMove(px + wx * SPEED * dt, py + wy * SPEED * dt)
      player.setFacing(wx, wy)
    }
    player.play(dir.active ? 'walk' : 'idle')
    player.update(dt)

    // ⚠️ 必须在 NPC 之前更新渲染锚点：placeRig 要按「离玩家最近的环面镜像」
    // 摆人，用上一帧的锚点会让接缝附近的 NPC 慢一帧才归位
    scene.setPlayer(px, py)

    // 每帧最多算这么多次 A*。防「同一游戏分钟全村同时通勤」在一帧里挤爆寻路 ——
    // 超预算的 NPC 这一帧先走贪心，routePending 留着，下一帧补算（作息本就有抖动，
    // 真同时起程的极少）。这是每帧预算不变量的一部分：绝不让一帧里的寻路无上限。
    let astarBudget = 4

    // NPC 漫游：锚点半径内走走停停;玩家走近(够得着交谈)就停下转身看你
    for (const n of npcs) {
      const rig = npcRigs.get(n.id)
      const rt = npcRt.get(n.id)
      if (!rig || !rt) continue
      // 换段只在游戏分钟跳变时算一次，不是每帧。
      // `slot < 0` 是首次挂载：不补这一条的话 timeScale=0（文档写明「冻结」）
      // 的世界永远等不到 minuteChanged，NPC 一辈子拿不到 POI，
      // 提示词里人人都「站在原地歇脚」
      if (minuteChanged || rt.slot < 0) enterSlot(n, rt, clockMinuteOfDay)
      const frozen = torusDist(rt.x, rt.y, px, py) < NPC_REACH
      if (frozen) {
        // ⚠️ 这里**不能动 rt.phase**。原先无条件置成 idle，加上 travel 之后
        // 就意味着：玩家从一个正在赶路的 NPC 身边走过，它会**永久忘记自己在
        // 赶路**，卡在半路直到下一次换段。只冻住运动，不改它的意图
        rt.t = 1.5 + Math.random() * 2 // 玩家走开后缓一缓再动
        // ⚠️ 朝向也要走环面最短位移：接缝对面一格的 NPC，裸差值会是 255，
        // 它会转身朝**反方向**看一个隔着大半个世界的你
        rig.setFacing(wrapDelta(px - rt.x, W), wrapDelta(py - rt.y, H))
        rig.play('idle')
      } else if (rt.phase === 'idle') {
        rt.t -= dt
        if (rt.t <= 0) {
          let picked = false
          for (let i = 0; i < 6 && !picked; i++) {
            const a = Math.random() * Math.PI * 2
            const d = Math.random() * rt.roam
            const gx = rt.hx + Math.cos(a) * d
            const gy = rt.hy + Math.sin(a) * d
            if (canStand(gx, gy)) {
              rt.tx = gx
              rt.ty = gy
              rt.phase = 'walk'
              picked = true
            }
          }
          if (!picked) rt.t = 1 + Math.random() * 2
        }
        rig.play('idle')
      } else {
        const travelling = rt.phase === 'travel'
        // 起程时按每帧预算算一次 A* 路径（世界静态，一条路算出来就一直有效）。
        // 失败/超限返回 null → route 空 → 回落到贪心 + 卡死阶梯，与从前完全一样
        if (travelling && rt.routePending && astarBudget > 0) {
          astarBudget--
          rt.routePending = false
          rt.route =
            findPath(
              world,
              canStand,
              Math.floor(rt.x),
              Math.floor(rt.y),
              Math.floor(rt.tx),
              Math.floor(rt.ty),
            ) ?? []
          rt.routeIdx = 0
        }
        // 有 A* 航点就逐点走；没有（求路失败或还没轮到）就回落到贪心（含绕行点）
        const followingRoute = travelling && rt.route.length > 0
        const goalX = followingRoute
          ? rt.route[rt.routeIdx]!.x
          : travelling && rt.detour
            ? rt.detour.x
            : rt.tx
        const goalY = followingRoute
          ? rt.route[rt.routeIdx]!.y
          : travelling && rt.detour
            ? rt.detour.y
            : rt.ty
        // 轴分离试探（与玩家同一套手感：贴墙会滑行）
        const step = Math.min((travelling ? NPC_TRAVEL_SPEED : NPC_SPEED) * dt, 0.2)
        // ⚠️ 必须是**环面**位移。裸差值会让接缝对面的目标看起来在 251 格之外，
        // NPC 于是朝反方向绕大半个世界走 —— 而卡死阶梯量的是环面距离，
        // 看到它「越走越远」，3 秒后就地放弃。表现为「农夫永远到不了自家田里」，
        // 而那块田其实只有 12 步。
        const mdx = wrapDelta(goalX - rt.x, W)
        const mdy = wrapDelta(goalY - rt.y, H)
        const mx = Math.abs(mdx) < 0.03 ? 0 : Math.sign(mdx) * Math.min(step, Math.abs(mdx))
        const my = Math.abs(mdy) < 0.03 ? 0 : Math.sign(mdy) * Math.min(step, Math.abs(mdy))
        if (mx !== 0) {
          if (canStand(rt.x + mx + Math.sign(mx) * NPC_RADIUS, rt.y)) rt.x += mx
          // ⚠️ 漫游时撞墙就放弃这个分量（rt.tx = rt.x），但**通勤时不能放弃** ——
          // 那等于取消通勤。保留目标，让另一个轴带着滑过去
          else if (!travelling) rt.tx = rt.x
        }
        if (my !== 0) {
          if (canStand(rt.x, rt.y + my + Math.sign(my) * NPC_RADIUS)) rt.y += my
          else if (!travelling) rt.ty = rt.y
        }
        // 走过接缝就回绕，坐标始终留在 [0,W)×[0,H)
        rt.x = ((rt.x % W) + W) % W
        rt.y = ((rt.y % H) + H) % H

        const reached =
          Math.abs(wrapDelta(goalX - rt.x, W)) <= 0.05 &&
          Math.abs(wrapDelta(goalY - rt.y, H)) <= 0.05
        if (reached && followingRoute) {
          // 到当前航点就切下一个；走完最后一个航点 = 到达 POI
          rt.routeIdx++
          if (rt.routeIdx >= rt.route.length) {
            rt.route = []
            rt.phase = 'idle'
            rt.t = 2 + Math.random() * 4
            rig.play('idle')
          } else {
            rig.play('walk') // 继续走向下一个航点
          }
        } else if (reached && travelling && rt.detour) {
          // 到了绕行点，续原目标
          rt.detour = null
          rt.stuck = 0
          rt.lastD = Infinity
        } else if (reached) {
          rt.phase = 'idle'
          rt.t = 2 + Math.random() * 4
          rig.play('idle')
        } else {
          rig.setFacing(mx || mdx, my || mdy)
          rig.play('walk')
        }

        // 沿 A* 航点走时不跑卡死阶梯、不拴绳：路是静态可走的、逐点必达
        if (travelling && !followingRoute) {
          // 卡死阶梯：每 0.75s 量一次到目标的距离，没进展就插一个垂直绕行点；
          // 再不行就**体面放弃** —— 绝不瞬移
          rt.t -= dt
          if (rt.t <= 0) {
            rt.t = 0.75
            const d = torusDist(rt.x, rt.y, rt.tx, rt.ty)
            if (rt.lastD - d < 0.05) rt.stuck++
            else rt.stuck = 0
            rt.lastD = d
            if (rt.stuck === 1 && !rt.detour) {
              // 朝目标方向的法向偏 2.5 格。左右由 id 哈希定：确定性，
              // 而且全村不会同时朝一边闪
              const ux = wrapDelta(rt.tx - rt.x, W)
              const uy = wrapDelta(rt.ty - rt.y, H)
              const len = Math.hypot(ux, uy) || 1
              const side = fnv1a(n.id) & 1 ? 1 : -1
              const cand = {
                x: rt.x + (-uy / len) * 2.5 * side,
                y: rt.y + (ux / len) * 2.5 * side,
              }
              if (canStand(cand.x, cand.y)) rt.detour = cand
            } else if (rt.stuck >= 4) {
              // 走不到就把锚点改成当前位置，转 idle。
              // npcStateText 会照实说它在哪，作息只负责解释「为什么要去」
              rt.hx = rt.x
              rt.hy = rt.y
              rt.phase = 'idle'
              rt.t = 2 + Math.random() * 3
              rt.stuck = 0
              // ⚠️ 必须记下「没走到」。不记的话 npcStateText 会回到「正在
              // 照看庄稼」那一支 —— 人站在谷仓边，提示词却说它在田里干活，
              // 等于拿假情境喂模型。放弃可以，撒谎不行
              rt.stranded = true
            }
          }
        } else if (!travelling) {
          // 硬拴绳:无论怎么撞怎么滑,绝不离开锚点半径(+半格容差)。
          // ⚠️ 只在漫游时生效 —— 通勤时的目的地本身就是绳子
          //
          // ⚠️ 必须走环面位移。裸差值在接缝两侧会算出 ~W 的假距离,拴绳当场判定
          // 「跑太远」并把人**拽过大半个世界** —— 正是本模块一再拒绝的瞬移。
          // 作息把这条从「几乎撞不上」变成「随时可能」:POI 是按地标找的,
          // 完全可能落在锚点的接缝对面。
          const ddx = wrapDelta(rt.x - rt.hx, W)
          const ddy = wrapDelta(rt.y - rt.hy, H)
          const dd = Math.hypot(ddx, ddy)
          if (dd > rt.roam + 0.5) {
            const k = (rt.roam + 0.5) / dd
            rt.x = (((rt.hx + ddx * k) % W) + W) % W
            rt.y = (((rt.hy + ddy * k) % H) + H) % H
            rt.phase = 'idle'
            rt.t = 1
          }
        }
      }
      rig.update(dt)
      scene.placeRig(rig, rt.x, rt.y)
      // 跨格才写回落盘对象 —— nearestNpc/编辑器读的都是格坐标。
      // 取模：漫游/绕行的目标点算在锚点周围,可能落到 [0,W) 之外,
      // 直接 floor 会把 -1 这种坐标存进档
      const tileX = Math.floor(((rt.x % W) + W) % W)
      const tileY = Math.floor(((rt.y % H) + H) % H)
      if (tileX !== n.x || tileY !== n.y) {
        n.x = tileX
        n.y = tileY
        handle.onNpcMoved?.()
      }
    }
    // 生物在 NPC 之后更新：它们也要按「离玩家最近的环面镜像」摆位，
    // 而那个锚点是本帧前面的 scene.setPlayer 定的
    updateCreatures(dt)
    near = nearestNpc(npcs, px, py, world.params.width, world.params.height)

    scene.placeRig(player, px, py)
    scene.render()
    handle.onTick?.(dt)

    raf = requestAnimationFrame(tick)
  }

  // 先摆一次，避免 start() 之前画面里没有角色
  scene.setPlayer(px, py)
  scene.placeRig(player, px, py)
  scene.render()

  return handle
}
