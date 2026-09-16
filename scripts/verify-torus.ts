/**
 * 环面几何验证。
 *
 * 跑法： npm run verify:torus
 *   （等价于 node --import ./scripts/ts-register.mjs scripts/verify-torus.ts）
 *
 * ## 为什么要有「负向断言」
 * 环面接缝的错误有个共同特征：**正向测试极容易假绿**。
 * 在世界中心随便取两点，裸减法和 delta() 的结果完全一样，测一万次都过。
 * 只有跨接缝时才会分叉，而那正是平时不会随机取到的地方。
 *
 * 所以这里每一组断言都配了一条「故意写错的实现」，并断言那个错误实现
 * **必须被抓住**。如果某天有人「优化」掉了 delta()，而测试仍然全绿，
 * 那说明测试本身失效了 —— 负向断言就是用来检测这种失效的。
 */

import {
  delta,
  lerpTorus,
  neighbours4,
  tileIndex,
  torusDist,
  torusManhattan,
  wrap,
  wrapTile,
} from '@/services/infinite-world/core/torus'
import { WORLD_HALF, WORLD_SIZE } from '@/services/infinite-world/core/constants'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
  } else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps
}

// ── wrap ──────────────────────────────────────────────────────────────────
check('wrap(0)', wrap(0) === 0)
check('wrap(511.5)', near(wrap(511.5), 511.5))
check('wrap(512) 回到 0', near(wrap(512), 0))
check('wrap(-1) = 511', near(wrap(-1), 511), `实得 ${wrap(-1)}`)
check('wrap(-512.5) = 511.5', near(wrap(-512.5), 511.5), `实得 ${wrap(-512.5)}`)
check('wrap(100000) 在域内', wrap(100_000) >= 0 && wrap(100_000) < WORLD_SIZE)
check('wrap(-100000) 在域内', wrap(-100_000) >= 0 && wrap(-100_000) < WORLD_SIZE)

// ⚠️ 负坐标必须用 floor 而不是截断：-0.5 应该落在格 511，截断会得到格 0
check('wrapTile(-0.5) = 511（floor 而非截断）', wrapTile(-0.5) === 511, `实得 ${wrapTile(-0.5)}`)
check('wrapTile(-1.5) = 510', wrapTile(-1.5) === 510, `实得 ${wrapTile(-1.5)}`)
check('wrapTile(511.9) = 511', wrapTile(511.9) === 511)

// ── delta：值域与正确性 ────────────────────────────────────────────────────
{
  let outOfRange = 0
  let mismatch = 0
  for (let i = 0; i < 200_000; i++) {
    const a = Math.random() * WORLD_SIZE
    const b = Math.random() * WORLD_SIZE
    const d = delta(a, b)
    if (!(d >= -WORLD_HALF && d < WORLD_HALF)) outOfRange++
    // delta 必须真的把 a 送到 b（在环面意义上）
    if (!near(wrap(a + d), wrap(b), 1e-9)) mismatch++
  }
  check('delta 值域恒在 [-256, 256)', outOfRange === 0, `${outOfRange} 次越界`)
  check('wrap(a + delta(a,b)) === wrap(b)', mismatch === 0, `${mismatch} 次不符`)
}

check('delta(0, 1) = 1', near(delta(0, 1), 1))
check('delta(0, 511) = -1（走短边）', near(delta(0, 511), -1), `实得 ${delta(0, 511)}`)
check('delta(511, 0) = 1（走短边）', near(delta(511, 0), 1), `实得 ${delta(511, 0)}`)
check('delta(0, 256) 折叠为 -256', near(delta(0, 256), -256), `实得 ${delta(0, 256)}`)
check('delta 对超范围输入也正确', near(delta(0, 1000), delta(0, wrap(1000))), `实得 ${delta(0, 1000)}`)
check('delta(0, -1000) 正确', near(wrap(0 + delta(0, -1000)), wrap(-1000)))

// ── 负向断言 #1：裸减法必须被抓出来 ──────────────────────────────────────
{
  const naive = (a: number, b: number) => b - a
  // 跨接缝：从 511 走到 0，真实位移是 +1，裸减法给 -511
  const good = delta(511, 0)
  const bad = naive(511, 0)
  check(
    '⚠️负向断言 裸减法在跨缝处确实出错（若此条失败说明测试本身失效）',
    near(good, 1) && Math.abs(bad) > 500,
    `delta=${good} naive=${bad}`,
  )
}

// ── lerpTorus：不许横穿地图 ───────────────────────────────────────────────
{
  // 从 511 走到 1：最短路径经过 0，中点应该在 0 附近，绝不是 256
  const mid = lerpTorus(511, 1, 0.5)
  check('lerpTorus(511, 1, .5) 落在接缝附近', near(mid, 0, 1e-9), `实得 ${mid}`)

  // 全程采样：相邻两次插值的环面距离必须很小（不允许有一次跳跃）
  let maxStep = 0
  let prev = lerpTorus(500, 12, 0)
  for (let i = 1; i <= 1000; i++) {
    const cur = lerpTorus(500, 12, i / 1000)
    maxStep = Math.max(maxStep, Math.abs(delta(prev, cur)))
    prev = cur
  }
  check('lerpTorus 全程无跳跃', maxStep < 1, `最大单步 ${maxStep.toFixed(4)}`)
}

