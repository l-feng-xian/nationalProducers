/**
 * 连通域验证。
 *
 * 跑法： npm run verify:regions
 *
 * 重点在**环面**上：一堵竖墙在平面上会把世界切成两半，但在环面上不会 ——
 * 绕过去就行。真要切断环面，需要两堵墙（或一堵横墙 + 一堵竖墙围成环）。
 * 这个反直觉之处正是最容易写错的地方。
 */

import { buildRegionMap, getRegionMap, clearRegionCache } from '@/services/infinite-world/navigation/regions'
import { findPath, type Sampler } from '@/services/infinite-world/navigation/path'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { wrapTile } from '@/services/infinite-world/core/torus'
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

const openField: Sampler = () => OPEN
const allWall: Sampler = () => WALL
/** 单堵竖墙 —— ⚠️ 在环面上**切不断**世界 */
const oneWall: Sampler = (x) => (wrapTile(x) === 100 ? WALL : OPEN)
/** 两堵竖墙 —— 这才真的切成两半 */
const twoWalls: Sampler = (x) => {
  const cx = wrapTile(x)
  return cx === 100 || cx === 300 ? WALL : OPEN
}
/** 两堵竖墙但其中一堵有缺口 —— 又连回去了 */
const twoWallsOneGap: Sampler = (x, y) => {
  const cx = wrapTile(x)
  if (cx === 100) return WALL
  if (cx === 300 && wrapTile(y) !== 42) return WALL
  return OPEN
}

// ── 1. 全开阔 ────────────────────────────────────────────────────────────
{
  const r = buildRegionMap(openField)
  check('全开阔只有 1 个分量', r.regionCount === 1, `实得 ${r.regionCount}`)
  check('全开阔 mainSize = 262144', r.mainSize === WORLD_SIZE * WORLD_SIZE, `实得 ${r.mainSize}`)
  check('任意两点连通', r.connected(0, 0, 511, 511))
  check('labelAt 处处非 0', r.labelAt(0, 0) !== 0 && r.labelAt(300, 200) !== 0)
}

// ── 2. 全是墙 ────────────────────────────────────────────────────────────
{
  const r = buildRegionMap(allWall)
  check('全是墙时 0 个分量', r.regionCount === 0, `实得 ${r.regionCount}`)
  check('全是墙时 mainLabel = 0', r.mainLabel === 0)
  check('⚠️ 两个不可通行格不算连通', !r.connected(0, 0, 1, 1), '墙里到墙里被误判为可达')
}

// ── 3. ⭐ 环面反直觉：一堵墙切不断世界 ───────────────────────────────────
{
  const r = buildRegionMap(oneWall)
  check('⭐ 单堵竖墙在环面上仍是 1 个分量', r.regionCount === 1, `实得 ${r.regionCount}`)
  check('⭐ 墙两侧仍连通（可以绕过去）', r.connected(99, 50, 101, 50))
  check('墙上的格不可通行', r.labelAt(100, 50) === 0)
  check('mainSize = 总数 - 一列', r.mainSize === WORLD_SIZE * WORLD_SIZE - WORLD_SIZE, `实得 ${r.mainSize}`)

  // 与真实寻路交叉验证：确实能绕过去
  const p = findPath(oneWall, [99, 50], [101, 50], { budget: 300000 })
  check('⭐ 寻路确实能绕过单堵墙', p.length > 0, `路径长度 ${p.length}`)
}

// ── 4. 两堵墙才真的切断 ──────────────────────────────────────────────────
{
  const r = buildRegionMap(twoWalls)
  check('两堵竖墙 = 2 个分量', r.regionCount === 2, `实得 ${r.regionCount}`)
  check('⭐ 两分量之间不连通', !r.connected(150, 50, 350, 50))
  check('同一分量内连通', r.connected(150, 50, 250, 50))
  check('另一分量内也连通', r.connected(350, 50, 50, 50), '跨接缝的那一侧')

  // 分量大小之和 = 可通行总数
  let sum = 0
  for (const s of r.sizes.values()) sum += s
  check('分量大小之和 = 可通行格数', sum === WORLD_SIZE * WORLD_SIZE - 2 * WORLD_SIZE, `实得 ${sum}`)

  const p = findPath(twoWalls, [150, 50], [350, 50], { budget: 300000 })
  check('寻路也认为不可达', p.length === 0)
}

// ── 5. 一个缺口就重新连通 ────────────────────────────────────────────────
{
  const r = buildRegionMap(twoWallsOneGap)
  check('留一个缺口就回到 1 个分量', r.regionCount === 1, `实得 ${r.regionCount}`)
  check('经缺口连通', r.connected(150, 50, 350, 50))
}

// ── 6. 与 A* 交叉验证（随机抽样） ────────────────────────────────────────
{
  const r = buildRegionMap(twoWalls)
  let disagree = 0
  for (let i = 0; i < 60; i++) {
    const ax = Math.floor(Math.random() * WORLD_SIZE)
    const ay = Math.floor(Math.random() * WORLD_SIZE)
    const bx = Math.floor(Math.random() * WORLD_SIZE)
    const by = Math.floor(Math.random() * WORLD_SIZE)
    if (r.labelAt(ax, ay) === 0 || r.labelAt(bx, by) === 0) continue
    if (ax === bx && ay === by) continue
    const reachable = r.connected(ax, ay, bx, by)
    const found = findPath(twoWalls, [ax, ay], [bx, by], { budget: 400000 }).length > 0
    if (reachable !== found) disagree++
  }
  check('⭐ 连通域判定与 A* 结果一致', disagree === 0, `${disagree} 处分歧`)
}

// ── 7. 前置否决真的接上了 ────────────────────────────────────────────────
{
  const r = buildRegionMap(twoWalls)
  const t0 = performance.now()
  const p = findPath(twoWalls, [150, 50], [350, 50], { budget: 400000, reach: r })
  const withOracle = performance.now() - t0

  const t1 = performance.now()
  findPath(twoWalls, [150, 50], [350, 50], { budget: 400000 })
  const without = performance.now() - t1

  check('接上 reach 后仍返回空', p.length === 0)
  check('⭐ 前置否决快一个数量级以上', withOracle * 10 < without, `有 ${withOracle.toFixed(2)}ms / 无 ${without.toFixed(1)}ms`)
  console.log(`  前置否决：${withOracle.toFixed(3)}ms vs 全量展开 ${without.toFixed(1)}ms`)
}

// ── 8. 缓存 ──────────────────────────────────────────────────────────────
{
  clearRegionCache()
  const t0 = performance.now()
  const a = getRegionMap('k1', twoWalls)
  const cold = performance.now() - t0

  const t1 = performance.now()
  const b = getRegionMap('k1', twoWalls)
  const warm = performance.now() - t1

  check('缓存命中返回同一实例', a === b)
  check('缓存命中几乎不耗时', warm < cold / 10, `冷 ${cold.toFixed(1)}ms / 热 ${warm.toFixed(3)}ms`)

  // 超出上限后最老的被逐出
  getRegionMap('k2', openField)
  getRegionMap('k3', openField)
  getRegionMap('k4', openField)
  const again = getRegionMap('k1', twoWalls)
  check('超出 LRU 上限后重建', again !== a)
  console.log(`  泛洪耗时：${cold.toFixed(1)}ms`)
}

// ── 9. 性能 ──────────────────────────────────────────────────────────────
{
  const t0 = performance.now()
  buildRegionMap(oneWall)
  const ms = performance.now() - t0
  check('单次泛洪 < 200ms', ms < 200, `${ms.toFixed(1)}ms`)
}

console.log(`\n连通域验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过')
}
