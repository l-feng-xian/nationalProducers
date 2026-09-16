/**
 * 环面（torus）几何：512×512 世界的坐标运算。
 *
 * ## 为什么是环面而不是球
 * 正方格铺不满球面（必然有极点奇异）。而实际需求是「朝任意方向一直走都能
 * 绕回原点、且看不出接缝」—— 这正是**环面拓扑**：平面的左右边相接、上下边
 * 相接。显示上仍是平面，走动上却是闭合的，四个方向各绕一圈。
 *
 * ## ⚠️ delta() 是这个世界上唯一合法的减法
 * 业务代码里**禁止**出现裸的 `b - a`。漏掉一处的三种死法，每一种都很难从
 * 现象反推回原因：
 *
 * 1. **A\* 启发式**用裸差值 → 跨缝时 h > 真实代价，启发式不再可采纳，
 *    A\* 会绕远路或在预算耗尽后返回空路径（表现为「NPC 突然不动了」）。
 * 2. **渲染插值**用裸 lerp → 角色从 x=511 走到 x=0 时，插值会让它
 *    **横穿整张地图**（表现为「过接缝时角色闪一下飞过去」）。
 * 3. **沿路径移动**用 `target[0] - pos[0]` 求方向 → NPC 跨缝时朝反方向
 *    跑 511 格（表现为「NPC 出门就往反方向走」）。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { WORLD_HALF, WORLD_SIZE } from './constants'

export type Point = readonly [number, number]

/**
 * 归一到 [0, WORLD_SIZE)。对负数与任意大的数都安全。
 *
 * ⚠️ 用 `((v % W) + W) % W` 而不是 `v % W` —— JS 的 % 保留被除数符号，
 * `-1 % 512` 是 -1 而不是 511。
 */
export function wrap(v: number): number {
  return ((v % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
}

/** 取整后归一，返回 [0, WORLD_SIZE) 的整数。用 floor 而不是截断：负坐标截断会错一格 */
export function wrapTile(v: number): number {
  return ((Math.floor(v) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
}

/**
 * a → b 的最短有向位移，值域 [-WORLD_HALF, WORLD_HALF)。
 *
 * 这是环面上唯一合法的「减法」。对任意大小的输入都正确（先取模再折叠，
 * 不依赖输入落在某个范围内）。
 */
export function delta(a: number, b: number): number {
  let d = (b - a) % WORLD_SIZE
  if (d >= WORLD_HALF) d -= WORLD_SIZE
  else if (d < -WORLD_HALF) d += WORLD_SIZE
  return d
}

/** 环面欧氏距离的平方。比较距离时用它，省一次 sqrt */
export function torusDist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = delta(ax, bx)
  const dy = delta(ay, by)
  return dx * dx + dy * dy
}

/** 环面欧氏距离 */
export function torusDist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(torusDist2(ax, ay, bx, by))
}

/**
 * 环面曼哈顿距离。A\* 的启发式专用。
 *
 * ⚠️ 四邻接网格上这是可采纳（admissible）的：它永远不会高估真实代价。
 * 换成裸曼哈顿就不再可采纳 —— 见文件头第 1 条。
 */
export function torusManhattan(ax: number, ay: number, bx: number, by: number): number {
  return Math.abs(delta(ax, bx)) + Math.abs(delta(ay, by))
}

/**
 * 环面插值：沿最短路径从 a 走到 b 的 t 处。
 *
 * ⚠️ 渲染补帧必须用它。裸 `a + (b-a)*t` 会让跨缝的角色横穿地图。
 */
export function lerpTorus(a: number, b: number, t: number): number {
  return wrap(a + delta(a, b) * t)
}

/** SoA 数组的行主序索引。输入会先回绕，所以传任意坐标都安全 */
export function tileIndex(x: number, y: number): number {
  return wrapTile(y) * WORLD_SIZE + wrapTile(x)
}

/**
 * 四邻接。写进调用方预分配的数组，避免每次分配（A\* 内循环会调几十万次）。
 *
 * 写入顺序 [x,y] × 4：东、西、南、北。
 */
export function neighbours4(x: number, y: number, out: Int32Array): void {
  const cx = wrapTile(x)
  const cy = wrapTile(y)
  out[0] = cx === WORLD_SIZE - 1 ? 0 : cx + 1
  out[1] = cy
  out[2] = cx === 0 ? WORLD_SIZE - 1 : cx - 1
  out[3] = cy
  out[4] = cx
  out[5] = cy === WORLD_SIZE - 1 ? 0 : cy + 1
  out[6] = cx
  out[7] = cy === 0 ? WORLD_SIZE - 1 : cy - 1
}

/** 八邻接的方向偏移，与 neighbours8 的写入顺序一致 */
export const DIR8: readonly (readonly [number, number])[] = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

/** 八邻接对应的欧氏步长（对角为 √2）。D8 求最陡下降时要除以它 */
export const DIST8: readonly number[] = DIR8.map(([dx, dy]) => Math.hypot(dx, dy))

/**
 * 八邻接。写进调用方预分配的数组（8 对 [x,y]，共 16 个元素）。
 *
 * 环面上**没有边界**，所以每格恒有 8 个邻居 —— 水文算法不需要任何边界特例，
 * 这也是「填洼的种子只能是低于海平面的格」这个前提成立的原因：
 * 平面版填洼要把地图四边当作出水口，环面上没有四边。
 */
export function neighbours8(x: number, y: number, out: Int32Array): void {
  const cx = wrapTile(x)
  const cy = wrapTile(y)
  for (let i = 0; i < 8; i++) {
    const d = DIR8[i]!
    out[i * 2] = wrapTile(cx + d[0])
    out[i * 2 + 1] = wrapTile(cy + d[1])
  }
}

/**
 * 把 b 挪到离 a 最近的那个镜像位置。
 *
 * 渲染层用它决定一块 chunk 该画在哪儿：世界逻辑上块心在 (cx,cy)，
 * 但玩家在环面另一侧时，应该画在 cx±512 的镜像处。
 */
export function nearestMirror(a: number, b: number): number {
  return a + delta(a, b)
}
