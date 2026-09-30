/**
 * AI 生成世界书：提示词组装 / 输出解析 / 落库转换 / 端到端（桩 fetch）的断言。
 *
 * 跑法： npm run verify:worldgen
 */

import {
  buildWorldGenMessages,
  generateWorldBook,
  parseGeneratedWorldBook,
  toWorldEntry,
} from '@/services/worldinfo/generate'
import { emptyCharacter } from '@/types/character'
import { defaultSettings } from '@/types/settings'
import { world_info_position } from '@/types/worldinfo'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else failed++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const char = emptyCharacter('c1', '艾莉')
char.data.description = '港口小镇的年轻剑士，隶属潮声佣兵团。'
char.data.personality = '直率、讲义气'
char.data.scenario = ''

// ── 1. 提示词 ──
{
  const m = buildWorldGenMessages({ mode: 'character', description: '多写酒馆', character: char })
  const user = m[1]?.content ?? ''
  check('角色模式：带角色基础信息', user.includes('艾莉') && user.includes('潮声佣兵团'))
  check('角色模式：带补充描述', user.includes('多写酒馆'))
  check('角色模式：空字段不出现', !user.includes('场景：'))
  check('角色模式：要求不复述角色卡', (m[0]?.content ?? '').includes('不要'))
  const g = buildWorldGenMessages({ mode: 'global', description: '浮空城邦', character: char })
  check('全局模式：不带角色信息', !(g[1]?.content ?? '').includes('艾莉'))
  const a = buildWorldGenMessages({
    mode: 'global',
    description: 'x',
    existingTitles: ['王都', '学院'],
  })
  check('追加：列出已有条目', (a[1]?.content ?? '').includes('王都、学院'))
}

// ── 2. 解析 ──
{
  const raw = `<think>先想想</think>好的：
{"name":"潮声之港","entries":[
 {"title":"潮声佣兵团","keys":["潮声","佣兵团"],"content":"港口最大的佣兵组织。","constant":false},
 {"title":"时代背景","keys":[],"content":"大航海时代末期。","constant":true},
 {"title":"灯塔","content":"废弃灯塔。"},
 {"title":"潮声佣兵团","keys":["重复"],"content":"重复条目"},
 {"title":"空条目","keys":["x"],"content":""}
]}`
  const r = parseGeneratedWorldBook(raw)
  check('去掉思维链并解析', r.name === '潮声之港')
  check('去重、去空正文', r.entries.length === 3, JSON.stringify(r.entries.map((e) => e.title)))
  check('没关键词用标题兜底', r.entries.find((e) => e.title === '灯塔')?.keys.join() === '灯塔')
  check(
    '常驻条目保留',
    r.entries.some((e) => e.constant && e.title === '时代背景'),
  )
  const arr = parseGeneratedWorldBook(
    '[{"comment":"学院","key":"学院,书院","content":"魔法学院。"}]',
  )
  check('兼容顶层数组 + ST 字段名 + 逗号分隔关键词', arr.entries[0]?.keys.join('|') === '学院|书院')
  let err = ''
  try {
    parseGeneratedWorldBook('抱歉，我无法完成')
  } catch (e) {
    err = e instanceof Error ? e.message : ''
  }
  check('非 JSON 报可读错误', err.includes('格式错误'))
}

// ── 3. 落库转换 ──
{
  const e = toWorldEntry(
    { title: '灯塔', keys: ['灯塔'], content: '废弃灯塔。', constant: false },
    7,
  )
  check(
    '字段映射',
    e.uid === 7 && e.comment === '灯塔' && e.key[0] === '灯塔' && e.content === '废弃灯塔。',
  )
  check(
    '其余字段取默认值',
    e.position === world_info_position.before && e.scanDepth === null && e.selective,
  )
  const c = toWorldEntry({ title: '背景', keys: ['x'], content: 'y', constant: true }, 0)
  check('常驻条目不带关键词', c.constant && c.key.length === 0)
}

// ── 4. 端到端（桩 fetch） ──
{
  let sent: Record<string, unknown> = {}
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    const content = JSON.stringify({
      name: '测试',
      entries: [{ title: '王都', keys: ['王都'], content: '王国的首都。', constant: false }],
    })
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })
  }) as typeof fetch
  const provider = {
    ...defaultSettings().provider,
    baseUrl: 'https://relay.example/v1',
    model: 'm',
    contextWindow: 32768,
  }
  const r = await generateWorldBook({
    mode: 'character',
    description: '',
    character: char,
    provider,
    apiKey: 'k',
    signal: new AbortController().signal,
  })
  check('端到端：返回条目', r.entries[0]?.title === '王都')
  check(
    '端到端：独立输出预算',
    typeof sent['max_tokens'] === 'number' && (sent['max_tokens'] as number) > 1024,
  )
  let e1 = ''
  try {
    await generateWorldBook({
      mode: 'global',
      description: ' ',
      provider,
      apiKey: '',
      signal: new AbortController().signal,
    })
  } catch (e) {
    e1 = e instanceof Error ? e.message : ''
  }
  check('全局模式没描述：拒绝', e1.includes('描述'))
  let e2 = ''
  try {
    await generateWorldBook({
      mode: 'character',
      description: 'x',
      provider,
      apiKey: '',
      signal: new AbortController().signal,
    })
  } catch (e) {
    e2 = e instanceof Error ? e.message : ''
  }
  check('角色模式没选角色：拒绝', e2.includes('角色'))
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
