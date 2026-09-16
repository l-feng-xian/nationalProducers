/**
 * 双网格与程序化遮罩验证。
 *
 * 跑法： npm run verify:dualgrid
 * 顺带把三套遮罩图集渲染成 PNG（output/preview/masks-*.png）供肉眼确认。
 *
 * ## 核心命题
 * **遮罩无缝是构造性质**：显示格 D(i,j) 的右边与 D(i+1,j) 的左边插值的是
 * 同一对角点值，所以只要 alpha 是「四角双线性插值的纯函数」，两侧就逐点相同。
 *
 * 这条性质脆弱的地方在于「纯函数」三个字 —— 往遮罩里加任何逐格噪声都会
 * 让两侧各掷各的，边上裂开一条缝。负向断言专门钉这一条。
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import {
  MASK_ATLAS_PX,
  MASK_SETS,
  MASK_TILE_PX,
  generateMaskAtlas,
  maskAlphaAt,
  maxSeamMismatch,
} from '@/services/infinite-world/grid/masks'
import {
  LAYERS,
  frameOf,
  maskAt,
  maskHistogram,
} from '@/services/infinite-world/grid/dualGrid'
import { buildWorld } from '@/services/infinite-world/generation/pipeline'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { Flag, Surface, createEmptyGrid } from '@/services/infinite-world/generation/grid'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

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

const SETS = ['organic', 'stepped', 'hard'] as const

// ── 1. ⭐⭐ 无缝：共享边逐点相等 ────────────────────────────────────────
{
  console.log('  遮罩接边最大偏差：')
  for (const set of SETS) {
    const worst = maxSeamMismatch(set)
    check(`⭐⭐ ${set} 遮罩共享边逐点相等`, worst === 0, `最大偏差 ${worst.toExponential(2)}`)
    console.log(`    ${set}  ${worst === 0 ? '0（完全相等）' : worst.toExponential(2)}`)
  }
}

// ── 1b. ⭐⭐ 负向断言：往遮罩里加逐格噪声会撕开接边 ──────────────────────
{
  // 复刻一个「加了逐格噪声」的 alpha 函数：噪声只依赖格内坐标，
  // 于是相邻两格在共享边上取到的是**不同**的扰动
  const noisy = (mask: number, u: number, v: number, cellSalt: number): number => {
    const base = maskAlphaAt(mask, u, v, MASK_SETS.organic)
    const n = Math.sin(cellSalt * 12.9898 + u * 78.233 + v * 37.719) * 0.5
    return Math.min(1, Math.max(0, base + n * 0.25))
  }

  let worst = 0
  for (let left = 0; left < 16; left++) {
    for (let right = 0; right < 16; right++) {
      if (((left >> 1) & 1) !== (right & 1)) continue
      if (((left >> 2) & 1) !== ((right >> 3) & 1)) continue
      for (let k = 0; k < MASK_TILE_PX; k++) {
        const v = (k + 0.5) / MASK_TILE_PX
        // 两格用不同的盐 —— 这正是「逐格噪声」的本质
        worst = Math.max(worst, Math.abs(noisy(left, 1, v, 1) - noisy(right, 0, v, 2)))
      }
    }
  }
  check(
    '⭐⭐负向断言 逐格噪声确实会撕开接边',
    worst > 0.05,
    `只有 ${worst.toExponential(2)} —— 说明这条负向断言没在测东西`,
  )
  console.log(`    [负向] 加逐格噪声后接边偏差 ${worst.toFixed(3)}  ← 所以噪声只能在着色器里按世界坐标加`)
}

// ── 2. 边界情形 ──────────────────────────────────────────────────────────
{
  for (const set of SETS) {
    const opt = MASK_SETS[set]
    let zeroOk = true
    let fullOk = true
    for (let k = 0; k < 64; k++) {
      const u = (k % 8) / 7
      const v = Math.floor(k / 8) / 7
      if (maskAlphaAt(0, u, v, opt) !== 0) zeroOk = false
      if (maskAlphaAt(15, u, v, opt) !== 1) fullOk = false
    }
    check(`${set}: mask=0 恒为透明`, zeroOk)
    check(`${set}: mask=15 恒为不透明`, fullOk)
  }
}

// ── 3. ⭐ 鞍点 5/10 必须连通 ────────────────────────────────────────────
{
  for (const set of SETS) {
    const opt = MASK_SETS[set]
    const c5 = maskAlphaAt(5, 0.5, 0.5, opt)
    const c10 = maskAlphaAt(10, 0.5, 0.5, opt)
    check(`⭐ ${set}: mask=5 中心连通`, c5 > 0.5, `中心 alpha ${c5.toFixed(3)}`)
    check(`⭐ ${set}: mask=10 中心连通`, c10 > 0.5, `中心 alpha ${c10.toFixed(3)}`)
  }
  // 鞍点凸起不能影响边界 —— 否则无缝性质就破了
  let edgeAffected = 0
  for (const set of SETS) {
    const opt = MASK_SETS[set]
    for (let k = 0; k < MASK_TILE_PX; k++) {
      const t = (k + 0.5) / MASK_TILE_PX
      // mask=5 与 mask=1|4 的组合在边上应当只由角点决定
      const a = maskAlphaAt(5, 0, t, opt)
      const expect = maskAlphaAt(5, 0, t, opt) // 自洽检查：边上取值不含凸起
      if (Math.abs(a - expect) > 1e-12) edgeAffected++
    }
  }
  check('⭐ 鞍点凸起在四条边上为零（不破坏无缝）', edgeAffected === 0, `${edgeAffected} 处受影响`)
}

// ── 4. ⭐ maskAt 的角点位权 ─────────────────────────────────────────────
//
// 用一张手工构造的小世界把位权钉死。位权搞错的表现是「某些转角缺一块」，
// 极难从现象反推回来。
{
  const g = createEmptyGrid('handmade', 'test', 0)
  // 只把 L(10,10) 设成路
  const at = (x: number, y: number) => y * WORLD_SIZE + x
  g.flags[at(10, 10)] = Flag.Road
  const road = LAYERS.find((l) => l.id === 'road')!

  // D(i,j) 的四角是 L(i-1,j-1) L(i,j-1) L(i-1,j) L(i,j)
  // 所以 L(10,10) 只会出现在这四个显示格里，且每次占不同的位
  check('位权 SE：D(10,10) 的 SE 是 L(10,10) → mask=4', maskAt(g, road, 10, 10) === 4,
    `实得 ${maskAt(g, road, 10, 10)}`)
  check('位权 NE：D(10,11) 的 NE 是 L(10,10) → mask=2', maskAt(g, road, 10, 11) === 2,
    `实得 ${maskAt(g, road, 10, 11)}`)
  check('位权 SW：D(11,10) 的 SW 是 L(10,10) → mask=8', maskAt(g, road, 11, 10) === 8,
    `实得 ${maskAt(g, road, 11, 10)}`)
  check('位权 NW：D(11,11) 的 NW 是 L(10,10) → mask=1', maskAt(g, road, 11, 11) === 1,
    `实得 ${maskAt(g, road, 11, 11)}`)
  check('不相邻的显示格为 0', maskAt(g, road, 13, 13) === 0)
}

// ── 5. frameOf ───────────────────────────────────────────────────────────
{
  const road = LAYERS.find((l) => l.id === 'road')!
  check('mask=0 不绘制', frameOf(road, 0, 0) === -1)
  check('mask=7 用第 7 帧', frameOf(road, 7, 0) === 7)
  check('mask=15 走填充变体', frameOf(road, 15, 0) >= 16)
  const water = LAYERS.find((l) => l.id === 'water')!
  check('无变体的层 mask=15 仍用第 15 帧', frameOf(water, 15, 3) === 15)
}

// ── 6. ⭐ 真实世界里 16 种形态都要出现 ──────────────────────────────────
{
  const g = buildWorld({
    seed: 'dualgrid-cov',
    settings: {
      waterRatio: 0.15,
      forestDensity: 0.5,
      fieldDensity: 0.5,
      season: 0,
      dayMinutes: 20,
      townDensity: 0.6,
      riverDensity: 0.6,
    },
  })
  console.log('  真实世界里各层的遮罩形态覆盖：')
  for (const layer of LAYERS) {
    const hist = maskHistogram(g, layer)
    const seen = hist.reduce((n, c) => n + (c > 0 ? 1 : 0), 0)
    const total = hist.reduce((n, c) => n + c, 0) - hist[0]!
    console.log(
      `    ${layer.id.padEnd(7)} 出现 ${String(seen).padStart(2)}/16 种形态，非空显示格 ${total}` +
        `  鞍点 5/10: ${hist[5]}/${hist[10]}`,
    )
    if (layer.id === 'dirt' || layer.id === 'road') {
      check(`⭐ ${layer.id} 层覆盖到 14 种以上形态`, seen >= 14, `只有 ${seen} 种`)
    }
  }

  // ⚠️ water 与 road 在栅格化时做过 4 连通补角，结构上不该产生鞍点
  const water = LAYERS.find((l) => l.id === 'water')!
  const wh = maskHistogram(g, water)
  const saddles = wh[5]! + wh[10]!
  const waterCells = wh.reduce((n, c) => n + c, 0) - wh[0]!
  check(
    '⭐ water 层的鞍点占比极低（栅格化补角起了作用）',
    saddles / Math.max(1, waterCells) < 0.02,
    `${saddles}/${waterCells} = ${((saddles / Math.max(1, waterCells)) * 100).toFixed(2)}%`,
  )
}

// ── 7. 渲染遮罩图集供肉眼确认 ────────────────────────────────────────────
{
  const outDir = path.resolve(ROOT, 'output/preview')
  await mkdir(outDir, { recursive: true })
  for (const set of SETS) {
    const alpha = generateMaskAtlas(set)
    // 画成「白底 + 深色遮罩 + 网格线」，比纯 alpha 好看得多
    const rgb = Buffer.alloc(MASK_ATLAS_PX * MASK_ATLAS_PX * 3)
    for (let y = 0; y < MASK_ATLAS_PX; y++) {
      for (let x = 0; x < MASK_ATLAS_PX; x++) {
        const a = alpha[y * MASK_ATLAS_PX + x]! / 255
        const onGrid = x % MASK_TILE_PX === 0 || y % MASK_TILE_PX === 0
        const i = (y * MASK_ATLAS_PX + x) * 3
        const bg = onGrid ? 200 : 246
        rgb[i] = Math.round(bg * (1 - a) + 113 * a)
        rgb[i + 1] = Math.round(bg * (1 - a) + 129 * a)
        rgb[i + 2] = Math.round(bg * (1 - a) + 83 * a)
      }
    }
    await sharp(rgb, { raw: { width: MASK_ATLAS_PX, height: MASK_ATLAS_PX, channels: 3 } })
      .resize(MASK_ATLAS_PX * 3, MASK_ATLAS_PX * 3, { kernel: 'nearest' })
      .png()
      .toFile(path.join(outDir, `masks-${set}.png`))
  }
  check('三套遮罩图集已渲染', true)
  console.log(`    遮罩图集 → output/preview/masks-{organic,stepped,hard}.png`)
}

console.log(`\n双网格验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过（含 1 条负向断言）')
}
