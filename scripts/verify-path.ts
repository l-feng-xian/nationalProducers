/**
 * 环面 A* 验证。
 *
 * 跑法： npm run verify:path
 *
 * 用合成地形（不依赖真实生成器）把寻路的边界行为钉死，重点是**跨接缝**：
 * 从 x=505 走到 x=7，真实最短是 14 步（经过 x=511→0），
 * 而任何用裸差值做启发式或邻接的实现都会走 498 步、绕远、或干脆返回空。
 */

import { findPath, estimateTravelMinutes, type Sampler } from '@/services/infinite-world/navigation/path'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { delta, wrapTile } from '@/services/infinite-world/core/torus'
import type { TerrainTile } from '@/services/infinite-world/generation/terrain'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const OPEN: TerrainTile = { biome: 'wild', height: 0, walkable: true, bridge: false }
const WALL: TerrainTile = { biome: 'river', height: 0, walkable: false, bridge: false }
const MARSH: TerrainTile = { biome: 'wetland', height: 0, walkable: true, bridge: false }

/** 全开阔 */
const openField: Sampler = () => OPEN

/** 一堵竖墙挡在 x=100，只在 y=300 开一个口 */
const wallWithGap: Sampler = (x, y) => {
  const cx = wrapTile(x)
  const cy = wrapTile(y)
  if (cx === 100 && cy !== 300) return WALL
  return OPEN
}

/** 把世界从中间切成两半，完全不连通（x=100 与 x=300 两堵整墙） */
const splitWorld: Sampler = (x) => {
  const cx = wrapTile(x)
  return cx === 100 || cx === 300 ? WALL : OPEN
}

/** 一条湿地带，绕路 vs 穿过的代价权衡 */
const marshBand: Sampler = (x, y) => {
  const cy = wrapTile(y)
  return cy >= 10 && cy <= 12 ? MARSH : OPEN
}

/** 路径每一步都必须与前一步相邻（环面意义上），且都可通行 */
function pathIsContiguous(path: [number, number][], start: [number, number], sample: Sampler): boolean {
  let px = start[0]
  let py = start[1]
  for (const [x, y] of path) {
    const dx = Math.abs(delta(px, x))
    const dy = Math.abs(delta(py, y))
    if (Math.abs(dx + dy - 1) > 1e-9) return false
    if (!sample(x, y).walkable) return false
    px = x
    py = y
  }
  return true
}

// ── 1. 开阔地直线 ─────────────────────────────────────────────────────────
{
  const p = findPath(openField, [10, 10], [20, 10])
  check('开阔地直线长度 = 10', p.length === 10, `实得 ${p.length}`)
  check('开阔地直线连续', pathIsContiguous(p, [10.5, 10.5], openField))
  check('终点正确', p.at(-1)?.[0] === 20.5 && p.at(-1)?.[1] === 10.5, JSON.stringify(p.at(-1)))
}

// ── 2. ⭐ 跨接缝（这是全套测试的核心） ────────────────────────────────────
{
  const p = findPath(openField, [505, 10], [7, 10])
  // 505 → 511 是 6 步，511 → 0 是 1 步，0 → 7 是 7 步，共 14
  check('⭐ 跨接缝 x 方向长度 = 14（不是 498）', p.length === 14, `实得 ${p.length}`)
  check('⭐ 跨接缝路径连续', pathIsContiguous(p, [505.5, 10.5], openField))
  // 路径必须真的经过接缝，而不是绕大半圈
  const xs = p.map((q) => q[0])
  check('⭐ 跨接缝路径确实经过 x=0 附近', xs.some((x) => x < 8) && xs.some((x) => x > 504), `x 范围 ${Math.min(...xs)}..${Math.max(...xs)}`)
  check('⭐ 跨接缝路径不经过地图中部', !xs.some((x) => x > 20 && x < 490), '路径绕了远路')
}
{
  const p = findPath(openField, [10, 505], [10, 7])
  check('⭐ 跨接缝 y 方向长度 = 14', p.length === 14, `实得 ${p.length}`)
}
{
  // 四角对穿：(2,2) → (509,509)，两轴各 5 步
  const p = findPath(openField, [2, 2], [509, 509])
  check('⭐ 四角对穿长度 = 10', p.length === 10, `实得 ${p.length}`)
}

