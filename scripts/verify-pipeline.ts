/**
 * 生成流水线验收（P1 的最终门槛）。
 *
 * 跑法： npm run verify:pipeline
 *
 * 这一层测的是**装配之后的整体性质**，各层自己的性质在各自的 verify 里：
 *  - 三处一致：预览 / 创建 / 进入游戏拿到同一张 grid（靠缓存同实例，构造上成立）
 *  - 出生点必须在主连通域里
 *  - 装饰不能堵死街巷与桥
 *  - 六种生态都要出现
 *  - 整张 grid 的回绕一致性
 */

import { auditConnectivity, buildWorld, GENERATOR_VERSION } from '@/services/infinite-world/generation/pipeline'
import { buildKey, buildWorldSync, clearWorldCache } from '@/services/infinite-world/generation/worldSource'
import {
  Decor,
  Flag,
  gridByteLength,
  gridIndex,
  transferablesOf,
  type WorldGrid,
} from '@/services/infinite-world/generation/grid'
import { isBlockingDecor } from '@/services/infinite-world/generation/decor'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { wrapTile } from '@/services/infinite-world/core/torus'
import { BIOMES } from '@/types/infiniteWorld'

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

const N = WORLD_SIZE * WORLD_SIZE
const SETTINGS = {
  waterRatio: 0.15,
  forestDensity: 0.5,
  fieldDensity: 0.5,
  season: 0,
  dayMinutes: 20,
  townDensity: 0.5,
  riverDensity: 0.5,
}

function make(seed: string) {
  return buildWorld({ seed, settings: SETTINGS })
}

function signature(g: WorldGrid): string {
  // 抽样 + 全量校验和，既快又能抓住任何一格的差异
  let sum = 0
  for (let i = 0; i < N; i++) {
    sum = (sum + g.surface[i]! * 7 + g.flags[i]! * 13 + g.decor[i]! * 17 + g.biome[i]! * 3) >>> 0
  }
  return `${sum}|${g.spawn.join(',')}|${g.towns.length}|${g.bridges.length}|${g.mainRegion}`
}

// ── 1. ⭐ 确定性 ─────────────────────────────────────────────────────────
{
  const a = make('pipe-repro')
  const b = make('pipe-repro')
  check('⭐ 同种子逐格可复现', signature(a) === signature(b))
  check('不同种子产出不同世界', signature(a) !== signature(make('pipe-other')))
  check('generatorVersion 写进了 grid', a.generatorVersion === GENERATOR_VERSION, a.generatorVersion)
  console.log(`    grid 内存 ${(gridByteLength(a) / 1048576).toFixed(2)} MB`)
}

// ── 2. ⭐⭐ 三处一致：缓存返回同一实例 ──────────────────────────────────
{
  clearWorldCache()
  const req = { seed: 'cache-test', settings: SETTINGS }
  const t0 = performance.now()
  const first = buildWorldSync(req)
  const cold = performance.now() - t0
  const t1 = performance.now()
  const second = buildWorldSync(req)
  const warm = performance.now() - t1

  check('⭐⭐ 预览与正式生成拿到同一个 grid 实例', first === second,
    '不是同一实例 —— 「三处一致」就退化成需要逐格比对的性质了')
  check('缓存命中几乎不耗时', warm < cold / 20, `冷 ${cold.toFixed(0)}ms / 热 ${warm.toFixed(3)}ms`)
  check('buildKey 对同输入稳定', buildKey(req) === buildKey({ ...req }))
  check('buildKey 区分种子', buildKey(req) !== buildKey({ ...req, seed: 'other' }))
  check(
    'buildKey 区分设置',
    buildKey(req) !== buildKey({ ...req, settings: { ...SETTINGS, waterRatio: 0.3 } }),
  )
  console.log(`    冷 ${cold.toFixed(0)}ms / 热 ${warm.toFixed(3)}ms`)
}

// ── 3. ⭐ 出生点必须在主连通域里 ─────────────────────────────────────────
{
  console.log('  各种子的连通体检：')
  let badSpawn = 0
  let strandedTotal = 0
  const shares: number[] = []
  for (const seed of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']) {
    const g = make(seed)
    const [sx, sy] = g.spawn
    const i = gridIndex(sx, sy)
    const okSpawn =
      g.region[i] === g.mainRegion &&
      (g.flags[i]! & Flag.Walkable) !== 0 &&
      !(g.flags[i]! & Flag.Building)
    if (!okSpawn) badSpawn++
    const audit = auditConnectivity(g)
    strandedTotal += audit.strandedTowns.length
    shares.push(audit.mainShare)
    console.log(
      `    ${seed}: 镇 ${g.towns.length} 个  主域占 ${(audit.mainShare * 100).toFixed(1)}%  ` +
        `孤立 ${audit.strandedTowns.length}  出生 (${sx},${sy}) ${okSpawn ? '✓' : '✗'}`,
    )
  }
  check('⭐⭐ 出生点恒在主连通域的可行走格上', badSpawn === 0, `${badSpawn}/6 个种子出生点不合法`)
  check('⭐ 修复后没有孤立城镇', strandedTotal === 0, `共 ${strandedTotal} 个孤立镇`)
  const minShare = Math.min(...shares)
  check('⭐ 主连通域占可行走区的 90% 以上', minShare > 0.9, `最低 ${(minShare * 100).toFixed(1)}%`)
}

