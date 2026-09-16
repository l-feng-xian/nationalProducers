/**
 * 城镇规划验证。
 *
 * 跑法： npm run verify:settlement
 *
 * 核心命题：
 *  1. **零存储**：同 (seed, 噪声场) 任何时候算都是同一结果
 *  2. **回绕后一致**：跨接缝的镇不会被切成两半或算出两遍
 *  3. **布局有结构**：广场 + 向外延伸的街巷 + 沿街错落的建筑（大小与层数都有变化）
 *
 * ⚠️ 旧版有一条「两栋房必然不相邻」的结构保证（3×3 严格极大值法）。
 * 那条**已按设计废除** —— 新布局是日式 RPG 的沿街排屋，相邻本来就是对的。
 * 现在保证的是「占地互不重叠、不压街」。
 */

import { planTowns, stampTowns, townAt, type Town } from '@/services/infinite-world/generation/settlement'
import { buildHydrology } from '@/services/infinite-world/generation/hydrology'
import { bakeElevation, createFields } from '@/services/infinite-world/generation/fields'
import { WORLD_SIZE, REGION } from '@/services/infinite-world/core/constants'
import { torusDist, wrapTile } from '@/services/infinite-world/core/torus'


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

function build(seed: string, townDensity = 0.5, fieldDensity = 0.5) {
  const fields = createFields({ seed })
  const baked = bakeElevation(fields, 0.15)
  const h = buildHydrology({
    elevation: baked.elevation,
    seaLevel: baked.seaLevel,
    fields,
    riverDensity: 0.5,
  })
  const t0 = performance.now()
  const towns = planTowns({
    seed,
    fields,
    elevation: baked.elevation,
    water: h.water,
    marsh: h.marsh,
    townDensity,
    fieldDensity,
  })
  return { fields, baked, h, towns, ms: performance.now() - t0 }
}

function townSignature(towns: Town[]): string {
  return towns
    .map(
      (t) =>
        `${t.id}@${t.cx},${t.cy},r${t.radius},${t.name},p${t.plaza.length},P${t.paths.length},` +
        `b${t.buildings.map((x) => `${x.x}:${x.y}:${x.w}x${x.h}:${x.facing}:${x.storeys}:${x.kind}`).join('|')},` +
        `f${t.fields.length},g${t.gates.join('_')}`,
    )
    .join(';')
}

// ── 1. ⭐ 零存储 = 逐位可复现 ────────────────────────────────────────────
{
  const a = build('repro-town')
  const b = build('repro-town')
  check('⭐ 同种子逐位可复现（零存储的前提）', townSignature(a.towns) === townSignature(b.towns))
  check('不同种子产出不同城镇', townSignature(a.towns) !== townSignature(build('other-town').towns))
  console.log(`    ${a.towns.length} 个镇，规划耗时 ${a.ms.toFixed(0)}ms`)
}

// ── 2. ⭐ 建筑互不重叠、不压街不压广场 ──────────────────────────────────
//
// ⚠️ 「两栋房必然不相邻」这条旧保证**已按设计废除**：
// 新布局是日式 RPG 的沿街排屋，相邻本来就是对的。
// 现在真正要保证的是：占地互不重叠、不盖在街上或广场上。
{
  console.log('  各种子的建筑占位检查：')
  let totalB = 0
  let overlaps = 0
  let onStreet = 0
  for (const seed of ['h1', 'h2', 'h3', 'h4', 'h5']) {
    const { towns } = build(seed)
    for (const t of towns) {
      const street = new Set<number>()
      for (let i = 0; i < t.paths.length; i += 2) street.add(t.paths[i + 1]! * WORLD_SIZE + t.paths[i]!)
      for (let i = 0; i < t.plaza.length; i += 2) street.add(t.plaza[i + 1]! * WORLD_SIZE + t.plaza[i]!)
      const used = new Set<number>()
      for (const bl of t.buildings) {
        if (bl.kind === 'well') continue // 井就在广场中央，是特例
        totalB++
        for (let yy = 0; yy < bl.h; yy++) {
          for (let xx = 0; xx < bl.w; xx++) {
            const i = wrapTile(bl.y + yy) * WORLD_SIZE + wrapTile(bl.x + xx)
            if (used.has(i)) overlaps++
            used.add(i)
            if (street.has(i)) onStreet++
          }
        }
      }
    }
  }
  check('⭐ 建筑占地互不重叠', overlaps === 0, `${overlaps} 格重叠，共 ${totalB} 栋`)
  check('⭐ 建筑不压在街巷或广场上', onStreet === 0, `${onStreet} 格压街`)
  console.log(`    共 ${totalB} 栋建筑，重叠 ${overlaps} 格，压街 ${onStreet} 格`)
}

