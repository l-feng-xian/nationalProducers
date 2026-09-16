/**
 * G0 探测：一次调用同时回答两个问题，并顺带产出风格母版候选。
 *
 *   Q1（最关键）：`n:4` 是否仍按**一次请求**计费？
 *        计价表是 quota_type:1 / price_unit:"request"，如果 n 不是成本乘数，
 *        那么每张图都能出 4 个候选而成本不变 —— 迭代成本趋近于零，
 *        整个素材预算与迭代策略都要围绕它重写。
 *   Q2：非方形 size（1408x704）是否真的被接受？
 *        服务端不校验 size 且照样计费，所以只能实测。
 *
 * 参考图策略：把用户的两张参考图 + 已验收的 00-style.png 一起作为 STYLE REFERENCE
 * 喂给 /v1/images/edits，让 flare 的输出直接继承已验证的观感。
 *
 * 用法：
 *   node scripts/worldgen/probe.mjs
 *   node scripts/worldgen/probe.mjs --n 1          # 只出 1 张（对照组）
 *   node scripts/worldgen/probe.mjs --api-key sk-xxx
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCredentials, maskKey } from './lib/credentials.mjs'
import { generateImage, getUsageCents } from './lib/client.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const OUT_DIR = path.join(ROOT, 'output', 'imagegen', 'world-v2', 'raw')

const REFERENCES = [
  'C:/Users/25925/Downloads/sjt.png',
  'C:/Users/25925/Downloads/ScreenShot_2026-09-15_092055_282.png',
  path.join(ROOT, 'output', 'imagegen', 'world-v1', '00-style.png'),
]

const MODEL = 'gpt-image-2.5-flare'

const PROMPT = `Use case: stylized-concept
Asset type: visual style calibration master for a playable hand-painted 2D pastoral life-simulation game.

Input images: Image 1 is the reference for linework, trees, architecture and palette. Image 2 is the reference for grass strokes, flowers, wetland plants and water. Image 3 is the previously APPROVED master for this collection - match its line weight, shading density and palette most closely of all. The supplied images are STYLE REFERENCES ONLY. Do not edit, extend, outpaint, crop or reproduce their compositions. Produce an entirely NEW original scene.

Primary request: a finished in-game scene of a small welcoming timber cottage, a winding ochre dirt path, three blue-green birch trees with scalloped leaf clusters, scattered tiny cream and peach flowers, a ferny river bank and a small wooden footbridge. A small brown-haired traveler in a sage-green outfit stands on the path. Broad open walking space in the centre, detailed vegetation around the edges.

Style/medium: organic charcoal-olive hand-drawn outlines of consistent weight, flat soft gouache shading with restrained brush texture, delicate individually drawn tapered grass strokes, lobed blue-green foliage, creamy birch bark with dark markings, honey-colored wood planks with visible joinery. Cute proportions with a large expressive head and a small body. Fully drawn raster illustration; never pixel art, never polygonal 3D, never glossy plastic, never flat vector clip art.

Viewpoint: orthographic oblique overhead game camera roughly 62 degrees from the ground plane, looking at the fronts of buildings and characters. Square-axis walkable ground. NO diamond isometric grid, NO horizon, NO perspective convergence, NO vanishing point.

Lighting: gentle late-afternoon light from the upper left, soft long ground shadows toward the lower right; peaceful, tactile and inhabited.

Palette: olive grass #718153, moss #94a66d, ochre path #c98f5d, blue-green leaves #5f8790, honey timber #a87545, soft water #799e9e, outlines #3f5140, creamy light #f3ddb0. Muted warm pastoral palette, never oversaturated.

Constraints: no text, no labels, no lettering, no UI, no logos, no watermarks, no borders, no frame lines. Consistent line weight and detail density across all elements. This is the master style image that every later asset sheet will be matched against.`

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

async function main() {
  const argv = parseArgs(process.argv)
  const n = argv.n ? Number(argv.n) : 4
  const size = argv.size ?? '1408x704'

  const { apiKey, baseUrl } = resolveCredentials(argv)
  console.log(`endpoint : ${baseUrl}/v1/images/edits`)
  console.log(`key      : ${maskKey(apiKey)}`)
  console.log(`model    : ${MODEL}`)
  console.log(`n        : ${n}`)
  console.log(`size     : ${size}`)

  const refs = []
  for (const p of REFERENCES) {
    if (!existsSync(p)) {
      console.warn(`⚠️  参考图不存在，跳过：${p}`)
      continue
    }
    refs.push({ name: path.basename(p), bytes: await readFile(p) })
  }
  console.log(`refs     : ${refs.length} 张 (${refs.map((r) => r.name).join(', ')})`)

  if (refs.length === 0) {
    throw new Error('一张参考图都没读到，放弃 —— 没有参考图就锁不住风格，不值得花这次钱。')
  }

  await mkdir(OUT_DIR, { recursive: true })

  const before = await getUsageCents({ apiKey, baseUrl })
  console.log(`\n账单(前) : ${before} 分 = $${(before / 100).toFixed(2)}`)
  console.log('正在生成…（单次 >25 秒，约 30% 概率连接失败后自动重试）\n')

  const t0 = Date.now()
  const result = await generateImage({ apiKey, baseUrl, model: MODEL, prompt: PROMPT, size, n, refs })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

  const after = await getUsageCents({ apiKey, baseUrl })
  const spent = after - before

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const files = []
  for (let i = 0; i < result.images.length; i++) {
    const im = result.images[i]
    const file = path.join(OUT_DIR, `00-style-master.${stamp}.${i}.png`)
    await writeFile(file, im.bytes)
    files.push(path.relative(ROOT, file))
  }

  const report = {
    at: new Date().toISOString(),
    model: MODEL,
    size,
    nRequested: n,
    nReturned: result.images.length,
    attempts: result.attempts,
    elapsedSeconds: Number(elapsed),
    usageCentsBefore: before,
    usageCentsAfter: after,
    spentCents: spent,
    costPerImageCents: result.images.length > 0 ? spent / result.images.length : null,
    nIsCostMultiplier: spent > 10,
    returnedDimensions: result.images.map((im) => `${im.header.width}x${im.header.height}`),
    colorType: result.images[0]?.header.colorType ?? null,
    revisedPrompt: result.revisedPrompt,
    files,
  }
  await writeFile(
    path.join(OUT_DIR, '..', 'probe-report.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  )

  console.log('─'.repeat(64))
  console.log(`耗时      : ${elapsed}s（尝试 ${result.attempts} 次）`)
  console.log(`返回图数  : ${result.images.length} / 请求 ${n}`)
  console.log(`返回尺寸  : ${report.returnedDimensions.join(', ')}`)
  console.log(`PNG色彩型 : ${report.colorType}  ${report.colorType === 2 ? '(RGB 无 alpha → 洋红抠像是必须的)' : '(含 alpha!)'}`)
  console.log(`账单(后)  : ${after} 分 = $${(after / 100).toFixed(2)}`)
  console.log(`本次花费  : ${spent} 分 = $${(spent / 100).toFixed(2)}`)
  console.log('─'.repeat(64))
  console.log('')
  console.log(`Q1  n 是否为成本乘数？  →  ${report.nIsCostMultiplier ? '是（n 张 = n 次计费）' : '否（n 张 = 一次计费）'}`)
  if (!report.nIsCostMultiplier && result.images.length > 1) {
    console.log(`    ✅ 每张图可免费出 ${result.images.length} 个候选 —— 迭代成本趋近于零`)
  }
  console.log(`Q2  非方形 ${size} 可用？  →  ${report.returnedDimensions.every((d) => d === size) ? '是' : '否（被吸附）'}`)
  console.log('')
  console.log('候选图：')
  for (const f of files) console.log(`  ${f}`)
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`)
  if (err.billed) console.error('⚠️  这次失败**已经计费**了。')
  process.exitCode = 1
})
