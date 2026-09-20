/**
 * 世界场景：把渲染器、相机、chunk 调度、输入、帧循环编排起来。
 *
 * ## 与旧实现的分水岭
 * 旧的 `worldScene` 自己调 `createTerrain` —— 生成与渲染耦合在一个闭包里。
 * 现在**地形是传进来的**（`grid`），本文件只负责把它画出来。
 * 于是生成可以进 Worker、可以缓存、可以在向导里预览，而渲染层一无所知。
 *
 * ## 帧预算
 * 渲染之后把本帧剩余时间交给 chunkManager.pump()。目标 16.7ms，
 * 渲染用掉多少就剩多少，不写死「每帧建 N 块」。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import * as THREE from 'three/webgpu'
import { CHUNK, WORLD_SIZE } from '../core/constants'
import { delta, wrap } from '../core/torus'
import { Flag, type WorldGrid } from '../generation/grid'
import type { NpcBlueprint, WorldSave } from '@/types/infiniteWorld'
import { createNpcSim, type NpcSim } from '../simulation/npcSim'
import { createNpcLayer, type NpcLayer } from './npcLayer'
import { createPlayerSprite, type Facing, type PlayerSprite } from './playerSprite'
import { wadingDepth, movementSpeed } from './wading'
import { createWadingRipples } from './wadingRipples'
import { createPlayerMotion } from './playerMotion'
import { createMaskTextures } from './atlas'
import { createWorldCamera } from './camera'
import { createChunkManager } from './chunkManager'
import { createChunkMeshDeps, disposeChunkMeshDeps } from './chunkMesh'
import { absorbSeamJump, createFrameUniforms } from './frame.tsl'
import { buildGroundField } from './groundField'
import { loadGroundTextures } from './groundTextures'
import { loadSpriteAtlas } from './spriteAtlas'
import { createRenderer } from './renderer'
import { createWorldClock, sampleDayNight } from '../simulation/dayNight'
import { createNightLightField } from './nightLightField'
import { createNightLamps } from './nightLamps'
import { createSpriteShadowTarget, createSpriteShadowMap } from './spriteShadowMap'

export interface WorldSceneSummary {
  day: number
  minute: number
  x: number
  y: number
  fps: number
  backend: 'webgpu' | 'webgl'
  visibleChunks: number
  drawCalls: number
  /** 交谈范围内最近的居民（供「按 E 交谈」提示） */
  nearNpcId?: string
  nearNpcName?: string
}

export interface NearNpc {
  id: string
  name: string
  x: number
  y: number
}

export interface WorldSceneHandle {
  readonly backend: 'webgpu' | 'webgl'
  /** 触屏摇杆 / 键盘方向 */
  direction(x: number, y: number): void
  pause(v: boolean): void
  position(): [number, number]
  /** 交谈范围内最近的居民，没有则 null */
  nearestNpc(): NearNpc | null
  /** 取一份可落盘的存档快照 */
  snapshot(): WorldSave
  /** 落盘成功后回填乐观锁版本号 */
  revision(v: number): void
  dispose(): void
}

export interface MountOptions {
  host: HTMLElement
  grid: WorldGrid
  /** 初始存档。snapshot() 在它之上覆盖位置与时间 */
  save: WorldSave
  /** 世界居民。按日程在世界里活动 */
  npcs?: NpcBlueprint[]
  /** 起始位置。不传则用 grid.spawn */
  start?: [number, number]
  /** Optional fixed camera for reproducible reference captures; movement remains active. */
  cameraFocus?: [number, number]
  /** Reproducible capture scenes can begin at a frozen animation time. */
  startPaused?: boolean
  /** 一天多少现实分钟 */
  dayMinutes?: number
  forceWebGL?: boolean
  onSummary?: (s: WorldSceneSummary) => void
  onMessage?: (text: string) => void
  onDeviceLost?: (reason: string) => void
}

/** 低频摘要的推送间隔。100ms 是为了让「按 E 交谈」的提示不会明显滞后 */
const SUMMARY_MS = 100