// ── 4. ⭐⭐ 装饰不能堵死街巷与桥 ─────────────────────────────────────────
//
// 这是最容易漏、也最难从预览图看出来的一类问题：门前长了棵树，
// 那栋房子就永远进不去，而全局图上完全看不出来。
{
  let blockedRoad = 0
  let blockedBridge = 0
  let roadNotWalkable = 0
  for (const seed of ['d1', 'd2', 'd3']) {
    const g = make(seed)
    for (let i = 0; i < N; i++) {
      const f = g.flags[i]!
      if (f & (Flag.Road | Flag.Plaza)) {
        if (isBlockingDecor(g.decor[i]! as never)) blockedRoad++
        if (!(f & Flag.Walkable)) roadNotWalkable++
      }
      if (f & Flag.Bridge) {
        if (isBlockingDecor(g.decor[i]! as never)) blockedBridge++
        if (!(f & Flag.Walkable)) blockedBridge++
      }
    }
  }
  check('⭐⭐ 街巷/广场上没有挡路装饰', blockedRoad === 0, `${blockedRoad} 格`)
  check('⭐⭐ 街巷/广场恒可通行', roadNotWalkable === 0, `${roadNotWalkable} 格不可走`)
  check('⭐⭐ 桥面恒可通行且无装饰', blockedBridge === 0, `${blockedBridge} 格`)
}

// ── 4b. ⭐ 每栋建筑都至少有一个可通行的相邻格（门口不能被堵死） ──────────
{
  let sealed = 0
  let total = 0
  for (const seed of ['d1', 'd2', 'd3']) {
    const g = make(seed)
    for (const t of g.towns) {
      for (const b of t.buildings) {
        if (b.kind === 'well') continue
        total++
        let reachable = false
        for (let yy = -1; yy <= b.h && !reachable; yy++) {
          for (let xx = -1; xx <= b.w; xx++) {
            // 只看占地外圈
            if (yy >= 0 && yy < b.h && xx >= 0 && xx < b.w) continue
            const i = gridIndex(b.x + xx, b.y + yy)
            if (g.flags[i]! & Flag.Walkable) {
              reachable = true
              break
            }
          }
        }
        if (!reachable) sealed++
      }
    }
  }
  check('⭐⭐ 每栋建筑都有可通行的相邻格', sealed === 0, `${sealed}/${total} 栋被完全封死`)
  console.log(`    ${total} 栋建筑，被封死 ${sealed} 栋`)
}

// ── 5. 六种生态都要出现 ──────────────────────────────────────────────────
{
  let missing = ''
  for (const seed of ['b1', 'b2', 'b3']) {
    const g = make(seed)
    const counts = new Array(BIOMES.length).fill(0)
    for (let i = 0; i < N; i++) counts[g.biome[i]!]++
    for (let k = 0; k < BIOMES.length; k++) {
      if (counts[k] === 0) missing += `${seed}:${BIOMES[k]} `
    }
  }
  check('⭐ 每个种子六种生态都出现', missing === '', missing)
}

// ── 6. ⭐ 整张 grid 的回绕一致性 ────────────────────────────────────────
{
  const g = make('wrap-grid')
  let bad = 0
  for (let i = 0; i < 2000; i++) {
    const x = Math.floor(Math.random() * WORLD_SIZE)
    const y = Math.floor(Math.random() * WORLD_SIZE)
    const a = gridIndex(x, y)
    for (const [ox, oy] of [
      [WORLD_SIZE, 0],
      [0, WORLD_SIZE],
      [-WORLD_SIZE, -WORLD_SIZE],
      [WORLD_SIZE * 3, -WORLD_SIZE * 2],
    ] as const) {
      if (gridIndex(x + ox, y + oy) !== a) bad++
    }
  }
  check('⭐ gridIndex 回绕一致', bad === 0, `${bad} 处不一致`)

  // 接缝两侧的地表不应有系统性突变：跨缝的相邻格差异应与内部相当
  let seamDiff = 0
  let innerDiff = 0
  for (let t = 0; t < WORLD_SIZE; t++) {
    if (g.surface[gridIndex(WORLD_SIZE - 1, t)] !== g.surface[gridIndex(0, t)]) seamDiff++
    const x = 1 + Math.floor(Math.random() * (WORLD_SIZE - 3))
    if (g.surface[gridIndex(x, t)] !== g.surface[gridIndex(x + 1, t)]) innerDiff++
  }
  check('⭐ 跨接缝的地表变化率与内部相当', seamDiff <= innerDiff * 2 + 10,
    `跨缝 ${seamDiff} / 内部 ${innerDiff}`)
  console.log(`    跨缝地表变化 ${seamDiff} 次 / 内部 ${innerDiff} 次（越接近越好）`)
}