// ── 2b. ⭐ 日式 RPG 布局的三个结构特征 ─────────────────────────────────
{
  let noPlaza = 0
  let noWell = 0
  let noLanes = 0
  let flatSkyline = 0
  let uniformSize = 0
  let towncount = 0
  const laneReach: number[] = []

  for (const seed of ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']) {
    const { towns } = build(seed)
    for (const t of towns) {
      towncount++
      if (t.plaza.length < 25 * 2) noPlaza++
      if (!t.buildings.some((b) => b.kind === 'well')) noWell++

      // 街巷必须真的向外延伸，而不是在广场边打转
      let far = 0
      for (let i = 0; i < t.paths.length; i += 2) {
        far = Math.max(far, Math.sqrt(torusDist(t.paths[i]!, t.paths[i + 1]!, t.cx, t.cy) ** 2))
      }
      laneReach.push(far)
      if (far < t.radius * 0.5) noLanes++

      const real = t.buildings.filter((b) => b.kind !== 'well')
      if (real.length >= 6) {
        // 高低错落：楼层不能全是同一档
        if (new Set(real.map((b) => b.storeys)).size < 2) flatSkyline++
        // 大小错落：占地不能全一样
        if (new Set(real.map((b) => `${b.w}x${b.h}`)).size < 2) uniformSize++
      }
    }
  }

  check('⭐ 每个镇都有广场', noPlaza === 0, `${noPlaza}/${towncount} 个镇广场过小`)
  check('⭐ 每个镇广场中央都有井', noWell === 0, `${noWell}/${towncount} 个镇没有井`)
  check('⭐ 街巷真的向外延伸（不是在广场边打转）', noLanes <= towncount * 0.15,
    `${noLanes}/${towncount} 个镇的街没走出半径的一半`)
  check('⭐⭐ 天际线高低错落（楼层不止一档）', flatSkyline === 0, `${flatSkyline} 个镇楼层全同`)
  check('⭐⭐ 建筑大小错落（占地不止一种）', uniformSize === 0, `${uniformSize} 个镇建筑全一样大`)
  const avgReach = laneReach.reduce((x, y) => x + y, 0) / Math.max(1, laneReach.length)
  console.log(`    ${towncount} 个镇：街巷平均延伸 ${avgReach.toFixed(1)} 格`)
}

// ── 3. ⭐ 回绕一致性：跨接缝的镇 ─────────────────────────────────────────
{
  const { towns } = build('seam-town')
  // 所有坐标都必须已回绕
  let outOfRange = 0
  for (const t of towns) {
    if (t.cx < 0 || t.cx >= WORLD_SIZE || t.cy < 0 || t.cy >= WORLD_SIZE) outOfRange++
    for (const arr of [t.plaza, t.paths, t.fields, t.gates]) {
      for (let i = 0; i < arr.length; i++) if (arr[i]! < 0 || arr[i]! >= WORLD_SIZE) outOfRange++
    }
    for (const b2 of t.buildings) {
      if (b2.x < 0 || b2.x >= WORLD_SIZE || b2.y < 0 || b2.y >= WORLD_SIZE) outOfRange++
    }
  }
  check('⭐ 所有城镇坐标都已回绕进 [0,512)', outOfRange === 0, `${outOfRange} 个越界`)

  // 区域网格必须在环面上闭合
  check('REGION 整除 WORLD_SIZE', WORLD_SIZE % REGION === 0, `${WORLD_SIZE} % ${REGION} != 0`)

  // ⚠️ 「接缝处有没有被系统性跳过」必须**跨种子**测。
  // 单个种子只有 6-14 个镇，恰好没有镇落在接缝附近完全正常 ——
  // 拿单种子断言等于在测运气。扫 30 个种子，只要有镇落在接缝带上就说明没被跳过。
  let seamTowns = 0
  let crossedFacilities = 0
  let scanned = 0
  for (let s = 0; s < 30; s++) {
    const { towns: ts } = build(`seam-${s}`)
    scanned += ts.length
    for (const t of ts) {
      if (t.cx >= 12 && t.cx <= WORLD_SIZE - 12 && t.cy >= 12 && t.cy <= WORLD_SIZE - 12) continue
      seamTowns++
      // 设施应当横跨接缝而不是被截断
      for (let i = 0; i < t.paths.length; i += 2) {
        if (Math.abs(t.paths[i]! - t.cx) > WORLD_SIZE / 2) {
          crossedFacilities++
          break
        }
      }
    }
  }
  // 接缝带（四边各 12 格）约占全图 18%，30 个种子约 300 个镇，
  // 若接缝被跳过这里会是 0
  check('⭐ 接缝带上确实会出现城镇（没被系统性跳过）', seamTowns > 5,
    `30 个种子 ${scanned} 个镇里只有 ${seamTowns} 个在接缝带`)
  console.log(`    30 种子共 ${scanned} 个镇，接缝带上 ${seamTowns} 个，其中 ${crossedFacilities} 个设施横跨接缝`)
}

