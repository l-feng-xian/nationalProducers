/**
 * 素材管线自检。零网络、零花费、秒级。
 *
 * ## 为什么值得单独写一个
 * 这条管线的错误几乎都是**静默且要花钱的**：账本指错候选、清单格数对不上、
 * 抠像把好 alpha 抹平。它们都不会抛异常，只会让产物悄悄不对，
 * 而每次重试是 $0.09。
 *
 * ## 每条断言都配一条「反向断言」
 * 只写正向断言证明不了这个测试有鉴别力 —— 一个永远为真的断言也能全绿。
 * 所以每条都跟着一条「故意按旧的错误写法做一遍，断言必须变红」。
 *
 *   node scripts/worldgen/selftest.mjs
 */

import { Ledger, cacheKeyOf } from './lib/ledger.mjs'
import { chromaKey, hasRealAlpha, alphaBBox, magentaResidue } from './lib/chroma.mjs'
import { validateSheets, SHEETS } from './plan.mjs'

let pass = 0
const fails = []

function ok(name, cond) {
  if (cond) pass++
  else fails.push(name)
}

/** 反向断言：`fn` 描述的是**旧的错误做法**，它必须失败 */
function mustFail(name, cond) {
  if (cond) fails.push(`反向断言没变红：${name}（测试没有鉴别力）`)
  else pass++
}

// ── 1. 账本：新键出的图必须被自动采纳 ──
{
  const led = new Ledger('/dev/null')
  led.record('t', { cacheKey: 'AAA', status: 'generated' })
  led.addCandidate('t', { cacheKey: 'AAA', file: 'a.png' })
  ok('首个候选被采纳', led.picked('t').file === 'a.png')

  // 同一个键再出一张（--n 或重试）：人工挑图的选择不该被覆盖
  led.addCandidate('t', { cacheKey: 'AAA', file: 'a2.png' })
  ok('同键追加不改采纳', led.picked('t').file === 'a.png')

  // 改了 prompt → 新键。这里曾经是那个会静默烧钱的 bug：picked 留在旧图上
  led.record('t', { cacheKey: 'BBB' })
  led.addCandidate('t', { cacheKey: 'BBB', file: 'b.png' })
  ok('换键后自动采纳新图', led.picked('t').file === 'b.png')

  // 反向断言：旧写法是 `picked = picked ?? 0`，永远停在 0
  const oldWay = (job, cand) => {
    job.candidates.push(cand)
    job.picked = job.picked ?? 0
  }
  const job = { candidates: [{ cacheKey: 'AAA', file: 'a.png' }], picked: 0 }
  oldWay(job, { cacheKey: 'BBB', file: 'b.png' })
  mustFail('旧写法换键后仍指向新图', job.candidates[job.picked].file === 'b.png')
}

// ── 2. 缓存键：prompt 改一个字就必须换键 ──
{
  const base = { model: 'm', prompt: 'hello', size: '1024x1024', n: 1, refHashes: ['x'], promptVersion: 2 }
  ok('同输入同键', cacheKeyOf(base) === cacheKeyOf({ ...base }))
  ok('prompt 变则键变', cacheKeyOf(base) !== cacheKeyOf({ ...base, prompt: 'hellp' }))
  ok('参考图变则键变', cacheKeyOf(base) !== cacheKeyOf({ ...base, refHashes: ['y'] }))
  ok('键与字段顺序无关', cacheKeyOf(base) === cacheKeyOf({ promptVersion: 2, refHashes: ['x'], n: 1, size: '1024x1024', prompt: 'hello', model: 'm' }))

  // 反向断言：若把 prompt 排除在键外（最初的想法），改措辞就拿不到新图
  const keyWithoutPrompt = (a) => cacheKeyOf({ ...a, prompt: '' })
  mustFail('不含 prompt 的键能区分措辞', keyWithoutPrompt(base) !== keyWithoutPrompt({ ...base, prompt: 'hellp' }))
}

// ── 3. 抠像：自带 alpha 的图绝不能被抠 ──
{
  const W = 32
  const n = W * W
  // 造一张「模型返回真 RGBA」的图：外圈全透明，中间不透明
  const native = Buffer.alloc(n * 4)
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const inside = x > 7 && x < 24 && y > 7 && y < 24
      native[i * 4] = 90
      native[i * 4 + 1] = 120
      native[i * 4 + 2] = 70
      native[i * 4 + 3] = inside ? 255 : 0
    }
  }
  ok('认出自带 alpha', hasRealAlpha(native, W, W) === true)
  const bbox = alphaBBox(native, W, W)
  ok('自带 alpha 的包围盒是内框', bbox.w === 16 && bbox.h === 16)

  // 反向断言：这正是那个 bug —— 对它抠像会把每个像素写成不透明
  const destroyed = Buffer.from(native)
  chromaKey(destroyed, W, W)
  const after = alphaBBox(destroyed, W, W)
  mustFail('抠像不会毁掉好的 alpha 通道', after.w === 16 && after.h === 16)

  // 洋红背景图：必须认出「没有可用 alpha」，抠完不留粉边
  const keyed = Buffer.alloc(n * 4)
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      const inside = x > 7 && x < 24 && y > 7 && y < 24
      keyed[i * 4] = inside ? 90 : 255
      keyed[i * 4 + 1] = inside ? 120 : 0
      keyed[i * 4 + 2] = inside ? 70 : 255
      keyed[i * 4 + 3] = 255
    }
  }
  ok('洋红图判为「无自带 alpha」', hasRealAlpha(keyed, W, W) === false)
  chromaKey(keyed, W, W)
  ok('抠完得到内框', (() => { const b = alphaBBox(keyed, W, W); return b.w === 16 && b.h === 16 })())
  ok('抠完无洋红残留', magentaResidue(keyed, W, W) < 0.01)
}

// ── 4. 素材清单自洽 ──
{
  const problems = validateSheets()
  ok('清单自检通过：' + problems.join('；'), problems.length === 0)
  ok('清单非空', SHEETS.length > 0)
}

console.log(`\n素材管线自检：${pass} 条通过，${fails.length} 条失败`)
for (const f of fails) console.log('  ✗ ' + f)
if (fails.length) process.exitCode = 1
