/**
 * 把生成结果渲染成 PNG，用肉眼验收。
 *
 * 跑法： npm run preview:world -- --seed abc,def
 *
 * ## 为什么必须有这一步
 * 断言能证明「河流贯通」「建筑不重叠」「场不相关」，但证明不了
 * **整张图看起来像个世界**。这一步已经抓到过三个断言完全测不出来的问题：
 * 满屏圆形池塘（湖阈值太松）、路笔直如尺画（直线+摆动而非代价场 A*）、
 * 65 个镇的城市群（按「地图上看着多不多」而非「玩家步行时间」标定）。
 *
 * ⚠️ 本脚本**走 pipeline 的真实路径**（buildWorld），不自己串各层。
 * 手工串联的预览会和游戏实际跑的代码悄悄分叉 —— 那样预览就失去意义了。
 */

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { auditConnectivity, buildWorld } from '@/services/infinite-world/generation/pipeline'
import {
  Decor,
  Flag,
  Surface,
  gridByteLength,
  type WorldGrid,
} from '@/services/infinite-world/generation/grid'
import { WORLD_SIZE } from '@/services/infinite-world/core/constants'
import { BIOMES } from '@/types/infiniteWorld'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 手绘风调色板，与素材管线同源 */
const SURFACE_COLOR: Record<number, readonly [number, number, number]> = {
  [Surface.Grass]: [148, 166, 109],
  [Surface.Dirt]: [201, 143, 93],
  [Surface.Sand]: [214, 196, 150],
  [Surface.Marsh]: [110, 124, 92],
  [Surface.ShallowWater]: [121, 158, 158],
  [Surface.DeepWater]: [95, 135, 144],
  [Surface.Cobble]: [176, 160, 132],
  [Surface.Tilled]: [190, 158, 106],
  [Surface.ForestFloor]: [104, 122, 82],
}

const DECOR_COLOR: Record<number, readonly [number, number, number]> = {
  [Decor.TreeBroad]: [76, 100, 68],
  [Decor.TreeConifer]: [58, 84, 62],
  [Decor.TreeBirch]: [96, 122, 86],
  [Decor.Bush]: [100, 118, 76],
  [Decor.Rock]: [140, 138, 130],
  [Decor.Flower]: [212, 196, 168],
  [Decor.TallGrass]: [132, 152, 96],
  [Decor.Reed]: [122, 134, 88],
  [Decor.Stump]: [118, 92, 62],
  [Decor.Mushroom]: [170, 138, 120],
  [Decor.LilyPad]: [108, 146, 130],
}

const BUILDING_COLOR: readonly (readonly [number, number, number])[] = [
  [150, 104, 62],
  [120, 82, 48],
  [92, 62, 36],
]

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v && !v.startsWith('--')) {
      out[k] = v
      i++
    } else out[k] = 'true'
  }
  return out
}

function paint(grid: WorldGrid): Buffer {
  const N = WORLD_SIZE * WORLD_SIZE
  const px = Buffer.alloc(N * 3)

  // 建筑层数查表
  const storey = new Uint8Array(N)
  for (const t of grid.towns) {
    for (const b of t.buildings) {
      if (b.kind === 'well') continue
      for (let yy = 0; yy < b.h; yy++) {
        for (let xx = 0; xx < b.w; xx++) {
          storey[((b.y + yy) % WORLD_SIZE) * WORLD_SIZE + ((b.x + xx) % WORLD_SIZE)] = b.storeys
        }
      }
    }
  }

  for (let i = 0; i < N; i++) {
    let c = SURFACE_COLOR[grid.surface[i]!] ?? ([255, 0, 255] as const)
    const f = grid.flags[i]!
    if (f & Flag.Building) c = BUILDING_COLOR[Math.min(2, Math.max(0, storey[i]! - 1))]!
    else if (f & Flag.Bridge) c = [140, 96, 58] as const
    else {
      const d = grid.decor[i]!
      if (d !== Decor.None) c = DECOR_COLOR[d] ?? c
    }
    // 高度做轻微明暗，让地形起伏看得见
    const shade = 1 + (grid.elevation[i]! - grid.seaLevel) * 0.22
    px[i * 3] = clamp8(c[0] * shade)
    px[i * 3 + 1] = clamp8(c[1] * shade)
    px[i * 3 + 2] = clamp8(c[2] * shade)
  }

  // 水井
  for (const t of grid.towns) {
    for (const b of t.buildings) {
      if (b.kind !== 'well') continue
      const i = b.y * WORLD_SIZE + b.x
      px[i * 3] = 90
      px[i * 3 + 1] = 120
      px[i * 3 + 2] = 130
    }
  }
  // 出生点标红
  const [sx, sy] = grid.spawn
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const i =
        ((sy + dy + WORLD_SIZE) % WORLD_SIZE) * WORLD_SIZE + ((sx + dx + WORLD_SIZE) % WORLD_SIZE)
      px[i * 3] = 220
      px[i * 3 + 1] = 70
      px[i * 3 + 2] = 60
    }
  }
  return px
}