// ── 负向断言 #2：裸 lerp 会横穿地图 ──────────────────────────────────────
{
  const naiveLerp = (a: number, b: number, t: number) => a + (b - a) * t
  const badMid = naiveLerp(511, 1, 0.5)
  check(
    '⚠️负向断言 裸 lerp 在跨缝处确实横穿地图',
    Math.abs(badMid - 256) < 1,
    `裸 lerp 中点 = ${badMid}（应约等于 256，即横穿了半张地图）`,
  )
}

// ── torusManhattan：A* 启发式必须可采纳 ──────────────────────────────────
{
  // 四邻接网格上，曼哈顿距离就是无障碍时的真实最短步数，不能高估
  let inadmissible = 0
  for (let i = 0; i < 100_000; i++) {
    const ax = Math.floor(Math.random() * WORLD_SIZE)
    const ay = Math.floor(Math.random() * WORLD_SIZE)
    const bx = Math.floor(Math.random() * WORLD_SIZE)
    const by = Math.floor(Math.random() * WORLD_SIZE)
    const h = torusManhattan(ax, ay, bx, by)
    // 真实最短步数（无障碍）= 两轴最短环绕步数之和
    const realX = Math.min(Math.abs(bx - ax), WORLD_SIZE - Math.abs(bx - ax))
    const realY = Math.min(Math.abs(by - ay), WORLD_SIZE - Math.abs(by - ay))
    if (h > realX + realY) inadmissible++
  }
  check('torusManhattan 可采纳（从不高估）', inadmissible === 0, `${inadmissible} 次高估`)
  check('torusManhattan 上界 = 512', torusManhattan(0, 0, 256, 256) === 512)
}

// ── 负向断言 #3：裸曼哈顿在跨缝处高估 ────────────────────────────────────
{
  const naiveManhattan = (ax: number, ay: number, bx: number, by: number) =>
    Math.abs(bx - ax) + Math.abs(by - ay)
  const good = torusManhattan(5, 5, 507, 507)
  const bad = naiveManhattan(5, 5, 507, 507)
  check(
    '⚠️负向断言 裸曼哈顿在跨缝处确实高估',
    good === 20 && bad === 1004,
    `torus=${good} naive=${bad}`,
  )
}

// ── neighbours4：四邻接回绕 ──────────────────────────────────────────────
{
  const out = new Int32Array(8)
  neighbours4(0, 0, out)
  const set = new Set<string>()
  for (let i = 0; i < 4; i++) set.add(`${out[i * 2]},${out[i * 2 + 1]}`)
  check('neighbours4(0,0) 含 (511,0)', set.has('511,0'), [...set].join(' '))
  check('neighbours4(0,0) 含 (0,511)', set.has('0,511'), [...set].join(' '))
  check('neighbours4(0,0) 含 (1,0)', set.has('1,0'))
  check('neighbours4(0,0) 含 (0,1)', set.has('0,1'))

  neighbours4(511, 511, out)
  const set2 = new Set<string>()
  for (let i = 0; i < 4; i++) set2.add(`${out[i * 2]},${out[i * 2 + 1]}`)
  check('neighbours4(511,511) 含 (0,511)', set2.has('0,511'), [...set2].join(' '))
  check('neighbours4(511,511) 含 (511,0)', set2.has('511,0'), [...set2].join(' '))

  // 所有邻居都必须恰好距离 1
  let badDist = 0
  for (let t = 0; t < 5000; t++) {
    const x = Math.floor(Math.random() * WORLD_SIZE)
    const y = Math.floor(Math.random() * WORLD_SIZE)
    neighbours4(x, y, out)
    for (let i = 0; i < 4; i++) {
      if (!near(torusDist(x, y, out[i * 2]!, out[i * 2 + 1]!), 1, 1e-9)) badDist++
    }
  }
  check('neighbours4 的邻居恒距 1', badDist === 0, `${badDist} 个距离不为 1`)
}

// ── tileIndex ────────────────────────────────────────────────────────────
check('tileIndex(0,0) = 0', tileIndex(0, 0) === 0)
check('tileIndex(511,511) = 262143', tileIndex(511, 511) === WORLD_SIZE * WORLD_SIZE - 1)
check('tileIndex(-1,-1) 回绕', tileIndex(-1, -1) === WORLD_SIZE * WORLD_SIZE - 1)
check('tileIndex(512,512) 回绕到 0', tileIndex(512, 512) === 0)
{
  // 全域唯一性
  const seen = new Uint8Array(WORLD_SIZE * WORLD_SIZE)
  let dup = 0
  for (let y = 0; y < WORLD_SIZE; y++) {
    for (let x = 0; x < WORLD_SIZE; x++) {
      const i = tileIndex(x, y)
      if (seen[i]) dup++
      seen[i] = 1
    }
  }
  check('tileIndex 在全域上是双射', dup === 0, `${dup} 次冲突`)
}

// ── 报告 ─────────────────────────────────────────────────────────────────
console.log(`\n环面几何验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过（含 3 条负向断言）')
}
