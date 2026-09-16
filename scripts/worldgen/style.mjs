/**
 * 风格母版生成与迭代。
 *
 * 母版一旦定稿，会作为 Image 3 喂给后续每一张素材 —— 它是整套美术的锚点。
 *
 * ⚠️ 迭代规则：每次只改 lib/prompt.mjs 里的**一段**。一次改多段就学不到
 * 是哪一段起了作用，而每张候选 $0.09（实测 n 是成本乘数，不是免费候选）。
 *
 * 用法：
 *   node scripts/worldgen/style.mjs            # 出 2 张候选
 *   node scripts/worldgen/style.mjs --n 1
 *   node scripts/worldgen/style.mjs --refs with-master   # 把已定稿母版也作为参考图
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCredentials, maskKey } from './lib/credentials.mjs'
import { generateImage, getUsageCents } from './lib/client.mjs'
import { buildPrompt, PROMPT_VERSION } from './lib/prompt.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const OUT_DIR = path.join(ROOT, 'output', 'imagegen', 'world-v2', 'raw')

/**
 * ⚠️ 只用用户的两张原始参考图。
 *
 * world-v1 的 00-style.png 被**刻意排除**：它自己的木屋也是带偏航角的 3/4 视角，
 * 把它作为参考图会继续把「建筑倾斜」这个缺陷传下去 —— 那正是这一轮要修的东西。
 * 等新母版定稿后，它才会作为 Image 3 进入后续素材的参考图列表。
 */
const REFERENCES = [
  'C:/Users/25925/Downloads/sjt.png',
  'C:/Users/25925/Downloads/ScreenShot_2026-09-15_092055_282.png',
]

const APPROVED_MASTER = path.join(OUT_DIR, '00-style-master.approved.png')

const MODEL = 'gpt-image-2.5-flare'
const SIZE = '1408x704'

const PROMPT = buildPrompt({
  assetType:
    'visual style calibration master for a playable hand-painted 2D pastoral life-simulation game. Every later asset sheet will be matched against this image.',
  lighting: 'scene',
  primary: `a finished in-game scene of a small welcoming timber cottage, a winding ochre dirt path, three blue-green birch trees with scalloped leaf clusters, scattered tiny cream and peach flowers, a ferny river bank and a small wooden footbridge. A small brown-haired traveler in a sage-green outfit stands on the path.

The cottage sits in the upper right and is seen FRONT-ON exactly as described in the Viewpoint section: its front wall runs parallel to the bottom edge of the image, its door is centred in that front wall, its roof ridge is horizontal, and no side wall of it is visible. The footbridge crosses the river on the left and its planks run horizontally across the image. Broad open walking space through the centre, detailed vegetation around the edges.`,
})

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
  const n = argv.n ? Number(argv.n) : 2

  const { apiKey, baseUrl } = resolveCredentials(argv)

  const refPaths = [...REFERENCES]
  if (argv.refs === 'with-master' && existsSync(APPROVED_MASTER)) refPaths.push(APPROVED_MASTER)

  const refs = []
  for (const p of refPaths) {
    if (!existsSync(p)) {
      console.warn(`⚠️  参考图不存在，跳过：${p}`)
      continue
    }
    refs.push({ name: path.basename(p), bytes: await readFile(p) })
  }
  if (refs.length === 0) throw new Error('一张参考图都没读到 —— 没有参考图锁不住风格，不值得花这次钱。')

  console.log(`model      : ${MODEL}`)
  console.log(`key        : ${maskKey(apiKey)}`)
  console.log(`size       : ${SIZE}   n: ${n}   promptVersion: ${PROMPT_VERSION}`)
  console.log(`refs       : ${refs.map((r) => r.name).join(', ')}`)
  console.log(`预计花费   : ${n} × $0.09 = $${(n * 0.09).toFixed(2)}`)

  await mkdir(OUT_DIR, { recursive: true })

  const before = await getUsageCents({ apiKey, baseUrl })
  console.log(`\n账单(前)   : $${(before / 100).toFixed(2)}`)
  console.log('正在生成…（n=4 时实测约 98 秒）\n')

  const t0 = Date.now()
  const result = await generateImage({
    apiKey,
    baseUrl,
    model: MODEL,
    prompt: PROMPT,
    size: SIZE,
    n,
    refs,
  })
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  const after = await getUsageCents({ apiKey, baseUrl })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const files = []
  for (let i = 0; i < result.images.length; i++) {
    const file = path.join(OUT_DIR, `00-style-master.v${PROMPT_VERSION}.${stamp}.${i}.png`)
    await writeFile(file, result.images[i].bytes)
    files.push(path.relative(ROOT, file))
  }

  await writeFile(path.join(OUT_DIR, `00-style-master.v${PROMPT_VERSION}.prompt.txt`), PROMPT, 'utf8')

  console.log('─'.repeat(64))
  console.log(`耗时       : ${elapsed}s（尝试 ${result.attempts} 次）`)
  console.log(`返回       : ${result.images.length} 张 ${result.images.map((i) => `${i.header.width}x${i.header.height}`).join(', ')}`)
  console.log(`本次花费   : $${((after - before) / 100).toFixed(2)}   累计: $${(after / 100).toFixed(2)}`)
  console.log('─'.repeat(64))
  for (const f of files) console.log(`  ${f}`)
  console.log(`\n定稿后执行： cp "<选中的图>" "${path.relative(ROOT, APPROVED_MASTER)}"`)
}

main().catch((err) => {
  console.error(`\n❌ ${err.message}`)
  if (err.billed) console.error('⚠️  这次失败已经计费了。')
  process.exitCode = 1
})
