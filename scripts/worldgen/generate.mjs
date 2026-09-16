/**
 * 批量出图。
 *
 * 用法：
 *   npm run world:gen -- --dry-run            # 只打印 prompt 与预估成本，零调用
 *   npm run world:gen -- --group g1           # 只跑 G1 那两张
 *   npm run world:gen -- --only v01-trees-broad
 *   npm run world:gen -- --only v01-trees-broad --force   # 强制重出，旧候选保留
 *   npm run world:gen -- --budget 1.00        # 预算熔断（美元）
 *
 * ## 三道防线，按杠杆从大到小
 *   1. **prompt 进缓存键** —— 重跑脚本零花费。这是主防线
 *   2. **预算熔断** —— 默认 $1.00，按真实账单差值算，不是估的
 *   3. **--dry-run** —— 出图前先把 prompt 看一遍
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveCredentials, maskKey } from './lib/credentials.mjs'
import { generateImage, getUsageCents, ImageApiError } from './lib/client.mjs'
import { PROMPT_VERSION } from './lib/prompt.mjs'
import { Ledger, cacheKeyOf, sha256 } from './lib/ledger.mjs'
import { REFERENCE_FILES, SHEETS, sheetsInGroup, validateSheets } from './plan.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const OUT_DIR = path.join(ROOT, 'output', 'imagegen', 'world-v2')
const RAW_DIR = path.join(OUT_DIR, 'raw')
const MODEL = 'gpt-image-2.5-flare'
const PRICE_CENTS = 9

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const v = argv[i + 1]
    if (v && !v.startsWith('--')) {
      out[k] = v
      i++
    } else out[k] = true
  }
  return out
}

async function loadReferences() {
  const refs = []
  for (const rel of REFERENCE_FILES) {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel)
    if (!existsSync(abs)) {
      console.warn(`⚠️  参考图不存在，跳过：${abs}`)
      continue
    }
    const bytes = await readFile(abs)
    refs.push({ name: path.basename(abs), bytes, hash: sha256(bytes).slice(0, 12) })
  }
  return refs
}

async function main() {
  const argv = parseArgs(process.argv)

  // ── 出图前自检 ──
  const problems = validateSheets()
  if (problems.length) {
    console.error('素材清单有问题，先修掉再出图：')
    for (const p of problems) console.error('  ✗ ' + p)
    process.exitCode = 1
    return
  }

  let sheets = SHEETS
  if (argv.group) sheets = sheetsInGroup(String(argv.group))
  if (argv.only) sheets = sheets.filter((s) => String(argv.only).split(',').includes(s.id))
  if (sheets.length === 0) {
    console.error('没有匹配的图集')
    process.exitCode = 1
    return
  }

  const refs = await loadReferences()
  const refHashes = refs.map((r) => r.hash)
  const n = argv.n ? Number(argv.n) : 1
  const budgetCents = Math.round(Number(argv.budget ?? 1) * 100)

  await mkdir(RAW_DIR, { recursive: true })
  const ledger = await new Ledger(path.join(OUT_DIR, 'ledger.json')).load()

  // ── dry-run ──
  if (argv.dryRun) {
    let fresh = 0
    for (const s of sheets) {
      const key = cacheKeyOf({ model: MODEL, prompt: s.prompt, size: s.size, n, refHashes, promptVersion: PROMPT_VERSION })
      const hit = ledger.isFresh(s.id, key, ROOT)
      if (hit) fresh++
      console.log(`\n${'─'.repeat(70)}\n${s.id}  ${s.cols}×${s.rows} ${s.size} ${s.kind}  ${hit ? '【缓存命中，不会花钱】' : '【需要出图】'}`)
      console.log(s.prompt)
    }
    const need = sheets.length - fresh
    console.log(`\n${'─'.repeat(70)}`)
    console.log(`共 ${sheets.length} 张，缓存命中 ${fresh} 张，需出 ${need} 张`)
    console.log(`预估花费：${need} × ${n} × $0.0${PRICE_CENTS} = $${((need * n * PRICE_CENTS) / 100).toFixed(2)}`)
    return
  }

  const { apiKey, baseUrl } = resolveCredentials(argv)
  console.log(`model ${MODEL}  key ${maskKey(apiKey)}  refs ${refs.length} 张  n=${n}`)
  console.log(`预算上限 $${(budgetCents / 100).toFixed(2)}`)

  const startCents = await getUsageCents({ apiKey, baseUrl })
  ledger.data.usdAtStart = startCents
  console.log(`账单起点 $${(startCents / 100).toFixed(2)}\n`)

  let done = 0
  let skipped = 0
  for (const s of sheets) {
    const key = cacheKeyOf({ model: MODEL, prompt: s.prompt, size: s.size, n, refHashes, promptVersion: PROMPT_VERSION })

    if (!argv.force && ledger.isFresh(s.id, key, ROOT)) {
      skipped++
      console.log(`⏭  ${s.id}  缓存命中，跳过`)
      continue
    }

    // ── 预算熔断 ──
    const nowCents = await getUsageCents({ apiKey, baseUrl })
    if (nowCents - startCents + n * PRICE_CENTS > budgetCents) {
      console.error(
        `\n⛔ 预算熔断：已花 $${((nowCents - startCents) / 100).toFixed(2)}，` +
          `再出这张会超过上限 $${(budgetCents / 100).toFixed(2)}。用 --budget 调高再跑。`,
      )
      break
    }

    process.stdout.write(`▶  ${s.id}  生成中（单次 >25 秒）… `)
    const t0 = Date.now()
    try {
      const result = await generateImage({
        apiKey,
        baseUrl,
        model: MODEL,
        prompt: s.prompt,
        size: s.size,
        n,
        refs: refs.map((r) => ({ name: r.name, bytes: r.bytes })),
      })
      const afterCents = await getUsageCents({ apiKey, baseUrl })

      ledger.record(s.id, { cacheKey: key, status: 'generated', attempts: result.attempts })
      for (let i = 0; i < result.images.length; i++) {
        const im = result.images[i]
        const file = path.join(RAW_DIR, `${s.id}.${key}.${i}.png`)
        await writeFile(file, im.bytes)
        ledger.addCandidate(s.id, {
          // ⚠️ 候选必须自带它是哪个缓存键出的，`addCandidate` 靠它决定要不要改采纳
          cacheKey: key,
          file: path.relative(ROOT, file),
          usdBefore: nowCents,
          usdAfter: afterCents,
          width: im.header.width,
          height: im.header.height,
          colorType: im.header.colorType,
          revisedPrompt: result.revisedPrompt,
          at: new Date().toISOString(),
        })
      }
      await ledger.save()
      done++
      console.log(
        `✓ ${((Date.now() - t0) / 1000).toFixed(0)}s  ${result.images.length} 张  ` +
          `花费 $${((afterCents - nowCents) / 100).toFixed(2)}`,
      )
    } catch (e) {
      const billed = e instanceof ImageApiError && e.billed
      ledger.record(s.id, { cacheKey: key, status: 'failed', error: String(e?.message ?? e) })
      await ledger.save()
      console.log(`✗ ${e?.message ?? e}${billed ? '（⚠️ 这次失败已计费）' : '（未计费）'}`)
    }
  }

  const endCents = await getUsageCents({ apiKey, baseUrl })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`出图 ${done} 张，跳过 ${skipped} 张`)
  console.log(`本次花费 $${((endCents - startCents) / 100).toFixed(2)}   账单累计 $${(endCents / 100).toFixed(2)}`)
  console.log(`产物在 ${path.relative(ROOT, RAW_DIR)}，下一步： npm run world:slice`)
}

main().catch((e) => {
  console.error(`\n❌ ${e?.message ?? e}`)
  process.exitCode = 1
})