// ── 4. 镇与镇不重叠 ──────────────────────────────────────────────────────
{
  let overlaps = 0
  for (const seed of ['o1', 'o2', 'o3']) {
    const { towns } = build(seed)
    for (let i = 0; i < towns.length; i++) {
      for (let j = i + 1; j < towns.length; j++) {
        const a = towns[i]!
        const b = towns[j]!
        if (torusDist(a.cx, a.cy, b.cx, b.cy) < a.radius + b.radius) overlaps++
      }
    }
  }
  check('⭐ 镇与镇的影响圈不重叠', overlaps === 0, `${overlaps} 对重叠`)
}

// ── 5. 城镇只落在干燥平坦处 ──────────────────────────────────────────────
{
  const { towns, h } = build('dry-town')
  let wet = 0
  let total = 0
  for (const t of towns) {
    for (const b of t.buildings) {
      for (let yy = 0; yy < b.h; yy++) {
        for (let xx = 0; xx < b.w; xx++) {
          total++
          const i = wrapTile(b.y + yy) * WORLD_SIZE + wrapTile(b.x + xx)
          if (h.water[i] !== 0 || h.marsh[i] !== 0) wet++
        }
      }
    }
  }
  check('⭐ 建筑不落在水里或湿地上', wet === 0, `${wet}/${total} 格在水里`)
}

// ── 6. townDensity 的语义 ────────────────────────────────────────────────
{
  console.log('  townDensity → 镇数：')
  const counts: number[] = []
  for (const td of [0.1, 0.5, 0.9]) {
    const { towns } = build('density-town', td)
    counts.push(towns.length)
    console.log(`    townDensity=${td}  →  ${towns.length} 个镇`)
  }
  check('⭐ townDensity 单调增加镇数', counts[0]! < counts[1]! && counts[1]! <= counts[2]!,
    `实测 ${counts.join(' / ')}`)
}

// ── 7. townAt 与 stampTowns ──────────────────────────────────────────────
{
  const { towns } = build('at-town')
  if (towns.length > 0) {
    const t = towns[0]!
    check('townAt 认得出镇心', townAt(towns, t.cx, t.cy)?.id === t.id)
    check('townAt 在镇外返回 null', townAt(towns, wrapTile(t.cx + t.radius + 30), t.cy) === null ||
      townAt(towns, wrapTile(t.cx + t.radius + 30), t.cy)!.id !== t.id)
  }
  const { town, farm } = stampTowns(towns)
  let townCells = 0
  let farmCells = 0
  for (let i = 0; i < N; i++) {
    if (town[i]) townCells++
    if (farm[i]) farmCells++
  }
  check('stampTowns 产出非空掩码', townCells > 0 && farmCells > 0, `town ${townCells} farm ${farmCells}`)
  console.log(`    ${towns.length} 个镇：town 掩码 ${townCells} 格，farm 掩码 ${farmCells} 格`)
}

// ── 8. 每个镇的结构完整性 ────────────────────────────────────────────────
{
  const { towns } = build('struct-town')
  let noB = 0
  let noPaths = 0
  let noGates = 0
  for (const t of towns) {
    if (t.buildings.filter((b) => b.kind !== 'well').length < 4) noB++
    if (t.paths.length === 0) noPaths++
    if (t.gates.length < 2) noGates++
  }
  check('每个镇至少 4 栋建筑', noB === 0, `${noB}/${towns.length} 个镇建筑太少`)
  check('每个镇都有街巷', noPaths === 0, `${noPaths}/${towns.length} 个镇没有街`)
  check('每个镇至少 2 个道路接入点', noGates === 0, `${noGates}/${towns.length} 个镇接入点不足`)

  const avgB = towns.reduce((s2, t) => s2 + t.buildings.length, 0) / Math.max(1, towns.length)
  check('平均每镇 5-60 栋建筑', avgB >= 5 && avgB <= 60, `平均 ${avgB.toFixed(1)} 栋`)
  console.log(`    平均每镇 ${avgB.toFixed(1)} 栋建筑`)
}

console.log(`\n城镇规划验证：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('')
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exitCode = 1
} else {
  console.log('✓ 全部通过')
}
