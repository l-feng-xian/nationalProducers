/**
 * 水文验证。
 *
 * 跑法： npm run verify:hydrology
 *
 * 核心命题：**河流的贯通性是构造出来的，不是事后检查出来的**。
 * 填洼保证每个非终端格都有一条严格下降的流向链通到某个盆地；
 * 河格是这些链上的一段，所以它天然连通、天然汇入湖海。
 *
 * 本文件把这条命题拆成可验证的断言，并用负向断言钉住 FILL_EPS 这个坑。
 */

import {
  buildHydrology,
  computeAccumulation,
  computeFlowD8,
  downstream,
  priorityFlood,
  WATER,
} from '@/services/infinite-world/generation/hydrology'
import { bakeElevation, createFields } from '@/services/infinite-world/generation/fields'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { DIR8, wrapTile } from '@/services/infinite-world/core/torus'

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

function build(seed: string, waterRatio = 0.15, riverDensity = 0.5) {
  const fields = createFields({ seed })
  const baked = bakeElevation(fields, waterRatio)
  const t0 = performance.now()
  const h = buildHydrology({
    elevation: baked.elevation,
    seaLevel: baked.seaLevel,
    fields,
    riverDensity,
  })
  return { fields, baked, h, ms: performance.now() - t0 }
}

// ── 1. 填洼的两条不变量 ──────────────────────────────────────────────────
{
  const { baked, h } = build('flood-test')

  let below = 0
  for (let i = 0; i < N; i++) if (h.filled[i]! < baked.elevation[i]! - 1e-9) below++
  check('⭐ 填洼后处处 ≥ 原高度', below === 0, `${below} 格被填低了`)

  // 沿流向严格下降 —— 这是 FILL_EPS 换来的核心性质
  let notDescending = 0
  for (let i = 0; i < N; i++) {
    const d = downstream(i, h.flow)
    if (d >= 0 && h.filled[d]! >= h.filled[i]!) notDescending++
  }
  check('⭐⭐ 沿流向严格下降（FILL_EPS 的作用）', notDescending === 0, `${notDescending} 处不下降`)
}

// ── 2. ⭐⭐ 负向断言：FILL_EPS = 0 会让河一条都出不来 ────────────────────
{
  const fields = createFields({ seed: 'eps-test' })
  const baked = bakeElevation(fields, 0.15)

  // 复刻一个 EPS=0 的填洼
  const floodNoEps = (): Float32Array => {
    const filled = new Float32Array(N)
    const visited = new Uint8Array(N)
    const heap: { i: number; h: number }[] = []
    for (let i = 0; i < N; i++) {
      if (baked.elevation[i]! <= baked.seaLevel) {
        filled[i] = baked.elevation[i]!
        visited[i] = 1
        heap.push({ i, h: baked.elevation[i]! })
      }
    }
    heap.sort((a, b) => a.h - b.h)
    while (heap.length) {
      const cur = heap.shift()!
      const cx = cur.i % WORLD_SIZE
      const cy = (cur.i - cx) / WORLD_SIZE
      for (let k = 0; k < 8; k++) {
        const d = DIR8[k]!
        const ni = wrapTile(cy + d[1]!) * WORLD_SIZE + wrapTile(cx + d[0]!)
        if (visited[ni]) continue
        // ← 唯一的差别：没有 + EPS
        const hh = Math.max(baked.elevation[ni]!, filled[cur.i]!)
        filled[ni] = hh
        visited[ni] = 1
        let lo = 0
        let hi = heap.length
        while (lo < hi) {
          const mid = (lo + hi) >> 1
          if (heap[mid]!.h < hh) lo = mid + 1
          else hi = mid
        }
        heap.splice(lo, 0, { i: ni, h: hh })
      }
    }
    return filled
  }

  const filled0 = floodNoEps()
  const flow0 = computeFlowD8(filled0)
  let sinks0 = 0
  for (let i = 0; i < N; i++) if (flow0[i]! < 0) sinks0++

  const filledEps = priorityFlood(baked.elevation, baked.seaLevel)
  const flowEps = computeFlowD8(filledEps)
  let sinksEps = 0
  for (let i = 0; i < N; i++) if (flowEps[i]! < 0) sinksEps++

  check(
    '⭐⭐负向断言 FILL_EPS=0 会产生大量「无下游」的格',
    sinks0 > sinksEps * 2,
    `EPS=0 ${sinks0} 个终端 vs 有 EPS ${sinksEps} 个 —— 差不出来就是负向断言失效了`,
  )
  console.log(`    终端盆地数：FILL_EPS=0 → ${sinks0}   有 EPS → ${sinksEps}`)

  const accum0 = computeAccumulation(filled0, flow0)
  let max0 = 0
  for (let i = 0; i < N; i++) if (accum0[i]! > max0) max0 = accum0[i]!
  const accumEps = computeAccumulation(filledEps, flowEps)
  let maxEps = 0
  for (let i = 0; i < N; i++) if (accumEps[i]! > maxEps) maxEps = accumEps[i]!
  check(
    '⭐⭐负向断言 FILL_EPS=0 的最大汇流量远小于正常值',
    max0 < maxEps / 2,
    `EPS=0 最大汇流 ${max0.toFixed(0)} vs 正常 ${maxEps.toFixed(0)}`,
  )
  console.log(`    最大汇流量：FILL_EPS=0 → ${max0.toFixed(0)}   有 EPS → ${maxEps.toFixed(0)}`)
}

