/**
 * 网格 A\* 寻路（需求 3：NPC 的行动路线）。
 *
 * 作息（routine.ts）早已成熟 —— 谁几点该去哪、去干什么都有了。缺的只是**空间**上
 * 怎么走过去：原先是「朝目标直线走 + 撞墙插一个绕行点 + 再不行就体面放弃」，一遇到
 * 湖湾、树林、崖壁就绕不过去。这里补上真正的寻路，跑在引擎那份记忆化的通行网格上。
 *
 * ## 三条硬约束（都是既有不变量，绝不能破）
 * - **环面感知**：邻格、启发式、平滑全走 wrapDelta 最短位移 —— 路可以从接缝穿过去。
 * - **有界**：限制扩展节点数（maxExpand）。超限就返回 null，调用方回落到贪心 + stranded
 *   诚实兜底 —— 宁可这一趟走不到，也绝不冻帧。
 * - **只在起程时算一次**：不是每帧。世界是静态的，一条路算出来就一直有效。
 *
 * ## 偏好走路
 * 道路（roadAt）/村道（pathAt）格的步进代价打折，于是 A\* 会**宁可绕一点也走大路**，
 * 需求 2 的路网与需求 3 的寻路就此咬合：NPC 真的会沿着村道、顺着村与村之间的大路走。
 *
 * 纯 service：不 import vue/pinia。
 */

import { wrapDelta, type World } from './world'

export interface FindPathOpts {
  /** 扩展节点上限。超了就当不可达（回落到贪心）。默认 3000 —— 单段通勤的路很短，
   *  这个上限只是「异常远/被围死」时的刹车 */
  maxExpand?: number
  /** 道路/村道格的步进代价（普通地为 1）。<1 即「偏好走路」。默认 0.55 */
  roadCost?: number
}

interface Cell {
  x: number
  y: number
}

/**
 * 从起点格找一条到目标格的路，返回**格心**航点列表（含终点，不含起点）。
 * 找不到 / 超限 / 目标不可站 → null。起点即终点 → 空数组。
 *
 * @param canStand 引擎那份**记忆化**的通行判定（陆地且无实体道具）。传进来而不是
 *   自己算，是为了复用 standCache —— 否则每次扩邻都要重算三个 fBm。
 */
