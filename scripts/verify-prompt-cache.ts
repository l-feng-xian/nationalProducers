/**
 * 上下文压缩 + 前缀缓存：用量解析 / 迟滞截断 / 前缀稳定性 / 缓存友好世界书 的断言。
 *
 * 跑法： npm run verify:prompt-cache
 */

import { normalizeUsage } from '@/services/provider/stream'
import { fitWithinBudget } from '@/services/prompt/budget'
import { buildChatPrompt, type BuildPromptInput } from '@/services/prompt/builder'
import {
  cleanHistoryText,
  commonPrefix,
  findVolatileMacros,
  signPrompt,
} from '@/services/prompt/cache'
import { defaultSettings, type Settings } from '@/types/settings'
import { emptyCharacter } from '@/types/character'
import { DEFAULT_WI_ENTRY, type WorldBook } from '@/types/worldinfo'
import type { ChatMessage } from '@/types/chat'
import type { PromptMessage } from '@/types/prompt'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else failed++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

// ── 1. 用量解析 ──
{
  const ds = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_cache_hit_tokens: 900,
    prompt_cache_miss_tokens: 100,
  })
  check('DeepSeek 字段', ds?.prompt === 1000 && ds.cached === 900 && ds.completion === 50)
  const oa = normalizeUsage({
    prompt_tokens: 2048,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 1920 },
  })
  check('OpenAI 字段', oa?.cached === 1920)
  const none = normalizeUsage({ prompt_tokens: 10, completion_tokens: 2 })
  check('没报缓存 → cached 缺省（不是 0）', none !== undefined && !('cached' in none))
  check(
    '非法输入 → undefined',
    normalizeUsage(null) === undefined && normalizeUsage({}) === undefined,
  )
}

// ── 2. 历史净化 / 易变宏 ──
{
  check('去掉闭合思维链', cleanHistoryText('<think>想一想</think>\n你好') === '你好')
  check('未闭合的 <think> 不动', cleanHistoryText('我说 <think> 这个词') === '我说 <think> 这个词')
  check('整条都是思维链 → 保留原文', cleanHistoryText('<think>x</think>') === '<think>x</think>')
  check('压掉多余空行', cleanHistoryText('a\n\n\n\nb') === 'a\n\nb')
  const hits = findVolatileMacros({
    main: '现在是 {{time}}，{{date}}，你好 {{user}} {{pick::a::b}}',
  })
  check(
    '易变宏：time=turn、date=day，user/pick 不算',
    hits.length === 2 &&
      hits.some((h) => h.macro === 'time' && h.scope === 'turn') &&
      hits.some((h) => h.macro === 'date' && h.scope === 'day'),
    JSON.stringify(hits),
  )
}

// ── 3. fitWithinBudget 迟滞 ──
const msg = (i: number): PromptMessage => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })
const tenEach = () => 10
function fit(n: number, budget: number, anchor: number, trimRatio: number) {
  return fitWithinBudget({
    mandatory: [],
    injected: [],
    history: Array.from({ length: n }, (_, i) => msg(i)),
    exampleBlocks: [],
    budget,
    count: tenEach,
    pinExamples: false,
    perMessage: 0,
    anchor,
    trimRatio,
  })
}
{
  // 20 条 × 10 tok，预算 100
  const old = fit(20, 100, 0, 1)
  check(
    'ratio=1 与旧行为一致：保留最新 10 条',
    old.historyStart === 10 && old.history.length === 10,
  )
  const cut = fit(20, 100, 0, 0.7)
  check('ratio=0.7：一次截到 70 tok（7 条）', cut.historyStart === 13 && cut.history.length === 7)
  // 再来 2 条（22 条），沿用 anchor=13 → 9 条 = 90 tok，放得下
  const keep = fit(22, 100, 13, 0.7)
  check('放得下就沿用 anchor，起点不动', keep.historyStart === 13 && keep.history.length === 9)
  // 再来 2 条（24 条），anchor=13 → 11 条 = 110 > 100 → 前移
  const move = fit(24, 100, 13, 0.7)
  check('放不下才前移，且再次截到 70%', move.historyStart === 17 && move.history.length === 7)
  const reset = fit(5, 100, 3, 0.7)
  check(
    '整段放得下时回到 0（如调大了上下文）',
    reset.historyStart === 0 && reset.history.length === 5,
  )
  const tiny = fit(3, 5, 0, 0.7)
  check('最新一条永远保留', tiny.history.length === 1 && tiny.historyStart === 2)
}

// ── 4. 端到端：多轮前缀稳定性 ──
function settingsWith(patch: (s: Settings) => void): Settings {
  const s = defaultSettings()
  s.provider.contextWindow = 1600
  s.provider.maxTokens = 200
  s.prompt.perMessageTokens = 0
  patch(s)
  return s
}
const char = emptyCharacter('c1', '艾莉')
char.data.description = '一位住在港口小镇的年轻剑士。'
const speaker = { id: char.id, name: char.data.name, char }

function mkHistory(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    chatId: 'chat',
    seq: i + 1,
    id: `m${i}`,
    name: i % 2 ? '艾莉' : '我',
    is_user: i % 2 === 0,
    is_system: false,
    mes: `第${i + 1}句话，${'内容'.repeat(20)}`,
    send_date: 0,
  })) as ChatMessage[]
}

function book(entries: Partial<typeof DEFAULT_WI_ENTRY>[]): WorldBook {
  const e: WorldBook['entries'] = {}
  entries.forEach((x, uid) => (e[String(uid)] = { ...DEFAULT_WI_ENTRY, ...x, uid }))
  return { id: 'b1', name: '设定', description: '', entries: e, createdAt: 0, updatedAt: 0 }
}