/**
 * 从河口沿**上游**追主干。
 *
 * ⚠️ 汇流量最大的格就是**河口**（最下游），从它往下游走一步就到海了。
 * 要量主干长度必须反过来：每步走到「流向本格且汇流量最大」的那个上游邻居。
 */
function traceTrunkUpstream(h: {
  accum: Float32Array
  flow: Int8Array
  water: Uint8Array
  riverThreshold: number
}): { length: number; allWater: boolean; mouth: number } {
  let mouth = 0
  for (let i = 0; i < N; i++) if (h.accum[i]! > h.accum[mouth]!) mouth = i

  let cur = mouth
  let length = 0
  let allWater = true
  let guard = 0
  while (guard++ < N) {
    if (h.water[cur] === WATER.none) allWater = false
    length++
    // 找流进本格的上游邻居里汇流量最大的那个
    const cx = cur % WORLD_SIZE
    const cy = (cur - cx) / WORLD_SIZE
    let best = -1
    let bestAccum = 0
    for (let k = 0; k < 8; k++) {
      const d = DIR8[k]!
      const ni = wrapTile(cy + d[1]!) * WORLD_SIZE + wrapTile(cx + d[0]!)
      if (downstream(ni, h.flow) !== cur) continue
      if (h.accum[ni]! > bestAccum) {
        bestAccum = h.accum[ni]!
        best = ni
      }
    }
    if (best < 0 || bestAccum < h.riverThreshold) break
    cur = best
  }
  return { length, allWater, mouth }
}

// ── 3. ⭐ 河流贯通性（构造出来的性质） ───────────────────────────────────
{
  console.log('  各种子的河网：')
  let allPass = true
  for (const seed of ['r1', 'r2', 'r3', 'r4', 'r5']) {
    const { h } = build(seed)
    let riverCells = 0
    for (let i = 0; i < N; i++) if (h.water[i] !== WATER.none) riverCells++

    const trunk = traceTrunkUpstream(h)
    const ok = riverCells > 1000 && trunk.length > 50 && trunk.allWater
    if (!ok) allPass = false
    console.log(
      `    ${seed}: 水体 ${riverCells} 格（${((riverCells / N) * 100).toFixed(1)}%）  ` +
        `主干长 ${trunk.length}  全程有水 ${trunk.allWater ? '✓' : '✗'}  ${h.rivers.length} 条河道`,
    )
  }
  check('⭐ 5 个种子都有贯通的主干河（长度 > 50 且全程有水）', allPass, '见上方明细')
}