// ── 7. 进度与取消 ────────────────────────────────────────────────────────
{
  const steps: string[] = []
  make('progress-probe')
  buildWorld({
    seed: 'progress-probe2',
    settings: SETTINGS,
    onProgress: (s) => steps.push(s),
  })
  check('回报了进度', steps.length >= 9, `只有 ${steps.length} 步`)
  check('最后一步是完成', steps.at(-1) === '完成', String(steps.at(-1)))

  // 取消：在第 3 个检查点翻转标志
  let ticks = 0
  const signal = { aborted: false }
  let threw = false
  try {
    buildWorld({
      seed: 'cancel-probe',
      settings: SETTINGS,
      signal,
      onProgress: () => {
        if (++ticks >= 3) signal.aborted = true
      },
    })
  } catch {
    threw = true
  }
  check('⭐ 取消标志能中断生成', threw, '没有抛出 —— 取消检查点失效了')
  check('取消发生在中途而不是跑完', ticks < 9, `跑了 ${ticks} 步`)
  console.log(`    进度 ${steps.length} 步；取消在第 ${ticks} 步生效`)
}

// ── 8. transferables 清单完整 ───────────────────────────────────────────
{
  const g = make('transfer-test')
  const list = transferablesOf(g)
  check('transfer 清单有 6 个 buffer', list.length === 6, `实得 ${list.length}`)
  check('清单里没有重复 buffer', new Set(list).size === list.length)
  const totalBytes = list.reduce((s, b) => s + b.byteLength, 0)
  check('清单覆盖了全部大数组', totalBytes === gridByteLength(g),
    `清单 ${totalBytes} vs grid ${gridByteLength(g)}`)
}

// ── 9. 性能 ──────────────────────────────────────────────────────────────
{
  clearWorldCache()
  const times: number[] = []
  for (const seed of ['p1', 'p2', 'p3']) {
    const t0 = performance.now()
    make(seed)
    times.push(performance.now() - t0)
  }
  const worst = Math.max(...times)
  check('单次生成 < 3 秒', worst < 3000, `最慢 ${worst.toFixed(0)}ms`)
  console.log(`    生成耗时 ${times.map((t) => t.toFixed(0) + 'ms').join(' / ')}`)
}

// ── 10. 装饰分布合理 ────────────────────────────────────────────────────
{
  const g = make('decor-test')
  let trees = 0
  let flowers = 0
  let decorTotal = 0
  let inForest = 0
  let treesInForest = 0
  const forestIdx = BIOMES.indexOf('forest')
  for (let i = 0; i < N; i++) {
    const d = g.decor[i]!
    if (d !== Decor.None) decorTotal++
    const isTree = d === Decor.TreeBroad || d === Decor.TreeConifer || d === Decor.TreeBirch
    if (isTree) trees++
    if (d === Decor.Flower) flowers++
    if (g.biome[i] === forestIdx) {
      inForest++
      if (isTree) treesInForest++
    }
  }
  check('有树', trees > 1000, `${trees} 棵`)
  check('有花', flowers > 500, `${flowers} 朵`)
  check('装饰覆盖 8%-45%', decorTotal / N > 0.08 && decorTotal / N < 0.45,
    `${((decorTotal / N) * 100).toFixed(1)}%`)
  const forestTreeRate = inForest > 0 ? treesInForest / inForest : 0
  check('⭐ 森林里的树明显多于全局平均', forestTreeRate > (trees / N) * 1.5,
    `森林内 ${(forestTreeRate * 100).toFixed(1)}% vs 全局 ${((trees / N) * 100).toFixed(1)}%`)
  console.log(
    `    树 ${trees} 棵（森林内密度 ${(forestTreeRate * 100).toFixed(1)}%，全局 ${((trees / N) * 100).toFixed(1)}%）`,
  )
}

console.log(`\n流水线验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过')
}