function build(s: Settings, history: ChatMessage[], startSeq?: number, lore?: WorldBook) {
  const input: BuildPromptInput = {
    isGroup: false,
    speaker,
    members: [speaker],
    mutedIds: [],
    settings: s,
    history,
    chatId: 'chat',
    chatIdHash: 1,
    variables: {},
    timedStore: { sticky: {}, cooldown: {} },
    ...(startSeq != null ? { historyStartSeq: startSeq } : {}),
    ...(lore ? { loreSources: { global: [lore], character: [], chat: [], persona: [] } } : {}),
  }
  return buildChatPrompt(input)
}

/** 模拟 N 轮：每轮 +2 条消息，沿用上一轮的起点；返回相邻两轮公共前缀（块）占上一轮的比例 */
function simulate(s: Settings, turns: number, lore?: WorldBook) {
  let start: number | undefined
  let prev: number[] | null = null
  const ratios: number[] = []
  let moves = 0
  for (let t = 0; t < turns; t++) {
    // 从 30 条起步：一开始就已超预算，只看截断生效后的轮次
    const b = build(s, mkHistory(30 + t * 2), start, lore)
    if (b.debug.historyStartSeq !== start && start !== undefined) moves++
    start = b.debug.historyStartSeq
    // 公共前缀 / 上一轮块数 = 「上一轮的请求」有多少被原样复用（≈ 本轮可命中缓存的部分）
    const sig = signPrompt(b.debug.sections)
    if (prev) ratios.push(commonPrefix(sig, prev) / prev.length)
    prev = sig
  }
  return { ratios, moves }
}
{
  const legacy = simulate(
    settingsWith((s) => (s.prompt.historyTrimRatio = 1)),
    12,
  )
  const tuned = simulate(
    settingsWith((s) => (s.prompt.historyTrimRatio = 0.7)),
    12,
  )
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
  const good = (a: number[]) => a.filter((r) => r > 0.8).length
  check(
    '旧行为：超预算后几乎每轮前缀都断',
    good(legacy.ratios) <= 2,
    `复用>80%的轮数=${good(legacy.ratios)}/${legacy.ratios.length} 平均=${avg(legacy.ratios).toFixed(2)}`,
  )
  check(
    '迟滞截断：绝大多数轮前缀完整复用',
    good(tuned.ratios) >= tuned.ratios.length - tuned.moves - 1 && tuned.moves <= 3,
    `复用>80%的轮数=${good(tuned.ratios)}/${tuned.ratios.length} 起点跳动=${tuned.moves} 平均=${avg(tuned.ratios).toFixed(2)}`,
  )
}

// ── 5. 缓存友好世界书 ──
{
  const lore = book([
    { constant: true, content: '港口小镇常年有雾。', comment: '常驻' },
    { key: ['剑'], content: '艾莉的剑名为「潮声」。', comment: '关键词' },
  ])
  const withSword = (s: Settings) => {
    const h = mkHistory(4)
    const last = h[h.length - 1]!
    last.mes = '她拔出了剑。'
    return build(s, h, undefined, lore)
  }
  const std = withSword(settingsWith(() => {}))
  const wiBlock = std.debug.sections.find((m) => m.source === 'worldInfoBefore')?.content ?? ''
  check('默认布局：关键词条目在前缀里', wiBlock.includes('潮声') && wiBlock.includes('有雾'))

  const cf = withSword(settingsWith((s) => (s.prompt.cacheFriendlyWI = true)))
  const cfBlock = cf.debug.sections.find((m) => m.source === 'worldInfoBefore')?.content ?? ''
  const tail = cf.debug.sections.find((m) => m.injected && m.content.includes('潮声'))
  check('缓存友好：前缀只剩常驻条目', cfBlock.includes('有雾') && !cfBlock.includes('潮声'))
  check('缓存友好：关键词条目进了深度注入', !!tail && (tail.source ?? '').startsWith('inject@'))

  // 激活 / 不激活两轮，前缀（第一段历史之前）应完全一致
  const quiet = (() => {
    const s = settingsWith((x) => (x.prompt.cacheFriendlyWI = true))
    return build(s, mkHistory(4), undefined, lore)
  })()
  // 前缀 = 第一条历史或第一条注入之前的块（历史很短时 depth 4 的注入会顶到历史最前）
  const headOf = (b: ReturnType<typeof build>) =>
    signPrompt(
      b.debug.sections.slice(
        0,
        b.debug.sections.findIndex((m) => m.source === 'chatHistory' || m.injected),
      ),
    )
  const a = headOf(cf)
  const b = headOf(quiet)
  check('缓存友好：关键词激活与否，前缀签名相同', a.length > 0 && commonPrefix(a, b) === a.length)
}

// ── 6. 发送副本去掉思维链，易变宏进 debug ──
{
  const h = mkHistory(2)
  h[1]!.mes = '<think>先分析</think>好的。'
  const s = settingsWith((x) => (x.prompt.mainPrompt = '现在是 {{time}}。请扮演角色。'))
  const b = build(s, h)
  const last = b.messages[b.messages.length - 1]
  check('发给模型的历史不含思维链', !!last && !last.content.includes('先分析'))
  check(
    'debug 报告主提示词里的 {{time}}',
    b.debug.volatileMacros.some((v) => v.where === 'main' && v.macro === 'time'),
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
