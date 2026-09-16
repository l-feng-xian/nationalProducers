/**
 * 噪声场与海平面验证。
 *
 * 跑法： npm run verify:fields
 *
 * 重点三条：
 *  1. 每个场都必须先回绕 —— 传 x 与 x+512 必须给同一个值
 *  2. `waterRatio` 必须有精确语义：实测水面占比与设置值误差 < 1%
 *  3. 各场互不相关 —— 相关了会退化成「森林长在等高线上」
 */

import { bakeElevation, createFields, type Fields } from '@/services/infinite-world/generation/fields'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'

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

const FIELD_NAMES = ['elevation', 'moisture', 'macro', 'settlement', 'lake', 'detail'] as const

// ── 1. 回绕纪律 ──────────────────────────────────────────────────────────
//
// ⚠️ 整数与浮点要分开断言：
//   整数坐标（= 所有真实的逐格查询）取模是精确的 → 必须**逐位相同**
//   浮点坐标 `(1536.7 % 512)` 会得到 0.7000000000000455 —— 这是浮点取模的
//   固有行为，不是 bug。误差约 1e-13，经 detail 场（radiusScale=2.5，最高频）
//   放大后到 1.7e-14，仍远低于任何阈值。
{
  const f = createFields({ seed: 'wrap-test' })
  const OFFSETS = [
    [WORLD_SIZE, 0],
    [0, WORLD_SIZE],
    [-WORLD_SIZE, -WORLD_SIZE],
    [WORLD_SIZE * 3, WORLD_SIZE * 2],
  ] as const

  // 1a. 整数坐标：逐位相同
  let intWorst = 0
  let intField = ''
  for (const name of FIELD_NAMES) {
    const fn = f[name]
    for (let i = 0; i < 300; i++) {
      const x = Math.floor(Math.random() * WORLD_SIZE)
      const y = Math.floor(Math.random() * WORLD_SIZE)
      const v = fn(x, y)
      for (const [ox, oy] of OFFSETS) {
        const d = Math.abs(v - fn(x + ox, y + oy))
        if (d > intWorst) {
          intWorst = d
          intField = name
        }
      }
    }
  }
  check('⭐ 整数坐标回绕后逐位相同', intWorst === 0, `${intField} 差 ${intWorst.toExponential(2)}`)

  // 1b. 浮点坐标：允许浮点取模的固有误差
  let fltWorst = 0
  let fltField = ''
  for (const name of FIELD_NAMES) {
    const fn = f[name]
    for (let i = 0; i < 300; i++) {
      const x = Math.random() * WORLD_SIZE
      const y = Math.random() * WORLD_SIZE
      const v = fn(x, y)
      for (const [ox, oy] of OFFSETS) {
        const d = Math.abs(v - fn(x + ox, y + oy))
        if (d > fltWorst) {
          fltWorst = d
          fltField = name
        }
      }
    }
  }
  check('浮点坐标回绕误差 < 1e-10', fltWorst < 1e-10, `${fltField} 差 ${fltWorst.toExponential(2)}`)
  console.log(`    回绕误差：整数 ${intWorst.toExponential(1)} / 浮点 ${fltWorst.toExponential(2)}（${fltField}）`)

  // warp 同理，用整数坐标
  let warpWorst = 0
  for (let i = 0; i < 300; i++) {
    const x = Math.floor(Math.random() * WORLD_SIZE)
    const y = Math.floor(Math.random() * WORLD_SIZE)
    const [ax, ay] = f.warp(x, y)
    const [bx, by] = f.warp(x + WORLD_SIZE * 5, y - WORLD_SIZE * 3)
    warpWorst = Math.max(warpWorst, Math.abs(ax - bx), Math.abs(ay - by))
  }
  check('⭐ warp 整数坐标回绕后逐位相同', warpWorst === 0, `差 ${warpWorst.toExponential(2)}`)
}

