/**
 * Chunk 调度：就近镜像、可见性、LRU、分帧建造。
 *
 * ## 就近镜像
 * 环面上每块 chunk 有无数个镜像。每帧把每块挪到**离玩家最近的那个**，
 * 于是玩家走过接缝时地形是连续的，而不是「走到边缘就没有了」。
 *
 *     d  = delta(玩家, 块心)      // 环面最短位移
 *     ox = 玩家 + d - 块心        // 该块要挪多远
 *
 * 剔除也用同一个 d —— 一次计算同时给出「画在哪」和「要不要画」。
 *
 * ## ⚠️ viewR2 必须 clamp
 * 见 camera.ts：越过 `((W-CHUNK)/2)²` 之后，同一块的两个镜像可能同时入画，
 * 「每块只画最近镜像」这个前提就塌了。camera.resize() 已经做了 clamp。
 *
 * ## 为什么跨块不掉帧
 * 四层保障：① 整张网格常驻，建块时零噪声求值；② 分帧建造队列按预算切；
 * ③ 预取环比可见半径大一个 CHUNK，玩家跨块前新一圈已经建好；
 * ④ LRU 缓存 64 块，来回穿越同一片区域零重建。
 *
 * 纯 service：只 import three，不 import vue/pinia。
 */

import { CHUNK, WORLD_SIZE } from '../core/constants'
import { delta } from '../core/torus'
import type { WorldGrid } from '../generation/grid'
import { CHUNKS_PER_SIDE, buildChunk, chunkKey } from './chunkBuild'
import {
  createChunkObject,
  placeChunk,
  setChunkVisible,
  type ChunkMeshDeps,
  type ChunkObject,
} from './chunkMesh'
import type * as THREE from 'three/webgpu'

/** LRU 容量。可见最多约 36 块，64 给来回穿越留足余量 */
const CACHE_LIMIT = 64

export interface ChunkManagerStats {
  live: number
  visible: number
  queued: number
  built: number
  lastBuildMs: number
  drawCalls: number
}

export interface ChunkManager {
  /** 玩家位置变了：重排镜像、更新可见性、补充建造队列 */
  focus(px: number, py: number): void
  /** 每帧渲染之后调用，用掉本帧剩余预算 */
  pump(budgetMs: number): void
  /** 首帧用：同步建完最内圈，避免揭幕时一片空白 */
  warmup(px: number, py: number, rings: number): void
  readonly stats: ChunkManagerStats
  dispose(): void
}

