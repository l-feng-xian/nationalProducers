/**
 * 环面噪声验证。
 *
 * 跑法： npm run verify:noise
 *
 * ## 主判据是「跨缝连续性」，不是「f(0)==f(W)」
 * 一开始我测的是 `f(0,y)` 与 `f(512,y)` 是否逐位相等，阈值卡在 1e-12。
 * 这个判据**测不到实际路径**：fields.ts 的每次查询都先 wrapTile() 回绕，
 * `f(512,y)` 永远不会被调用。它还会因为 simplex 单元边界的偶发效应误报
 * （radiusScale=2.5 时 4e-4，而 octaves=8 让 r1·f 达到 204 反而只有 9.6e-9 ——
 * 不随半径单调，说明不是系统性精度衰减）。
 *
 * 噪声周期性真正买到的是：x=511 与 x=0 是连续的邻居，画面上没有断线。
 * 所以主判据改成 `seamStepRatio` —— 跨缝相邻格落差 / 内部相邻格落差。
 * 实测分离度很干净：正确实现 0.71–1.18，错误实现 4.6–5.1。
 *
 * `seamResidual` 保留为粗放判据（容差放宽到 1e-3），只抓「整条接缝撕开」。
 *
 * ## 负向断言
 * 「缩放 u/v」这个错误**在 lacunarity 为整数时完全看不出来**（实测 1.8e-15，
 * 和正确实现一样无缝），因为整数倍频下 `u·f` 在接缝处仍是 2π 的整数倍。
 * 所以负向断言必须用非整数 lacunarity 才测得出它 —— 这一点本身就是本文件
 * 要钉死的知识：那个 bug 是潜伏的，改 lacunarity 的人不会想到自己触发了它。
 */

import type { NoiseFunction4D } from 'simplex-noise'
import { createTorusFbm, makeNoise4D, R1, R2 } from '@/services/infinite-world/generation/noise'
import { seedOf, seededRandom, streamSeed } from '@/services/infinite-world/generation/rng'
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

const TAU = Math.PI * 2
/**
 * `f(0,y)` vs `f(W,y)` 的容差 —— **粗放判据**。
 *
 * 这个恒等式在实际路径上测不到（查询前一律 wrapTile，`f(512,y)` 永不被调用），
 * 它只用来抓「接缝整个撕开」（0.2 量级）这种粗放破坏。
 *
 * 实测正确实现最差 4e-4（radiusScale=2.5 时踩到 simplex 单元边界，且不随半径
 * 单调 —— oct=8 让 r1·f 达到 204 反而只有 9.6e-9，说明是偶发而非系统性衰减）。
 * 所以容差取 1e-3：抓得住真实破坏，又不会被浮点细节误报。
 *
 * **真正的判据是 seamStepRatio（跨缝连续性）**，见下。
 */
const SEAM_TOL = 1e-3

/**
 * 跨缝连续性阈值：跨缝相邻格落差的 p99 / 内部相邻格落差的 p99。
 *
 * 实测分离度很干净：
 *   正确实现（8 种 radiusScale × lacunarity 组合）  0.71 – 1.18   ≈ 1
 *   错误实现（缩放 u/v + 非整数 lacunarity）        4.6 – 5.1
 *
 * 取 2.5 作边界，两侧各留约 2 倍余量。
 * 错误实现的绝对撕裂量是 0.31，而生态阈值间距 0.03 —— 相当于一次跨 10 级生态，
 * 在画面上是一条贯穿世界的断线。
 */
const SEAM_STEP_TOL = 2.5

/** 故意写错的 fBm：把倍频乘进角度而不是半径 */
function createBrokenFbm(noise: NoiseFunction4D, lacunarity: number, octaves = 3) {
  return (x: number, y: number): number => {
    const u = (x / WORLD_SIZE) * TAU
    const v = (y / WORLD_SIZE) * TAU
    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum +=
        amp *
        noise(
          Math.cos(u * freq) * R1,
          Math.sin(u * freq) * R1,
          Math.cos(v * freq) * R2,
          Math.sin(v * freq) * R2,
        )
      norm += amp
      amp *= 0.5
      freq *= lacunarity
    }
    return sum / norm
  }
}

