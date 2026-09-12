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
import type { CharacterRig } from './rig'
import { createInput, type InputHandle } from './input'
import { createScene, type SceneHandle } from './scene'
import { createPlaceholderRig } from './rig'
import { createSpineRig, loadSpine, type SpineAssetPaths } from './spineRig'

/** 移动速度，格/秒 */
const SPEED = 5.2
/**
 * 单帧最大步进。
 *
 * 标签页切走再回来时 rAF 的 dt 可能是几秒，不夹住的话角色会**瞬移一大段**、
 * 甚至直接穿过水面到对岸 —— 碰撞是按步进采样的，步子迈太大就跨过去了。
 */
const MAX_DT = 0.05

/** 角色的碰撞半径（格）。比 0.5 小，免得贴着岸边就卡住 */
const RADIUS = 0.28
/** 玩家立绘高度（格） */
const PLAYER_H = 1.7

export interface EngineHandle {
  readonly scene: SceneHandle
  readonly input: InputHandle
  /** 玩家实际用的是哪种渲染，UI 上要能看出来是不是降级了 */
  readonly playerRigKind: 'spine' | 'placeholder'
  /** 玩家当前格坐标（浮点，已回绕） */
  position(): { x: number; y: number }
  /** 本帧是否在移动，UI 上要显示 */
  moving(): boolean
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
  /** 玩家的 Spine 资源。不给、或加载失败，都自动退回程序化占位小人 */
  playerSpine?: SpineAssetPaths
}

/**
 * 找一块可以站人的地。
 *
 * 从中心开始按螺旋外扩 —— 直接用中心点的话，种子一换很可能开局站在海里。
 */
function findSpawn(world: World): { x: number; y: number } {
  const cx = Math.floor(world.params.width / 2)
  const cy = Math.floor(world.params.height / 2)
  for (let r = 0; r < 160; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        // 只看当前这一圈的边，内圈上一轮已经查过了
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const x = cx + dx
        const y = cy + dy
        if (world.walkableAt(x, y)) return { x: x + 0.5, y: y + 0.5 }
      }
    }
  }
  return { x: cx + 0.5, y: cy + 0.5 }
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

  // Spine 优先，失败静默退回占位 —— 角色渲染不起来不该把整个场景带崩
  let playerRigKind: 'spine' | 'placeholder' = 'placeholder'
  let player: CharacterRig
  const spineLoad = args.playerSpine ? await loadSpine(args.playerSpine, scene.THREE) : null
  if (spineLoad) {
    player = createSpineRig(spineLoad, {
      THREE: scene.THREE,
      pitch: scene.pitch,
      height: PLAYER_H,
    })
    playerRigKind = 'spine'
  } else {
    player = createPlaceholderRig({ THREE: scene.THREE, pitch: scene.pitch })
  }
  scene.addRig(player)

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
    playerRigKind,
    position: () => ({ x: px, y: py }),
    moving: () => isMoving,
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
      tryMove(px + dir.x * SPEED * dt, py + dir.y * SPEED * dt)
      player.setFacing(dir.x, dir.y)
    }
    player.play(dir.active ? 'walk' : 'idle')
    player.update(dt)

    scene.setPlayer(px, py)
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