export function createChunkManager(
  grid: WorldGrid,
  scene: THREE.Scene,
  deps: ChunkMeshDeps,
  getViewR2: () => number,
): ChunkManager {
  const palette = deps.ground.palette
  /** key → 已建好的对象 */
  const live = new Map<number, ChunkObject>()
  /** 待建队列，按到玩家的距离排序 */
  let queue: { cx: number; cy: number; d2: number }[] = []
  const queued = new Set<number>()

  let px = 0
  let py = 0
  let built = 0
  let lastBuildMs = 0

  const stats: ChunkManagerStats = {
    live: 0,
    visible: 0,
    queued: 0,
    built: 0,
    lastBuildMs: 0,
    drawCalls: 0,
  }

  /** 把一块挪到最近镜像并决定可见性。返回它到玩家的距离平方 */
  function relayoutOne(c: ChunkObject, viewR2: number): number {
    const dx = delta(px, c.centerX)
    const dy = delta(py, c.centerY)
    const ox = px + dx - c.centerX
    const oy = py + dy - c.centerY
    // ⚠️ placeChunk 内部会 updateMatrix()。绝不要在这里直接改 group.position
    placeChunk(c, ox, oy)
    const d2 = dx * dx + dy * dy
    setChunkVisible(c, d2 < viewR2)
    return d2
  }

  function ensureQueued(cx: number, cy: number, d2: number): void {
    const key = chunkKey(cx, cy)
    if (live.has(key) || queued.has(key)) return
    queued.add(key)
    queue.push({ cx, cy, d2 })
  }

  function buildOne(cx: number, cy: number): void {
    const key = chunkKey(cx, cy)
    queued.delete(key)
    if (live.has(key)) return

    const t0 = performance.now()
    const data = buildChunk(grid, cx, cy, palette, deps.spriteAtlas.meta)
    const obj = createChunkObject(data, deps)
    lastBuildMs = performance.now() - t0
    built++

    scene.add(obj.group)
    live.set(key, obj)
    // ⚠️ 新块必须在挂进场景的**同一帧**摆好位置。
    // 不摆的话它会以 ox=0 画在世界原点闪一帧 —— 玩家在别处时
    // 会看到远方凭空闪出一块地形
    relayoutOne(obj, getViewR2())

    // LRU 逐出：live 是插入序的 Map，最老的在最前
    while (live.size > CACHE_LIMIT) {
      const oldest = live.keys().next().value
      if (oldest === undefined) break
      const victim = live.get(oldest)!
      scene.remove(victim.group)
      victim.dispose()
      live.delete(oldest)
    }
  }

  function focus(nx: number, ny: number): void {
    px = nx
    py = ny
    const viewR2 = getViewR2()
    // 预取环：比可见半径大一个 CHUNK，玩家跨块前新一圈已经建好
    const prefetchR2 = (Math.sqrt(viewR2) + CHUNK) ** 2

    let visible = 0
    let drawCalls = 0
    // ⚠️ **绝不能在这个循环里改 live**。
    //
    // JS 的 Map 迭代会访问「迭代期间新插入」的条目。为了维持 LRU 顺序而在循环里
    // `delete(key)` 再 `set(key, c)`，那个条目会被追加到末尾并**再次被访问**，
    // 于是每帧无限循环 —— 页面整个卡死，而这几行看起来完全正常。
    //
    // 正确做法：先收集，循环结束后再重排。
    const touch: number[] = []
    for (const c of live.values()) {
      const d2 = relayoutOne(c, viewR2)
      if (c.visible) {
        visible++
        drawCalls += c.drawCalls
      }
      if (d2 < prefetchR2) touch.push(chunkKey(c.cx, c.cy))
    }
    // 近处的块重新插到末尾，不会被 LRU 逐出
    for (const key of touch) {
      const c = live.get(key)
      if (!c) continue
      live.delete(key)
      live.set(key, c)
    }

    // 补充待建
    const reach = Math.ceil(Math.sqrt(prefetchR2) / CHUNK) + 1
    const pcx = Math.floor(px / CHUNK)
    const pcy = Math.floor(py / CHUNK)
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const cx = ((pcx + dx) % CHUNKS_PER_SIDE + CHUNKS_PER_SIDE) % CHUNKS_PER_SIDE
        const cy = ((pcy + dy) % CHUNKS_PER_SIDE + CHUNKS_PER_SIDE) % CHUNKS_PER_SIDE
        const centerX = cx * CHUNK + CHUNK / 2
        const centerY = cy * CHUNK + CHUNK / 2
        const ddx = delta(px, centerX)
        const ddy = delta(py, centerY)
        const d2 = ddx * ddx + ddy * ddy
        if (d2 < prefetchR2) ensureQueued(cx, cy, d2)
      }
    }
    queue.sort((a, b) => a.d2 - b.d2)

    stats.live = live.size
    stats.visible = visible
    stats.queued = queue.length
    stats.built = built
    stats.drawCalls = drawCalls
  }

  function pump(budgetMs: number): void {
    if (budgetMs <= 0 || queue.length === 0) return
    const deadline = performance.now() + budgetMs
    while (queue.length > 0) {
      const job = queue.shift()!
      buildOne(job.cx, job.cy)
      stats.lastBuildMs = lastBuildMs
      // ⚠️ 自适应：用实测的建块耗时决定还建不建下一块，
      // 而不是写死「每帧最多 N 块」—— 低端机上一块可能就要 5ms
      if (performance.now() + lastBuildMs > deadline) break
    }
    stats.queued = queue.length
    stats.live = live.size
    stats.built = built
  }

  function warmup(nx: number, ny: number, rings: number): void {
    px = nx
    py = ny
    const pcx = Math.floor(px / CHUNK)
    const pcy = Math.floor(py / CHUNK)
    for (let dy = -rings; dy <= rings; dy++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const cx = ((pcx + dx) % CHUNKS_PER_SIDE + CHUNKS_PER_SIDE) % CHUNKS_PER_SIDE
        const cy = ((pcy + dy) % CHUNKS_PER_SIDE + CHUNKS_PER_SIDE) % CHUNKS_PER_SIDE
        buildOne(cx, cy)
      }
    }
    focus(nx, ny)
  }

  return {
    focus,
    pump,
    warmup,
    stats,
    dispose() {
      for (const c of live.values()) {
        scene.remove(c.group)
        c.dispose()
      }
      live.clear()
      queue = []
      queued.clear()
    },
  }
}

/** 世界坐标 → chunk 坐标 */
export function chunkOf(x: number): number {
  return ((Math.floor(x / CHUNK) % CHUNKS_PER_SIDE) + CHUNKS_PER_SIDE) % CHUNKS_PER_SIDE
}

export { WORLD_SIZE }