/**
 * ⭐ 真正要测的性质：**跨接缝相邻格之间不出现视觉断裂**。
 *
 * `f(0,y)` 与 `f(512,y)` 是否逐位相等其实**测不到实际路径** —— fields.ts 的每次
 * 查询都先 wrapTile() 回绕，`f(512,y)` 永远不会被调用。噪声周期性真正买到的是：
 * x=511 与 x=0 这两格在地形上是连续的邻居，不会出现一条突兀的断线。
 *
 * 所以这里比「跨接缝的相邻格落差」与「内部任意相邻格落差」的分布：
 * 前者必须落在后者的正常范围内。接缝真撕开时这个比值会是几十上百倍。
 *
 * 返回 跨缝落差的 p99 / 内部落差的 p99。
 */
function seamStepRatio(f: (x: number, y: number) => number, samples = 400): number {
  const seamSteps: number[] = []
  const innerSteps: number[] = []
  for (let i = 0; i < samples; i++) {
    const t = Math.floor((i / samples) * WORLD_SIZE)
    // 跨 X 缝：511 → 0（回绕后的真实邻居）
    seamSteps.push(Math.abs(f(WORLD_SIZE - 1, t) - f(0, t)))
    // 跨 Y 缝
    seamSteps.push(Math.abs(f(t, WORLD_SIZE - 1) - f(t, 0)))
    // 内部相邻格
    const x = Math.floor(Math.random() * (WORLD_SIZE - 2)) + 1
    const y = Math.floor(Math.random() * (WORLD_SIZE - 2)) + 1
    innerSteps.push(Math.abs(f(x, y) - f(x + 1, y)))
    innerSteps.push(Math.abs(f(x, y) - f(x, y + 1)))
  }
  const p99 = (a: number[]) => {
    a.sort((p, q) => p - q)
    return a[Math.min(a.length - 1, Math.floor(a.length * 0.99))]!
  }
  const inner = p99(innerSteps)
  return inner > 0 ? p99(seamSteps) / inner : 0
}

/** 四边 + 四角的最大接缝残差（辅助指标，只用来抓粗放破坏） */
function seamResidual(f: (x: number, y: number) => number, samples = 300): number {
  let worst = 0
  for (let i = 0; i < samples; i++) {
    const t = (i / samples) * WORLD_SIZE
    worst = Math.max(worst, Math.abs(f(0, t) - f(WORLD_SIZE, t)))
    worst = Math.max(worst, Math.abs(f(t, 0) - f(t, WORLD_SIZE)))
  }
  for (const [ax, ay, bx, by] of [
    [0, 0, WORLD_SIZE, WORLD_SIZE],
    [0, 0, WORLD_SIZE, 0],
    [0, 0, 0, WORLD_SIZE],
    [WORLD_SIZE, 0, 0, WORLD_SIZE],
  ] as const) {
    worst = Math.max(worst, Math.abs(f(ax, ay) - f(bx, by)))
  }
  return worst
}

// ── 1. 各倍频档位的接缝 ──────────────────────────────────────────────────
console.log('  实测接缝残差：')
for (const octaves of [1, 2, 3, 5, 8]) {
  const n = makeNoise4D(seededRandom(999 + octaves))
  const r = seamResidual(createTorusFbm(n, { octaves }))
  check(`${octaves} 倍频接缝 < ${SEAM_TOL}`, r < SEAM_TOL, `实得 ${r.toExponential(2)}`)
  console.log(`    octaves=${octaves}  ${r.toExponential(2)}`)
}

// ── 2. 各 radiusScale 档位（覆盖 fields.ts 实际会用到的范围） ────────────
for (const rs of [0.22, 0.28, 0.55, 0.6, 1, 2.5]) {
  const n = makeNoise4D(seededRandom(1234))
  const r = seamResidual(createTorusFbm(n, { octaves: 3, radiusScale: rs }), 150)
  check(`radiusScale=${rs} 接缝 < ${SEAM_TOL}`, r < SEAM_TOL, `实得 ${r.toExponential(2)}`)
  console.log(`    radiusScale=${rs}  ${r.toExponential(2)}`)
}

