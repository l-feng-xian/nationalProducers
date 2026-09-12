/**
 * 游戏主循环。
 *
 * 把世界、输入、渲染串起来，对外只暴露 `{ start, stop, dispose }` 与几个读值。
 * 刻意做成「可停可弃」而不是全局单例：游戏页会被路由卸载，rAF 与 WebGPU 上下文
 * 都必须干净还回去（这一点与 parallax.ts 那个刻意常驻的渲染器正相反）。
 *
 * 纯 service：不 import vue/pinia。
 */

import type { World } from './world'
import { findSpawn, findStandSpot, wrapDelta } from './world'
import type { CharacterRig } from './rig'
import { createInput, type InputHandle } from './input'
import { createScene, type SceneHandle } from './scene'
import { createFigureRig } from './figureRig'
import { NPC_REACH, nearestNpc, type RpgNpc } from '@/types/rpg'
import { fnv1a } from '@/services/hash'

/** 移动速度，格/秒 */
const SPEED = 5.2
/** NPC 漫游速度。明显慢于玩家 —— 村民散步,不是赶路 */
const NPC_SPEED = 1.6
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

export interface EngineHandle {
  readonly scene: SceneHandle
  readonly input: InputHandle
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
  const player: CharacterRig = createFigureRig({ THREE: scene.THREE, player: true })
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
    phase: 'idle' | 'walk'
    /** idle 剩余秒数 / walk 的目标点 */
    t: number
    tx: number
    ty: number
  }
  const npcRigs = new Map<string, CharacterRig>()
  const npcRt = new Map<string, NpcRt>()
  let npcs: RpgNpc[] = args.npcs ?? []
  let near: RpgNpc | null = null

  const W = world.params.width
  const H = world.params.height

  /** 能站人：陆地且没有实体道具 */
  const canStand = (x: number, y: number): boolean =>
    world.walkableAt(x, y) && !world.blockedAt(x, y)

  /** 环面距离（格） */
  const torusDist = (ax: number, ay: number, bx: number, by: number): number =>
    Math.hypot(wrapDelta(ax - bx, W), wrapDelta(ay - by, H))

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
    }
    npcRt.set(n.id, rt)
    return rt
  }

  function makeNpcRig(npc: RpgNpc): CharacterRig {
    return createFigureRig({ THREE: scene.THREE, seed: fnv1a(npc.id) })
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
    setNpcs(list) {
      npcs = list
      syncNpcs()
    },
    findNpcSpot,
    npcStateText(id: string): string {
      const rt = npcRt.get(id)
      if (!rt) return ''
      const area = world.describeArea(rt.x, rt.y)
      const act = rt.phase === 'walk' ? '正在附近踱步' : '正站在原地歇脚'
      return `【当前情形】对方此刻在${area},${act},你走上前与它交谈。`
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

    // NPC 漫游：锚点半径内走走停停;玩家走近(够得着交谈)就停下转身看你
    for (const n of npcs) {
      const rig = npcRigs.get(n.id)
      const rt = npcRt.get(n.id)
      if (!rig || !rt) continue
      const frozen = torusDist(rt.x, rt.y, px, py) < NPC_REACH
      if (frozen) {
        rt.phase = 'idle'
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
        // 轴分离试探（与玩家同一套手感：贴墙会滑行）;撞墙的分量直接放弃
        const step = Math.min(NPC_SPEED * dt, 0.2)
        const mdx = rt.tx - rt.x
        const mdy = rt.ty - rt.y
        const mx = Math.abs(mdx) < 0.03 ? 0 : Math.sign(mdx) * Math.min(step, Math.abs(mdx))
        const my = Math.abs(mdy) < 0.03 ? 0 : Math.sign(mdy) * Math.min(step, Math.abs(mdy))
        if (mx !== 0) {
          if (canStand(rt.x + mx + Math.sign(mx) * NPC_RADIUS, rt.y)) rt.x += mx
          else rt.tx = rt.x
        }
        if (my !== 0) {
          if (canStand(rt.x, rt.y + my + Math.sign(my) * NPC_RADIUS)) rt.y += my
          else rt.ty = rt.y
        }
        if (Math.abs(rt.tx - rt.x) <= 0.05 && Math.abs(rt.ty - rt.y) <= 0.05) {
          rt.phase = 'idle'
          rt.t = 2 + Math.random() * 4
          rig.play('idle')
        } else {
          rig.setFacing(mx || mdx, my || mdy)
          rig.play('walk')
        }
        // 硬拴绳:无论怎么撞怎么滑,绝不离开锚点半径(+半格容差)
        const ddx = rt.x - rt.hx
        const ddy = rt.y - rt.hy
        const dd = Math.hypot(ddx, ddy)
        if (dd > rt.roam + 0.5) {
          const k = (rt.roam + 0.5) / dd
          rt.x = rt.hx + ddx * k
          rt.y = rt.hy + ddy * k
          rt.phase = 'idle'
          rt.t = 1
        }
      }
      rig.update(dt)
      scene.placeRig(rig, rt.x, rt.y)
      // 跨格才写回落盘对象 —— nearestNpc/编辑器读的都是格坐标
      const tileX = Math.floor(rt.x)
      const tileY = Math.floor(rt.y)
      if (tileX !== n.x || tileY !== n.y) {
        n.x = tileX
        n.y = tileY
        handle.onNpcMoved?.()
      }
    }
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