export async function mountWorldScene(o: MountOptions): Promise<WorldSceneHandle> {
  const canvas = document.createElement('canvas')
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  // 不写这条，移动端拖动会变成页面滚动
  canvas.style.touchAction = 'none'
  o.host.appendChild(canvas)

  const boot = await createRenderer({ canvas, forceWebGL: o.forceWebGL })
  const scene = new THREE.Scene()
  // ⚠️ 背景色绝不能取成和草地相近的绿。
  // 一开始设的 #9fb08a 与草地底色 #94a66d 几乎一样，结果地形明明画出来了，
  // 看起来却像「什么都没渲染」—— 只有森林和土路那些异色区块能看见，
  // 白白往「面剔除 / 相机 / 可见性」上查了一圈。背景是天空，就该是天空色。
  scene.background = new THREE.Color('#b8cbd8')

  const cam = createWorldCamera()
  const shadowTarget = createSpriteShadowTarget()
  const frame = createFrameUniforms(createNightLightField(o.grid), shadowTarget.texture)
  const objectShadows = createSpriteShadowMap(boot.renderer, shadowTarget, frame)
  const masks = createMaskTextures()
  // ⚠️ 必须在建任何 chunk 之前载完贴图：chunkBuild 要用 palette 算层号与色调补偿，
  // 而已经建好的 chunk 不会因为贴图后到就重建。本地 fetch，约几十毫秒
  const ground = await loadGroundTextures({
    baseUrl: o.grid.generatorVersion === 'torus-4' ? '/world/v6' : '/world/v5',
    maxAnisotropy: maxAnisotropyOf(boot.renderer),
    onMessage: o.onMessage,
  })
  // 自然面软混合场：从常驻网格模糊出来，挂载时算一次
  const groundField = buildGroundField(o.grid)
  const spriteAtlas = await loadSpriteAtlas({
    baseUrl: o.grid.generatorVersion === 'torus-4' ? '/world/v6' : '/world/v5',
    maxAnisotropy: maxAnisotropyOf(boot.renderer),
    onMessage: o.onMessage,
  })
  const deps = createChunkMeshDeps(masks, ground, groundField, spriteAtlas, frame)
  const chunks = createChunkManager(o.grid, scene, deps, () => cam.viewR2)

  // ── NPC 仿真 + 渲染 ──
  let npcSim: NpcSim | null = null
  let npcLayer: NpcLayer | null = null
  const npcNames = new Map<string, string>((o.npcs ?? []).map((n) => [n.npcId, n.name]))
  if (o.npcs && o.npcs.length > 0) {
    npcSim = createNpcSim(o.grid, o.npcs)
    npcLayer = createNpcLayer(spriteAtlas, frame)
    if (npcLayer) scene.add(npcLayer.mesh, npcLayer.shadow)
  }

  // ── 玩家角色 ──
  const player: PlayerSprite | null = createPlayerSprite(spriteAtlas, frame)
  if (player) scene.add(player.mesh, player.shadow)
  const lamps = createNightLamps(o.grid, spriteAtlas, frame)
  scene.add(lamps.mesh)
  const ripples = createWadingRipples(frame, groundField.contours)
  scene.add(ripples.mesh)
  const contourImage = groundField.contours.image
  const depthAt = (x: number, y: number) =>
    wadingDepth(o.grid, contourImage.data as Uint8Array, contourImage.width, x, y)
  let facing: Facing = 'down'
  const playerMotion = createPlayerMotion()

  /** 交谈范围（格）。俯角下约两格内视为「站到跟前」 */
  const INTERACT_RANGE2 = 2.4 * 2.4
  function nearestNpc(): NearNpc | null {
    if (!npcSim) return null
    let best: NearNpc | null = null
    let bestD2 = INTERACT_RANGE2
    for (const n of npcSim.npcs) {
      const dx = delta(px, n.x)
      const dy = delta(py, n.y)
      const d2 = dx * dx + dy * dy
      if (d2 < bestD2) {
        bestD2 = d2
        best = { id: n.id, name: npcNames.get(n.id) ?? '居民', x: n.x, y: n.y }
      }
    }
    return best
  }

  // ── 玩家状态 ──
  let px = o.save.playerPosition?.[0] ?? o.start?.[0] ?? o.grid.spawn[0]
  let py = o.save.playerPosition?.[1] ?? o.start?.[1] ?? o.grid.spawn[1]
  let dirX = 0
  let dirY = 0
  let paused = o.startPaused ?? false
  let minute = o.save.minute ?? 7 * 60
  let day = o.save.day ?? 1
  let revision = o.save.revision
  const dayMinutes = o.dayMinutes ?? 20
  const clock = createWorldClock(day, minute, dayMinutes)
  function updateLighting() {
    const light = sampleDayNight(minute, o.save.weather)
    frame.dayTint.value.setRGB(...light.tint)
    frame.sunAmount.value = light.sun
    frame.shadowVector.value.set(...light.shadow)
    frame.shadowOpacity.value = light.shadowOpacity
    frame.lampAmount.value = light.lamps
    ;(scene.background as THREE.Color).setRGB(
      light.tint[0] * 0.52,
      light.tint[1] * 0.68,
      light.tint[2] * 0.8,
    )
  }
  // A paused or night-time save must have the correct lighting on its very first frame.
  updateLighting()

  const walkableAt = (x: number, y: number): boolean => {
    const i = idx(x, y)
    return (o.grid.flags[i]! & Flag.Walkable) !== 0
  }

  // ── 视口 ──
  const resize = () => {
    const w = o.host.clientWidth || 1
    const h = o.host.clientHeight || 1
    boot.renderer.setSize(w, h, false)
    cam.resize(w, h)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(o.host)
  resize()

  // ── 键盘 ──
  const keys = new Set<string>()
  const onKeyDown = (e: KeyboardEvent) => {
    keys.add(e.key.toLowerCase())
  }
  const onKeyUp = (e: KeyboardEvent) => {
    keys.delete(e.key.toLowerCase())
  }
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  const clearInput = () => {
    keys.clear()
    dirX = 0
    dirY = 0
  }
  window.addEventListener('blur', clearInput)

  function readKeys(): [number, number] {
    let x = 0
    let y = 0
    if (keys.has('a') || keys.has('arrowleft')) x -= 1
    if (keys.has('d') || keys.has('arrowright')) x += 1
    if (keys.has('w') || keys.has('arrowup')) y -= 1
    if (keys.has('s') || keys.has('arrowdown')) y += 1
    return [x, y]
  }

  // 首帧：同步建完最内圈，避免揭幕时一片空白
  chunks.warmup(px, py, 2)
  cam.focus(...(o.cameraFocus ?? ([px, py] as [number, number])))

  // ── 帧循环 ──
  let raf = 0
  let last = performance.now()
  let lastSummary = 0
  let fpsAccum = 0
  let fpsFrames = 0
  let fps = 0
  let disposed = false
  let deviceLost = false

  boot.onLost((reason) => {
    // ⚠️ 设备丢失后必须停掉 RAF。继续 render() 会刷一屏错误，
    // 还会掩盖掉真正的丢失原因
    deviceLost = true
    o.onDeviceLost?.(reason)
  })

  const tick = (now: number) => {
    if (disposed || deviceLost) return
    raf = requestAnimationFrame(tick)
    const frameStart = now
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now

    let travel = 0
    if (!paused) {
      // ── 移动：分轴，防止对角贴着障碍物卡住 ──
      const [kx, ky] = readKeys()
      const mx = kx || dirX
      const my = ky || dirY
      if (mx !== 0 || my !== 0) {
        // 朝向：主轴决定。my>0=下(正面) my<0=上(背面)；mx 决定左右
        if (Math.abs(my) >= Math.abs(mx)) facing = my > 0 ? 'down' : 'up'
        else facing = mx > 0 ? 'right' : 'left'
        const len = Math.hypot(mx, my) || 1
        const speed = movementSpeed(o.grid, px, py, depthAt(px, py))
        const step = speed * dt
        const nx = wrap(px + (mx / len) * step)
        const ny = wrap(py + (my / len) * step)
        // ⚠️ 分轴判定：对角移动时若只有一轴被挡，应当沿墙滑行而不是整体停住
        const prevX = px
        const prevY = py
        if (walkableAt(nx, py)) px = nx
        if (walkableAt(px, ny)) py = ny
        travel = Math.hypot(delta(prevX, px), delta(prevY, py))

        // ── 跨接缝补偿 ──
        // 走过 x=511.99 → x=0.004 时渲染坐标整体挪了 512，
        // 按渲染坐标取样的噪声会全部重掷。这里把那一跳吸收掉。
        absorbSeamJump(frame, px - prevX, py - prevY, delta(prevX, px), delta(prevY, py))
      }

      // ── 时钟 ──
      clock.step(dt)
      minute = clock.minute
      day = clock.day
      frame.windTime.value += dt
      updateLighting()
      // NPC 按日程活动（暂停时冻结）
      npcSim?.step(dt, minute, px, py)
    }

    cam.focus(...(o.cameraFocus ?? ([px, py] as [number, number])))
    chunks.focus(px, py)
    // NPC 位置每帧写进实例缓冲（就近镜像）
    npcLayer?.update(npcSim?.npcs ?? [], px, py)
    // 玩家角色：朝向 + 行走颠簸
    const motion = playerMotion.step(dt, travel, paused)
    const depth = depthAt(px, py)
    player?.update(px, py, facing, motion.phase, motion.moving, depth)
    ripples.update(px, py, depth)
    lamps.update(px, py)
    objectShadows.update(
      scene,
      px,
      py,
      Math.max(80, (cam.camera.right - cam.camera.left) * 1.5 + 32),
    )
    boot.renderer.render(scene, cam.camera)

    // 渲染用掉多少，剩下的交给建块队列
    const spent = performance.now() - frameStart
    chunks.pump(Math.max(0, 14 - spent))

    // ── 低频摘要 ──
    fpsAccum += dt
    fpsFrames++
    if (now - lastSummary >= SUMMARY_MS) {
      fps = fpsFrames / Math.max(1e-6, fpsAccum)
      fpsAccum = 0
      fpsFrames = 0
      lastSummary = now
      const near = nearestNpc()
      o.onSummary?.({
        day,
        minute: Math.floor(minute),
        x: px,
        y: py,
        fps,
        backend: boot.backend,
        visibleChunks: chunks.stats.visible,
        drawCalls: chunks.stats.drawCalls,
        nearNpcId: near?.id,
        nearNpcName: near?.name,
      })
    }
  }
  raf = requestAnimationFrame(tick)

  // 开发期调试钩子：在控制台里 __world 可以看到相机、chunk、玩家的实时状态。
  // 生产构建里 import.meta.env.DEV 为 false，整块会被摇树掉。
  if (import.meta.env.DEV) {
    ;(globalThis as unknown as Record<string, unknown>).__world = {
      debugSurfaceLighting(enabled: boolean) {
        frame.surfaceLightAmount.value = Number(enabled)
      },
      debugReceivedShadows(enabled: boolean) {
        frame.receivedShadowAmount.value = Number(enabled)
      },
      debugShadows(enabled: boolean) {
        frame.shadowOpacity.value = enabled
          ? sampleDayNight(minute, o.save.weather).shadowOpacity
          : 0
      },
      get info() {
        const c = cam.camera
        return {
          player: [px, py],
          spriteShadowBatches: objectShadows.count,
          clock: { day, minute, paused },
          lighting: {
            ...sampleDayNight(minute, o.save.weather),
            lampsVisible: lamps.mesh.visible,
            lampCount: (lamps.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount,
          },
          surface: o.grid.surface[idx(px, py)],
          submersion: depthAt(px, py),
          walkSpeed: movementSpeed(o.grid, px, py, depthAt(px, py)),
          playerSize: player?.mesh.geometry.getAttribute('iSize').getX(0),
          playerLayer: player?.mesh.geometry.getAttribute('iLayer').getX(0),
          camPos: c.position.toArray(),
          frustum: [c.left, c.right, c.top, c.bottom],
          viewR2: cam.viewR2,
          chunks: { ...chunks.stats },
          sceneChildren: scene.children.length,
          firstChunk: (() => {
            const g = scene.children.find((o) => o.type === 'Group')
            return g
              ? { pos: g.position.toArray(), visible: g.visible, kids: g.children.length }
              : null
          })(),
        }
      },
    }
  }

  return {
    backend: boot.backend,
    direction(x, y) {
      dirX = x
      dirY = y
    },
    pause(v) {
      paused = v
      if (v) clearInput()
    },
    position: () => [px, py],
    nearestNpc,
    snapshot(): WorldSave {
      // ⚠️ 在传入的 save 之上**覆盖**而不是重建：inventory / money / stamina
      // 这些字段本场景不管，重建会把它们清空
      return {
        ...o.save,
        revision,
        day,
        minute: Math.floor(minute),
        playerPosition: [px, py],
        updatedAt: Date.now(),
      }
    },
    revision(v: number) {
      revision = v
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clearInput)
      if (npcLayer) {
        scene.remove(npcLayer.mesh, npcLayer.shadow)
        npcLayer.dispose()
      }
      if (player) {
        scene.remove(player.mesh, player.shadow)
        player.dispose()
      }
      scene.remove(ripples.mesh)
      ripples.dispose()
      scene.remove(lamps.mesh)
      lamps.dispose()
      frame.lampField.dispose()
      objectShadows.dispose()
      chunks.dispose()
      disposeChunkMeshDeps(deps)
      masks.dispose()
      ground.dispose()
      groundField.dispose()
      spriteAtlas.dispose()
      boot.dispose()
      canvas.remove()
    },
  }
}

/**
 * 各向异性上限。
 *
 * ⚠️ 用 `in` 做运行时能力探测，不靠类型。`@types/three` 比实装落后一个小版本
 * （项目已有的既定做法），而 WebGPURenderer / WebGLRenderer 的这个方法名
 * 在两条后端路径上都存在但类型未必齐。探测不到就返回 1（等于关掉）。
 */
function maxAnisotropyOf(renderer: object): number {
  if ('getMaxAnisotropy' in renderer && typeof renderer.getMaxAnisotropy === 'function') {
    const v = (renderer as { getMaxAnisotropy(): number }).getMaxAnisotropy()
    return Number.isFinite(v) ? v : 1
  }
  return 1
}

function idx(x: number, y: number): number {
  const wx = ((Math.floor(x) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  const wy = ((Math.floor(y) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
  return wy * WORLD_SIZE + wx
}

export { CHUNK }