// ── 2. ⭐ waterRatio 的精确语义 ──────────────────────────────────────────
{
  console.log('  waterRatio 实测占比：')
  for (const ratio of [0.02, 0.08, 0.15, 0.25, 0.4]) {
    const f = createFields({ seed: 'sea-test' })
    const baked = bakeElevation(f, ratio)
    let below = 0
    for (let i = 0; i < baked.elevation.length; i++) {
      if (baked.elevation[i]! < baked.seaLevel) below++
    }
    const actual = below / baked.elevation.length
    const err = Math.abs(actual - ratio)
    check(
      `waterRatio=${ratio} 实测占比误差 < 1%`,
      err < 0.01,
      `实测 ${(actual * 100).toFixed(2)}%（目标 ${(ratio * 100).toFixed(0)}%）`,
    )
    console.log(`    设 ${(ratio * 100).toFixed(0)}%  →  实测 ${(actual * 100).toFixed(2)}%  误差 ${(err * 100).toFixed(3)}%`)
  }
}

// ── 2b. 换种子不影响占比（这正是分位数相对常数阈值的价值） ───────────────
{
  const ratio = 0.18
  const actuals: number[] = []
  for (let i = 0; i < 8; i++) {
    const f = createFields({ seed: `seed-${i}` })
    const baked = bakeElevation(f, ratio)
    let below = 0
    for (let j = 0; j < baked.elevation.length; j++) {
      if (baked.elevation[j]! < baked.seaLevel) below++
    }
    actuals.push(below / baked.elevation.length)
  }
  const spread = Math.max(...actuals) - Math.min(...actuals)
  check('⭐ 8 个种子的水面占比几乎一致', spread < 0.005, `离散度 ${(spread * 100).toFixed(3)}%`)
  console.log(`    8 种子占比离散度：${(spread * 100).toFixed(3)}%（分位数法的价值所在）`)

  // 对照：如果用常数阈值会怎样
  const constThreshold = -0.2
  const constActuals: number[] = []
  for (let i = 0; i < 8; i++) {
    const f = createFields({ seed: `seed-${i}` })
    let below = 0
    for (let y = 0; y < WORLD_SIZE; y++) {
      for (let x = 0; x < WORLD_SIZE; x++) if (f.elevation(x, y) < constThreshold) below++
    }
    constActuals.push(below / (WORLD_SIZE * WORLD_SIZE))
  }
  const constSpread = Math.max(...constActuals) - Math.min(...constActuals)
  check(
    '⭐ 对照：常数阈值下占比确实会随种子漂移',
    constSpread > spread * 3,
    `常数阈值离散度 ${(constSpread * 100).toFixed(2)}% vs 分位数 ${(spread * 100).toFixed(3)}%`,
  )
  console.log(`    对照 常数阈值离散度：${(constSpread * 100).toFixed(2)}%  ← 用户拖同一个旋钮会得到不同结果`)
}