// ── 3. 绕障 ──────────────────────────────────────────────────────────────
{
  const p = findPath(wallWithGap, [95, 300], [105, 300], { budget: 20000 })
  check('穿过墙上的口', p.length === 10, `实得 ${p.length}`)
  check('绕障路径连续且合法', pathIsContiguous(p, [95.5, 300.5], wallWithGap))
}
{
  // 口在 y=300，起点在 y=100 → 必须先走到口再穿过去
  const p = findPath(wallWithGap, [95, 100], [105, 100], { budget: 200000 })
  check('远离开口时仍能绕过去', p.length > 400, `实得 ${p.length}`)
  check('绕远路径全程合法', pathIsContiguous(p, [95.5, 100.5], wallWithGap))
}

// ── 4. 不可达 ────────────────────────────────────────────────────────────
{
  const p = findPath(splitWorld, [50, 50], [200, 50], { budget: 100000 })
  check('完全不连通时返回空', p.length === 0, `实得 ${p.length}`)
}
{
  const p = findPath(openField, [10, 10], [100, 100], { budget: 10 })
  check('预算耗尽返回空', p.length === 0, `实得 ${p.length}`)
}
{
  const p = findPath(splitWorld, [50, 50], [100, 50])
  check('目标本身不可通行时返回空', p.length === 0, `实得 ${p.length}`)
}
{
  const p = findPath(openField, [10, 10], [10, 10])
  check('起点即终点返回空', p.length === 0, `实得 ${p.length}`)
}

// ── 5. 可达性前置否决 ────────────────────────────────────────────────────
{
  let consulted = 0
  const reach = {
    connected: () => {
      consulted++
      return false
    },
  }
  const t0 = performance.now()
  const p = findPath(splitWorld, [50, 50], [200, 50], { budget: 100000, reach })
  const ms = performance.now() - t0
  check('前置否决返回空', p.length === 0)
  check('前置否决被调用', consulted === 1, `调用 ${consulted} 次`)
  check('前置否决几乎不耗时', ms < 2, `${ms.toFixed(2)}ms`)
}

// ── 6. 代价：湿地缓行 ────────────────────────────────────────────────────
{
  // 从 y=8 到 y=14 必须穿过 y=10..12 的湿地带（3 格 × 代价 2）
  // 直穿 6 步：代价 = 3×1 + 3×2 = 9。绕行不可能更便宜（湿地带绕满整圈）
  const p = findPath(marshBand, [50, 8], [50, 14])
  check('湿地带内仍找得到路', p.length === 6, `实得 ${p.length}`)
  check('湿地路径连续', pathIsContiguous(p, [50.5, 8.5], marshBand))
}

// ── 7. 性能 ──────────────────────────────────────────────────────────────
{
  const t0 = performance.now()
  const runs = 200
  let total = 0
  for (let i = 0; i < runs; i++) {
    const p = findPath(openField, [i % WORLD_SIZE, 10], [(i + 60) % WORLD_SIZE, 70])
    total += p.length
  }
  const ms = performance.now() - t0
  check('200 次中距寻路 < 500ms', ms < 500, `${ms.toFixed(1)}ms`)
  check('200 次都找到了路', total > 0)
  console.log(`  性能：200 次寻路 ${ms.toFixed(1)}ms（平均 ${(ms / runs).toFixed(2)}ms/次）`)
}

// ── 8. 缓冲复用不串味 ────────────────────────────────────────────────────
{
  // 连续两次不同的寻路，第二次不能被第一次的残留影响
  findPath(openField, [10, 10], [200, 200], { budget: 100000 })
  const p = findPath(openField, [10, 10], [20, 10])
  check('复用缓冲后结果仍正确', p.length === 10, `实得 ${p.length}`)
}

// ── 9. estimateTravelMinutes ─────────────────────────────────────────────
{
  const near = estimateTravelMinutes([10, 10], [20, 10], 2)
  check('通勤估算 = 距离×1.4/速度', Math.abs(near - 7) < 1e-9, `实得 ${near}`)
  const seam = estimateTravelMinutes([505, 10], [7, 10], 2)
  check('⭐ 通勤估算走环面短边', Math.abs(seam - (14 * 1.4) / 2) < 1e-9, `实得 ${seam}`)
  check('速度为 0 时返回 Infinity', estimateTravelMinutes([0, 0], [1, 1], 0) === Infinity)
}

console.log(`\n环面 A* 验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过')
}