export function findPath(
  world: World,
  canStand: (x: number, y: number) => boolean,
  startX: number,
  startY: number,
  goalX: number,
  goalY: number,
  opts: FindPathOpts = {},
): Cell[] | null {
  const W = world.params.width
  const H = world.params.height
  const wrap = (v: number, m: number): number => ((v % m) + m) % m
  const sx = wrap(Math.floor(startX), W)
  const sy = wrap(Math.floor(startY), H)
  const gx = wrap(Math.floor(goalX), W)
  const gy = wrap(Math.floor(goalY), H)
  if (sx === gx && sy === gy) return []
  // 目标不可站（POI 落在了水里/道具上）—— 交给调用方兜底，别在这里瞎找
  if (!canStand(gx + 0.5, gy + 0.5)) return null

  const maxExpand = opts.maxExpand ?? 3000
  const roadCost = opts.roadCost ?? 0.55
  const key = (x: number, y: number): number => y * W + x

  // 曼哈顿启发式（4 邻）× 最小步进代价 —— 乘上 roadCost 才保持**可采纳**（h ≤ 实际），
  // A\* 结果才最优；否则偏好走路时会算出次优路
  const heur = (x: number, y: number): number =>
    (Math.abs(wrapDelta(x - gx, W)) + Math.abs(wrapDelta(y - gy, H))) * roadCost

  // ── 二叉最小堆（按 f 排序）。并行数组存，避免每节点一个对象 ──
  const hx: number[] = []
  const hy: number[] = []
  const hf: number[] = []
  const heapPush = (x: number, y: number, f: number): void => {
    let i = hx.length
    hx.push(x)
    hy.push(y)
    hf.push(f)
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hf[p]! <= hf[i]!) break
      ;[hx[p], hx[i]] = [hx[i]!, hx[p]!]
      ;[hy[p], hy[i]] = [hy[i]!, hy[p]!]
      ;[hf[p], hf[i]] = [hf[i]!, hf[p]!]
      i = p
    }
  }
  const heapPop = (): Cell => {
    const rx = hx[0]!
    const ry = hy[0]!
    const last = hx.length - 1
    hx[0] = hx[last]!
    hy[0] = hy[last]!
    hf[0] = hf[last]!
    hx.pop()
    hy.pop()
    hf.pop()
    let i = 0
    const n = hx.length
    for (;;) {
      const l = i * 2 + 1
      const r = l + 1
      let m = i
      if (l < n && hf[l]! < hf[m]!) m = l
      if (r < n && hf[r]! < hf[m]!) m = r
      if (m === i) break
      ;[hx[m], hx[i]] = [hx[i]!, hx[m]!]
      ;[hy[m], hy[i]] = [hy[i]!, hy[m]!]
      ;[hf[m], hf[i]] = [hf[i]!, hf[m]!]
      i = m
    }
    return { x: rx, y: ry }
  }

  const g = new Map<number, number>()
  const came = new Map<number, number>()
  g.set(key(sx, sy), 0)
  heapPush(sx, sy, heur(sx, sy))

  // 4 邻。用 4 连通而不是 8 连通：与道路的 4 连通一致，且不必防「贴角穿模」——
  // 斜穿的自然感靠事后拉直（string-pulling）补回来，而不是靠对角邻格
  const DX = [1, -1, 0, 0]
  const DY = [0, 0, 1, -1]

  let expand = 0
  let found = false
  while (hx.length > 0) {
    const cur = heapPop()
    const ck = key(cur.x, cur.y)
    if (cur.x === gx && cur.y === gy) {
      found = true
      break
    }
    if (++expand > maxExpand) return null
    const cg = g.get(ck)!
    for (let d = 0; d < 4; d++) {
      const nx = wrap(cur.x + DX[d]!, W)
      const ny = wrap(cur.y + DY[d]!, H)
      if (!canStand(nx + 0.5, ny + 0.5)) continue
      const step = world.roadAt(nx, ny) || world.pathAt(nx, ny) ? roadCost : 1
      const ng = cg + step
      const nk = key(nx, ny)
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng)
        came.set(nk, ck)
        heapPush(nx, ny, ng + heur(nx, ny))
      }
    }
  }
  if (!found) return null

  // ── 回溯成格序列（起点→终点）──
  const cells: Cell[] = []
  let ck = key(gx, gy)
  for (;;) {
    const x = ck % W
    const y = (ck - x) / W
    cells.push({ x, y })
    if (x === sx && y === sy) break
    const prev = came.get(ck)
    if (prev === undefined) break
    ck = prev
  }
  cells.reverse()

  return smooth(cells, canStand, W, H)
}

/**
 * 拉直（string-pulling）：4 连通的路是台阶状的，把能直线走到的中间点删掉，
 * NPC 于是斜着走、少拐弯。删的判据是「两点之间整条线都可站」（含环面回绕）。
 * 返回**格心**航点（去掉起点，因为 NPC 已经站在起点）。
 */
function smooth(
  cells: Cell[],
  canStand: (x: number, y: number) => boolean,
  W: number,
  H: number,
): Cell[] {
  const centers: Cell[] = []
  let anchor = 0
  for (let i = 2; i < cells.length; i++) {
    if (!lineClear(cells[anchor]!, cells[i]!, canStand, W, H)) {
      centers.push(center(cells[i - 1]!))
      anchor = i - 1
    }
  }
  centers.push(center(cells[cells.length - 1]!))
  // 去掉起点自身（cells[0]）—— 上面的循环本就没把它 push 进来
  return centers
}

const center = (c: Cell): Cell => ({ x: c.x + 0.5, y: c.y + 0.5 })

/** a、b 两格之间的直线（环面最短向）是否整条都可站。按 ~0.25 格步长采样 */
function lineClear(
  a: Cell,
  b: Cell,
  canStand: (x: number, y: number) => boolean,
  W: number,
  H: number,
): boolean {
  const dx = wrapDelta(b.x - a.x, W)
  const dy = wrapDelta(b.y - a.y, H)
  const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 4)
  if (steps <= 0) return true
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const x = a.x + 0.5 + dx * t
    const y = a.y + 0.5 + dy * t
    if (!canStand(x, y)) return false
  }
  return true
}