// ── 3. ⭐ 各场互不相关（必须跨种子测，单种子测不出分布） ──────────────────
//
// ⚠️ 低 radiusScale 的场在 512 格世界上只有很少的自由度，两个独立的低阶函数
// 在小定义域上会**偶然**相关。所以判据必须是「跨种子的最大值」，
// 单个种子恰好不相关说明不了任何问题。
{
  const corr = (a: number[], b: number[]) => {
    const ma = a.reduce((s, v) => s + v, 0) / a.length
    const mb = b.reduce((s, v) => s + v, 0) / b.length
    let num = 0
    let da = 0
    let db = 0
    for (let i = 0; i < a.length; i++) {
      const x = a[i]! - ma
      const y = b[i]! - mb
      num += x * y
      da += x * x
      db += y * y
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
  }

  const pairWorst = new Map<string, number>()
  const SEEDS = 10
  for (let s = 0; s < SEEDS; s++) {
    const f = createFields({ seed: `corr-${s}` })
    const samples: Record<string, number[]> = {}
    for (const name of FIELD_NAMES) samples[name] = []
    for (let i = 0; i < 3000; i++) {
      const x = Math.random() * WORLD_SIZE
      const y = Math.random() * WORLD_SIZE
      for (const name of FIELD_NAMES) samples[name]!.push(f[name](x, y))
    }
    for (let i = 0; i < FIELD_NAMES.length; i++) {
      for (let j = i + 1; j < FIELD_NAMES.length; j++) {
        const key = `${FIELD_NAMES[i]}×${FIELD_NAMES[j]}`
        const c = Math.abs(corr(samples[FIELD_NAMES[i]!]!, samples[FIELD_NAMES[j]!]!))
        pairWorst.set(key, Math.max(pairWorst.get(key) ?? 0, c))
      }
    }
  }

  const ranked = [...pairWorst.entries()].sort((a, b) => b[1] - a[1])
  console.log(`    ${SEEDS} 个种子的最强场间相关（前 3）：`)
  for (const [k, v] of ranked.slice(0, 3)) console.log(`      ${k} = ${v.toFixed(3)}`)

  // 阈值 0.3：低自由度场之间的偶然相关无法压到 0.1（实测 radiusScale=0.7 时
  // 跨种子最大 0.17，0.5 时 0.21）。真正的退化（radiusScale=0.22，全世界只有
  // 一个特征）会达到 0.52，这个阈值抓得住。
  const worst = ranked[0]!
  check('⭐ 跨种子任意两场相关 < 0.3', worst[1] < 0.3, `最强 ${worst[0]} = ${worst[1].toFixed(3)}`)

  // ⭐ 这一对是计划里点名的：settlement 与 moisture 相关就意味着
  // 「村子永远长在同一种生态里」，看起来像规则写死的
  const critical = pairWorst.get('moisture×settlement') ?? 0
  check(
    '⭐⭐ settlement 与 moisture 不相关（否则村子永远长在同一种生态里）',
    critical < 0.2,
    `实得 ${critical.toFixed(3)}`,
  )
  console.log(`      [关键对] moisture×settlement = ${critical.toFixed(3)}`)
}

// ── 3b. ⭐ 负向断言：radiusScale 过小会退化成单一特征 ────────────────────
{
  // 这条钉住上面那个坑：如果有人把 macro/settlement 的 radiusScale 调回 0.22，
  // 全世界只剩一个特征，场间相关会飙到 0.5 —— 断言必须能抓住。
  const f = createFields({ seed: 'feat-count' })
  let zc = 0
  let prev = f.macro(0, 256)
  for (let x = 1; x < WORLD_SIZE; x++) {
    const v = f.macro(x, 256)
    if (v > 0 !== prev > 0) zc++
    prev = v
  }
  const provinces = Math.max(1, Math.round(zc / 2))
  check(
    '⭐ macro 场在全世界产出多个「省」而不是一道斜坡',
    provinces >= 3,
    `只有 ${provinces} 个（radiusScale 太小了，会导致场间高相关）`,
  )
  console.log(`    macro 场的「省」数量：${provinces}`)
}

// ── 4. moistureBias 整体平移湿度（且只平移湿度） ─────────────────────────
{
  const a = createFields({ seed: 'bias-test', moistureBias: 0 })
  const b = createFields({ seed: 'bias-test', moistureBias: 0.3 })
  let shifted = 0
  let elevationMoved = 0
  const N = 1000
  for (let i = 0; i < N; i++) {
    const x = Math.random() * WORLD_SIZE
    const y = Math.random() * WORLD_SIZE
    shifted += b.moisture(x, y) - a.moisture(x, y)
    elevationMoved = Math.max(elevationMoved, Math.abs(b.elevation(x, y) - a.elevation(x, y)))
  }
  shifted /= N
  // clamp1 只截断顶到 +1 的少数样本，所以平移量非常接近 0.3
  check('moistureBias 确实整体抬高湿度', shifted > 0.25 && shifted <= 0.305, `实测平移 ${shifted.toFixed(4)}`)
  check('⭐ moistureBias 不影响高度场', elevationMoved === 0, `高度也动了 ${elevationMoved.toExponential(2)}`)
  check('湿度仍在 [-1,1] 内', (() => {
    for (let i = 0; i < 2000; i++) {
      const v = b.moisture(Math.random() * WORLD_SIZE, Math.random() * WORLD_SIZE)
      if (v < -1 || v > 1) return false
    }
    return true
  })())
}

// ── 5. warp 幅度与连续性 ─────────────────────────────────────────────────
{
  const f = createFields({ seed: 'warp-amp' })
  let maxAbs = 0
  for (let i = 0; i < 5000; i++) {
    const [dx, dy] = f.warp(Math.random() * WORLD_SIZE, Math.random() * WORLD_SIZE)
    maxAbs = Math.max(maxAbs, Math.abs(dx), Math.abs(dy))
  }
  check('warp 幅度不超过 7 格', maxAbs <= 7.0001, `实测 ${maxAbs.toFixed(3)}`)
  check('warp 幅度够大（> 2 格才有犬牙效果）', maxAbs > 2, `实测 ${maxAbs.toFixed(3)}`)

  // 扭曲后的湿度采样仍然跨缝连续
  const warped = (x: number, y: number) => {
    const [dx, dy] = f.warp(x, y)
    return f.moisture(x + dx, y + dy)
  }
  const step = (ax: number, ay: number, bx: number, by: number) => Math.abs(warped(ax, ay) - warped(bx, by))
  let seam = 0
  let inner = 0
  for (let i = 0; i < 300; i++) {
    const t = Math.floor(Math.random() * WORLD_SIZE)
    seam = Math.max(seam, step(WORLD_SIZE - 1, t, 0, t), step(t, WORLD_SIZE - 1, t, 0))
    const x = 1 + Math.floor(Math.random() * (WORLD_SIZE - 3))
    const y = 1 + Math.floor(Math.random() * (WORLD_SIZE - 3))
    inner = Math.max(inner, step(x, y, x + 1, y), step(x, y, x, y + 1))
  }
  check('⭐ 域扭曲后跨缝仍无断裂', seam <= inner * 2, `跨缝 ${seam.toFixed(4)} vs 内部 ${inner.toFixed(4)}`)
  console.log(`    域扭曲后 跨缝落差 ${seam.toFixed(4)} / 内部落差 ${inner.toFixed(4)}`)
}

// ── 6. 可复现 ────────────────────────────────────────────────────────────
{
  const a = createFields({ seed: 'repro', moistureBias: 0.1 })
  const b = createFields({ seed: 'repro', moistureBias: 0.1 })
  let same = true
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * WORLD_SIZE
    const y = Math.random() * WORLD_SIZE
    for (const name of FIELD_NAMES) if (a[name](x, y) !== b[name](x, y)) same = false
  }
  check('同种子逐位可复现', same)

  const c = createFields({ seed: 'repro-other' })
  let differs = false
  for (let i = 0; i < 100; i++) {
    const x = Math.random() * WORLD_SIZE
    if (a.elevation(x, 10) !== c.elevation(x, 10)) differs = true
  }
  check('不同种子产出不同世界', differs)
}

// ── 7. bakeElevation 性能与一致性 ────────────────────────────────────────
{
  const f = createFields({ seed: 'perf' })
  const t0 = performance.now()
  const baked = bakeElevation(f, 0.2)
  const ms = performance.now() - t0
  check('bake 26 万格 < 2000ms', ms < 2000, `${ms.toFixed(0)}ms`)
  check('bake 的数组与逐点查询一致', (() => {
    for (let i = 0; i < 500; i++) {
      const x = Math.floor(Math.random() * WORLD_SIZE)
      const y = Math.floor(Math.random() * WORLD_SIZE)
      if (baked.elevation[y * WORLD_SIZE + x] !== Math.fround(f.elevation(x, y))) return false
    }
    return true
  })())
  check('seaLevel 落在 [min,max] 内', baked.seaLevel >= baked.min && baked.seaLevel <= baked.max,
    `sea ${baked.seaLevel.toFixed(4)} range [${baked.min.toFixed(4)}, ${baked.max.toFixed(4)}]`)
  console.log(`    bake 耗时 ${ms.toFixed(0)}ms，seaLevel=${baked.seaLevel.toFixed(4)}`)
}

console.log(`\n噪声场验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过')
}