async function main() {
  const argv = parseArgs(process.argv)
  const seeds = (argv.seed ?? 'alpha,beta,gamma').split(',')
  const outDir = path.resolve(ROOT, argv.out ?? 'output/preview')
  const scale = Number(argv.scale ?? 2)
  await mkdir(outDir, { recursive: true })

  for (const seed of seeds) {
    const t0 = performance.now()
    const grid = buildWorld({
      seed,
      settings: {
        waterRatio: Number(argv.water ?? 0.15),
        forestDensity: Number(argv.forest ?? 0.5),
        fieldDensity: 0.5,
        season: 0,
        dayMinutes: 20,
        townDensity: Number(argv.towns ?? 0.5),
        riverDensity: Number(argv.rivers ?? 0.5),
      },
    })
    const ms = performance.now() - t0
    const px = paint(grid)

    // ── 城镇特写 ──
    // 全图 512 下一个镇只有几十像素，看不出布局。裁一块放大单独存一张。
    if (grid.towns.length > 0 && argv.closeup !== 'false') {
      const t = grid.towns.reduce((best, cur) =>
        cur.buildings.length > best.buildings.length ? cur : best,
      )
      const R = 24
      const side = R * 2 + 1
      const crop = Buffer.alloc(side * side * 3)
      for (let yy = 0; yy < side; yy++) {
        for (let xx = 0; xx < side; xx++) {
          const sxp = (((t.cx - R + xx) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
          const syp = (((t.cy - R + yy) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
          const src = (syp * WORLD_SIZE + sxp) * 3
          const dst = (yy * side + xx) * 3
          crop[dst] = px[src]!
          crop[dst + 1] = px[src + 1]!
          crop[dst + 2] = px[src + 2]!
        }
      }
      await sharp(crop, { raw: { width: side, height: side, channels: 3 } })
        .resize(side * 14, side * 14, { kernel: 'nearest' })
        .png()
        .toFile(path.join(outDir, `town-${seed}.png`))
      console.log(`  特写 ${t.name}(${t.cx},${t.cy}) r${t.radius} ${t.buildings.length} 栋`)
    }

    const file = path.join(outDir, `world-${seed}.png`)
    await sharp(px, { raw: { width: WORLD_SIZE, height: WORLD_SIZE, channels: 3 } })
      .resize(WORLD_SIZE * scale, WORLD_SIZE * scale, { kernel: 'nearest' })
      .png()
      .toFile(file)

    // ── 统计 ──
    const N = WORLD_SIZE * WORLD_SIZE
    const bio: Record<string, number> = {}
    let walkable = 0
    let decorCells = 0
    for (let i = 0; i < N; i++) {
      const b = BIOMES[grid.biome[i]!] ?? '?'
      bio[b] = (bio[b] ?? 0) + 1
      if (grid.flags[i]! & Flag.Walkable) walkable++
      if (grid.decor[i]) decorCells++
    }
    const pct = (n: number) => ((n / N) * 100).toFixed(1) + '%'
    const audit = auditConnectivity(grid)

    console.log(
      `\n${seed}  （${ms.toFixed(0)}ms，${(gridByteLength(grid) / 1048576).toFixed(2)} MB）  → ${path.relative(ROOT, file)}`,
    )
    console.log(`  生态  ` + BIOMES.map((b) => `${b} ${pct(bio[b] ?? 0)}`).join('  '))
    console.log(
      `  可行走 ${pct(walkable)}  装饰 ${pct(decorCells)}  ` +
        `镇 ${grid.towns.length} 个 / ${grid.towns.reduce((s, t) => s + t.buildings.length, 0)} 栋  ` +
        `桥 ${grid.bridges.length} 座`,
    )
    console.log(
      `  连通域 ${audit.regionCount} 个，主域占可行走的 ${(audit.mainShare * 100).toFixed(1)}%  ` +
        `孤立镇 ${audit.strandedTowns.length ? audit.strandedTowns.join('/') : '无'}  ` +
        `出生点 (${grid.spawn[0]},${grid.spawn[1]})`,
    )
  }
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