// ── 2b. ⭐ 跨接缝连续性（这才是实际路径上真正要的性质） ──────────────────
console.log('  跨缝相邻格落差 / 内部相邻格落差（p99 之比，应 ≈ 1）：')
for (const rs of [0.22, 0.28, 1, 2.5]) {
  for (const lac of [2, 1.87]) {
    const n = makeNoise4D(seededRandom(1234))
    const ratio = seamStepRatio(createTorusFbm(n, { octaves: 3, radiusScale: rs, lacunarity: lac }))
    check(
      `⭐ radiusScale=${rs} lacunarity=${lac} 跨缝无断裂`,
      ratio < SEAM_STEP_TOL,
      `比值 ${ratio.toFixed(2)}（跨缝落差是内部的 ${ratio.toFixed(1)} 倍）`,
    )
    console.log(`    rs=${rs} lac=${lac}  ×${ratio.toFixed(2)}`)
  }
}

// ── 3. ⭐⭐ 负向断言：缩放 u/v 的错误写法 ────────────────────────────────
{
  const n = makeNoise4D(seededRandom(4242))

  // 3a. 整数 lacunarity 下这个错误**看不出来** —— 这正是它危险的地方
  const brokenInt = seamResidual(createBrokenFbm(n, 2), 150)
  check(
    '⭐⭐负向断言 整数 lacunarity 会掩盖「缩放u/v」这个错误',
    brokenInt < SEAM_TOL,
    `实得 ${brokenInt.toExponential(2)}，若这里变大说明前提变了，负向断言 3b 要重新设计`,
  )

  // 3b. 非整数 lacunarity 下它必须暴露 —— 用「跨缝断裂」这个真实可见的判据
  for (const lac of [1.87, 2.13]) {
    const r = seamResidual(createBrokenFbm(n, lac), 150)
    const ratio = seamStepRatio(createBrokenFbm(n, lac))
    check(
      `⭐⭐负向断言 缩放u/v + lacunarity=${lac} 必须撕开接缝`,
      r > 0.01 && ratio > SEAM_STEP_TOL,
      `残差 ${r.toExponential(2)} 断裂比 ×${ratio.toFixed(1)} —— 测不出来就是测试失效了`,
    )
    console.log(`    [错误实现] 缩放u/v lac=${lac}  残差 ${r.toExponential(2)}  断裂 ×${ratio.toFixed(0)}`)
  }

  // 3c. 正确实现对非整数 lacunarity 同样跨缝连续（这才是它比错误写法强的地方）
  for (const lac of [1.87, 2.13]) {
    const ratio = seamStepRatio(createTorusFbm(n, { octaves: 3, lacunarity: lac }))
    check(
      `⭐ 正确实现在 lacunarity=${lac} 下仍跨缝连续`,
      ratio < SEAM_STEP_TOL,
      `断裂比 ×${ratio.toFixed(2)}`,
    )
  }
  console.log(`    [错误实现] 缩放u/v lacunarity=2   ${brokenInt.toExponential(2)}  ← 潜伏，看不出来`)
}

// ── 4. 100 个种子 × 四边四角 ─────────────────────────────────────────────
{
  let worst = 0
  let worstSeed = ''
  for (let i = 0; i < 100; i++) {
    const seed = `seed-${i}`
    const n = makeNoise4D(seededRandom(streamSeed(seedOf(seed), 'elevation')))
    const r = seamResidual(createTorusFbm(n, { octaves: 3 }), 40)
    if (r > worst) {
      worst = r
      worstSeed = seed
    }
  }
  check(`⭐ 100 个种子接缝均 < ${SEAM_TOL}`, worst < SEAM_TOL, `最差 ${worstSeed}: ${worst.toExponential(2)}`)
  console.log(`    100 种子最差：${worst.toExponential(2)}（${worstSeed}）`)
}