// ── 4. 河道 4 连通（双网格水层不能出现 5/10 夹点） ──────────────────────
{
  const { h } = build('conn-test')
  // 从河口沿上游走主干，逐步检查相邻两格是否 4 连通（不能只对角相邻）
  const trunk = traceTrunkUpstream(h)
  let cur = trunk.mouth
  let diagonalOnly = 0
  let steps = 0
  let guard = 0
  while (cur >= 0 && guard++ < N) {
    // 下一步取上游汇流最大者
    const ux = cur % WORLD_SIZE
    const uy = (cur - ux) / WORLD_SIZE
    let d = -1
    let bestAccum = 0
    for (let k = 0; k < 8; k++) {
      const dd = DIR8[k]!
      const ni = wrapTile(uy + dd[1]!) * WORLD_SIZE + wrapTile(ux + dd[0]!)
      if (downstream(ni, h.flow) !== cur) continue
      if (h.accum[ni]! > bestAccum) {
        bestAccum = h.accum[ni]!
        d = ni
      }
    }
    if (d < 0 || bestAccum < h.riverThreshold) break
    const cx = cur % WORLD_SIZE
    const cy = (cur - cx) / WORLD_SIZE
    const dx = d % WORLD_SIZE
    const dy = (d - dx) / WORLD_SIZE
    const sx = Math.abs(((dx - cx + WORLD_SIZE + WORLD_SIZE / 2) % WORLD_SIZE) - WORLD_SIZE / 2)
    const sy = Math.abs(((dy - cy + WORLD_SIZE + WORLD_SIZE / 2) % WORLD_SIZE) - WORLD_SIZE / 2)
    if (sx === 1 && sy === 1) {
      // 对角步：栅格化应当补了角格，检查两个正交候选至少有一个是水
      const a = wrapTile(cy) * WORLD_SIZE + wrapTile(dx)
      const b = wrapTile(dy) * WORLD_SIZE + wrapTile(cx)
      if (h.water[a] === WATER.none && h.water[b] === WATER.none) diagonalOnly++
    }
    steps++
    cur = d
  }
  check('⭐ 主干河全程 4 连通（对角处已补角格）', diagonalOnly === 0, `${diagonalOnly}/${steps} 处只有对角相邻`)
  console.log(`    主干 ${steps} 步，对角缺口 ${diagonalOnly} 处`)
}

// ── 5. riverDensity 的语义 ───────────────────────────────────────────────
{
  console.log('  riverDensity → 水体占比：')
  const ratios: number[] = []
  for (const rd of [0, 0.5, 1]) {
    const { h } = build('density', 0.05, rd)
    let cells = 0
    for (let i = 0; i < N; i++) if (h.water[i] !== WATER.none) cells++
    const r = cells / N
    ratios.push(r)
    console.log(`    riverDensity=${rd}  →  ${(r * 100).toFixed(2)}%`)
  }
  check('⭐ riverDensity 单调增加水体', ratios[0]! < ratios[1]! && ratios[1]! < ratios[2]!,
    `实测 ${ratios.map((r) => (r * 100).toFixed(2) + '%').join(' / ')}`)
}

// ── 6. 跨接缝：河道可以穿过世界边界且不断 ───────────────────────────────
{
  let seamRivers = 0
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6']) {
    const { h } = build(seed)
    // 数一下有多少河格贴着接缝（x=0 或 x=511），且对侧也是水
    for (let y = 0; y < WORLD_SIZE; y++) {
      const a = y * WORLD_SIZE + 0
      const b = y * WORLD_SIZE + (WORLD_SIZE - 1)
      if (h.water[a] !== WATER.none && h.water[b] !== WATER.none) seamRivers++
    }
  }
  check('⭐ 存在跨接缝连续的水体（证明环面拓扑真的在起作用）', seamRivers > 0,
    `6 个种子一共 ${seamRivers} 处跨缝水体`)
  console.log(`    跨接缝连续的水体：${seamRivers} 处`)
}

// ── 7. 湿地依附于水体 ────────────────────────────────────────────────────
{
  const { h } = build('marsh-test')
  let marshCells = 0
  let marshOnWater = 0
  for (let i = 0; i < N; i++) {
    if (!h.marsh[i]) continue
    marshCells++
    if (h.water[i] !== WATER.none) marshOnWater++
  }
  check('湿地存在', marshCells > 0, `${marshCells} 格`)
  check('⭐ 湿地与水体不重叠', marshOnWater === 0, `${marshOnWater} 格既是水又是湿地`)
  console.log(`    湿地 ${marshCells} 格（${((marshCells / N) * 100).toFixed(1)}%）`)
}

// ── 8. 确定性与性能 ──────────────────────────────────────────────────────
{
  const a = build('repro')
  const b = build('repro')
  let same = true
  for (let i = 0; i < N; i += 37) {
    if (a.h.water[i] !== b.h.water[i] || a.h.marsh[i] !== b.h.marsh[i]) same = false
  }
  check('⭐ 同种子逐格可复现', same)
  check('水文计算 < 8 秒', a.ms < 8000, `${a.ms.toFixed(0)}ms`)
  console.log(`    水文耗时 ${a.ms.toFixed(0)}ms`)
}

console.log(`\n水文验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过（含 2 条负向断言）')
}