// ── 5. 整圈偏移一致 ──────────────────────────────────────────────────────
{
  const f = createTorusFbm(makeNoise4D(seededRandom(777)), { octaves: 3 })
  let worst = 0
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * WORLD_SIZE
    const y = Math.random() * WORLD_SIZE
    worst = Math.max(
      worst,
      Math.abs(f(x, y) - f(x + WORLD_SIZE, y)),
      Math.abs(f(x, y) - f(x, y + WORLD_SIZE)),
      Math.abs(f(x, y) - f(x - WORLD_SIZE, y - WORLD_SIZE)),
    )
  }
  check(`整圈偏移一致 < ${SEAM_TOL}`, worst < SEAM_TOL, `实得 ${worst.toExponential(2)}`)
}

// ── 6. ⚠️ 多圈偏移确实掉精度（所以查询前必须回绕） ──────────────────────
{
  const f = createTorusFbm(makeNoise4D(seededRandom(777)), { octaves: 3 })
  let worst = 0
  for (let i = 0; i < 200; i++) {
    const x = Math.random() * WORLD_SIZE
    const y = Math.random() * WORLD_SIZE
    worst = Math.max(worst, Math.abs(f(x, y) - f(x + WORLD_SIZE * 40, y)))
  }
  // 这不是 bug，是三角函数大幅角约减的固有损失。钉住它，防止有人「优化」掉回绕。
  check('⚠️ 40 圈偏移确实掉精度（比单圈差 2 个数量级以上）', worst > 1e-14, `实得 ${worst.toExponential(2)}`)
  console.log(`    40 圈偏移残差：${worst.toExponential(2)}（正因如此，查询前必须 wrap）`)
}

// ── 7. 值域、动态范围与可复现 ────────────────────────────────────────────
{
  const f = createTorusFbm(makeNoise4D(seededRandom(555)), { octaves: 4 })
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < 20000; i++) {
    const v = f(Math.random() * WORLD_SIZE, Math.random() * WORLD_SIZE)
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  check('值域落在 [-1, 1]', lo >= -1 && hi <= 1, `实得 [${lo.toFixed(3)}, ${hi.toFixed(3)}]`)
  check('动态范围足够', hi - lo > 0.6, `跨度仅 ${(hi - lo).toFixed(3)}`)

  const a = createTorusFbm(makeNoise4D(seededRandom(31337)), { octaves: 3 })
  const b = createTorusFbm(makeNoise4D(seededRandom(31337)), { octaves: 3 })
  let same = true
  for (let i = 0; i < 500; i++) {
    const x = Math.random() * WORLD_SIZE
    const y = Math.random() * WORLD_SIZE
    if (a(x, y) !== b(x, y)) same = false
  }
  check('同种子逐位可复现', same)
}

// ── 8. 标签派生的流互不相关 ──────────────────────────────────────────────
{
  const base = seedOf('same-world')
  const h = createTorusFbm(makeNoise4D(seededRandom(streamSeed(base, 'elevation'))), { octaves: 3 })
  const m = createTorusFbm(makeNoise4D(seededRandom(streamSeed(base, 'moisture'))), { octaves: 3 })
  let corr = 0
  const N = 4000
  for (let i = 0; i < N; i++) {
    const x = Math.random() * WORLD_SIZE
    const y = Math.random() * WORLD_SIZE
    corr += h(x, y) * m(x, y)
  }
  corr /= N
  check('⭐ 高度场与湿度场不相关', Math.abs(corr) < 0.05, `相关度 ${corr.toFixed(4)}`)
  console.log(`    高度×湿度相关度：${corr.toFixed(4)}`)
}

// ── 9. radiusScale 真的改变特征尺度 ──────────────────────────────────────
{
  const n = makeNoise4D(seededRandom(8888))
  const roughness = (f: (x: number, y: number) => number) => {
    let s = 0
    for (let i = 0; i < 1000; i++) {
      const x = Math.random() * WORLD_SIZE
      const y = Math.random() * WORLD_SIZE
      s += Math.abs(f(x + 1, y) - f(x, y))
    }
    return s / 1000
  }
  const rc = roughness(createTorusFbm(n, { octaves: 1, radiusScale: 0.25 }))
  const rf = roughness(createTorusFbm(n, { octaves: 1, radiusScale: 4 }))
  check('大 radiusScale 更碎', rf > rc * 3, `coarse ${rc.toFixed(5)} / fine ${rf.toFixed(5)}`)
}

console.log(`\n环面噪声验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过（含 4 条负向断言）')
}
