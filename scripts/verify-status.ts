/**
 * 角色状态：解析 / 归一化 / diff / 注入文本 的断言。
 *
 * 跑法： npm run verify:status
 */

import { extractStatus, parseStatusJson, stripStatusForStream } from '@/services/status/parse'
import { diffStatus } from '@/services/status/diff'
import {
  buildStatusBlock,
  latestStatus,
  resolveStatusFields,
  sanitizeFields,
} from '@/services/status/template'
import { cleanGroupMessage } from '@/services/group/cards'
import { completeStatus, initialFor, resolveStatusContext } from '@/services/status/complete'
import { defaultStatusFields, defaultStatusSettings } from '@/types/status'
import type { ChatMessage } from '@/types/chat'
import type { Character } from '@/types/character'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else failed++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const STATUS =
  '{"场景":{"时间":"第1天 傍晚","地点":"酒馆"},"人物":[{"名字":"艾莉","心理状态":"警惕","背包":["短剑","面包"]},{"名字":"我","背包":[]}]}'

// ── extractStatus ──
{
  const r = extractStatus(`她把酒杯推了过来。\n\n<status>${STATUS}</status>`)
  check('标准标签：正文剥干净', r.body === '她把酒杯推了过来。', JSON.stringify(r.body))
  check('标准标签：场景', r.data?.scene['地点'] === '酒馆')
  check('标准标签：人物数组', r.data?.people.length === 2 && r.data.people[0]!.name === '艾莉')
  check('标准标签：列表值', JSON.stringify(r.data?.people[0]!.fields['背包']) === '["短剑","面包"]')
  check('空列表保留为空数组', Array.isArray(r.data?.people[1]!.fields['背包']))
}
{
  const r = extractStatus('正文\n<status>\n```json\n' + STATUS + '\n```\n</status>')
  check('块内 json 围栏', r.data?.scene['时间'] === '第1天 傍晚' && r.body === '正文')
}
{
  const r = extractStatus('正文段落\n<status>{"场景":{"时间":"夜')
  check('截断：正文不带半截 JSON', r.body === '正文段落')
  check('截断：报错', r.data === null && !!r.error?.includes('截断'))
}
{
  const r = extractStatus('只有正文，没有状态。')
  check('没输出：正文原样', r.body === '只有正文，没有状态。')
  check('没输出：报错', r.data === null && !!r.error)
}
{
  const r = extractStatus('正文\n```json\n' + STATUS + '\n```')
  check('无标签末尾代码块：识别为状态', r.data?.scene['地点'] === '酒馆' && r.body === '正文')
  const r2 = extractStatus('这是配置：\n```json\n{"a":1}\n```')
  check('无标签普通 JSON：不当状态吃掉', r2.data === null && r2.body.includes('{"a":1}'))
}
{
  const r = extractStatus('<STATUS>{"scene":{"weather":"雨"},"people":{"Bob":{"mood":"好"}}}</STATUS>尾巴')
  check('大写标签 + 英文键 + 人物字典', r.data?.scene['weather'] === '雨' && r.data.people[0]?.name === 'Bob')
  check('标签后的尾随文字保留', r.body === '尾巴')
}
{
  const r = extractStatus('正文<status>{"时间":"清晨","人物":[{"名字":"A","背包":{"苹果":2,"绳子":null}},],}</status>')
  check('顶层场景键归入场景', r.data?.scene['时间'] === '清晨')
  check('物品字典转列表', JSON.stringify(r.data?.people[0]!.fields['背包']) === '["苹果×2","绳子"]')
  check('尾逗号容错', !!r.data)
}
{
  const r = extractStatus(`a<status>{"场景":{"地点":"旧"}}</status>b<status>{"场景":{"地点":"新"}}</status>`)
  check('多块：取最后一块', r.data?.scene['地点'] === '新')
  check('多块：前面的块也剥掉', r.body === 'ab', JSON.stringify(r.body))
}
check('非法 JSON 报错', extractStatus('x<status>{不是json}</status>').error === '状态不是合法 JSON')
check('空状态视为无效', parseStatusJson('{"场景":{},"人物":[]}') === null)

// ── 流式剥离 ──
check('流式：整块藏起', stripStatusForStream('你好<status>{"场') === '你好')
check('流式：半个开标签也藏', stripStatusForStream('你好\n<sta') === '你好\n')
check('流式：普通 < 不误伤', stripStatusForStream('a<b') === 'a<b')
check('流式：无状态原样', stripStatusForStream('你好') === '你好')

// ── 演绎防串台截断不能误伤状态 ──
{
  const text = `艾莉笑了。\n<status>${STATUS}</status>`
  const r = extractStatus(text)
  const cleaned = cleanGroupMessage(r.body, '艾莉', ['艾莉', '我', 'Bob'])
  check('先剥状态再 cleanGroupMessage：正文完整', cleaned === '艾莉笑了。')
  check('状态里的人名不触发截断', !!r.data && r.data.people.length === 2)
}

// ── diff ──
{
  const a = parseStatusJson(STATUS)!
  const b = parseStatusJson(
    '{"场景":{"时间":"第1天 夜","地点":"酒馆"},"人物":[{"名字":"艾莉","心理状态":"警惕","背包":["面包","钥匙"]},{"名字":"Bob"}]}',
  )!
  const d = diffStatus(a, b)
  const t = d.changes.find((c) => c.key === '时间')
  check('diff：文本变化', t?.from === '第1天 傍晚' && t.to === '第1天 夜')
  const bag = d.changes.find((c) => c.person === '艾莉' && c.key === '背包')
  check('diff：列表增减', bag?.added?.join() === '钥匙' && bag.removed?.join() === '短剑')
  check('diff：登场 / 离场', d.joined.join() === 'Bob' && d.left.join() === '我')
  check('diff：没变的不算', !d.changes.some((c) => c.key === '地点' || c.key === '心理状态'))
  const same = parseStatusJson('{"人物":[{"名字":"A","背包":["b","a"]}]}')!
  const same2 = parseStatusJson('{"人物":[{"名字":"A","背包":["a","b"]}]}')!
  check('diff：仅顺序不同不算变化', diffStatus(same, same2).changes.length === 0)
  check('diff：首份无变化', diffStatus(null, a).changes.length === 0)
}

// ── 模板 ──
{
  const fields = sanitizeFields([
    { key: ' 时间 ', scope: 'scene', kind: 'text' },
    { key: '时间', scope: 'scene' },
    { key: '', scope: 'person' },
    null,
    { key: '背包', scope: 'weird', kind: 'list', enabled: false },
  ])
  check('sanitize：去空去重修正', fields.length === 2 && fields[0]!.key === '时间' && fields[1]!.scope === 'person')
  check('sanitize：保留停用标记', fields[1]!.enabled === false)
  const st = defaultStatusSettings()
  const char = {
    data: { extensions: { np: { status: { fields: [{ key: '魔力', scope: 'person', kind: 'text', enabled: true }] } } } },
  } as unknown as Character
  check(
    '角色覆盖优先',
    resolveStatusFields(st, char.data.extensions.np?.status).map((f) => f.key).join() === '魔力',
  )
  check('无覆盖用全局', resolveStatusFields(st, null).length === defaultStatusFields().length)
}
{
  const fields = defaultStatusFields()
  const block = buildStatusBlock({
    fields,
    current: parseStatusJson(STATUS),
    userName: '我',
    charNames: ['艾莉'],
    isGroup: false,
    sub: (t) => t.replaceAll('{{user}}', '我'),
  })
  check('注入：带当前状态', block.includes('"地点":"酒馆"'))
  check('注入：带格式骨架', block.includes('<status>{"场景"'))
  check('注入：宏已替换', !block.includes('{{user}}') && block.includes('对我的态度'))
  check('注入：人物用数组形式', block.includes('"人物":[{"名字":"艾莉"'))
  const empty = buildStatusBlock({
    fields,
    current: null,
    userName: '我',
    charNames: ['艾莉'],
    isGroup: false,
    sub: (t) => t,
  })
  check('注入：无状态时提示推断', empty.includes('尚无记录'))
}
{
  const msg = (seq: number, status?: object): ChatMessage =>
    ({ seq, id: String(seq), is_user: false, is_system: false, mes: '', extra: status ? { status } : {} }) as ChatMessage
  const msgs = [msg(0, { data: parseStatusJson('{"场景":{"a":"1"}}'), source: 'ai', updatedAt: 1 }), msg(1), msg(2)]
  check('latestStatus：跳过没有快照的消息', latestStatus(msgs)?.msg.seq === 0)
  check('latestStatus：空列表', latestStatus([]) === null)
}

// ── 第二期：四种范围 / 必填名单 / 沿用 / 初始状态 ──
{
  const fields = sanitizeFields([
    { key: '地点', scope: 'scene' },
    { key: '心情', scope: 'person' },
    { key: '关系', scope: 'char' },
    { key: '任务', scope: 'user', kind: 'list' },
    { key: '怪', scope: 'nope' },
  ])
  check('sanitize：四种范围', fields.map((f) => f.scope).join() === 'scene,person,char,user,person')
  const block = buildStatusBlock({
    fields,
    current: null,
    userName: '我',
    charNames: ['艾莉', '阿蓝'],
    isGroup: true,
    sub: (t) => t,
  })
  const sample = JSON.parse(block.match(/<status>(.*)<\/status>/)![1]!)
  const [c, u] = sample['人物']
  check('骨架：角色条目有关系、无任务', '关系' in c && !('任务' in c) && '心情' in c)
  check('骨架：用户条目有任务、无关系', '任务' in u && !('关系' in u) && u['名字'] === '我')
  check('提示词：必填名单含全员和用户', block.includes('艾莉、阿蓝、我'))
  check(
    '提示词：分组列出仅角色 / 仅用户',
    block.includes('仅角色有的字段') && block.includes('仅 我 有的字段'),
  )
}
{
  const fields = sanitizeFields([
    { key: '地点', scope: 'scene' },
    { key: '心情', scope: 'person' },
    { key: '背包', scope: 'person', kind: 'list' },
    { key: '任务', scope: 'user' },
  ])
  const prev = parseStatusJson(
    '{"场景":{"地点":"酒馆"},"人物":[{"名字":"艾莉","心情":"好","背包":["剑"]},{"名字":"阿蓝","心情":"困"},{"名字":"我","任务":"找猫"}]}',
  )!
  const next = parseStatusJson('{"人物":[{"名字":"艾莉","心情":"怒"}]}')!
  const snapshot = JSON.stringify(next)
  const out = completeStatus(next, prev, {
    required: ['艾莉', '阿蓝', '我'],
    fields,
    userName: '我',
  })
  const by = (n: string) => out.people.find((p) => p.name === n)
  check('补全：写了的字段以新为准', by('艾莉')?.fields['心情'] === '怒' && !by('艾莉')?.carried)
  check('补全：漏写的字段沿用', JSON.stringify(by('艾莉')?.fields['背包']) === '["剑"]')
  check(
    '补全：漏写的人整条沿用并标记',
    by('阿蓝')?.fields['心情'] === '困' && by('阿蓝')?.carried === true,
  )
  check('补全：用户也必定在', by('我')?.fields['任务'] === '找猫' && by('我')?.carried === true)
  check('补全：场景字段沿用', out.scene['地点'] === '酒馆')
  check('补全：不改入参', JSON.stringify(next) === snapshot)
  const fresh = completeStatus(next, null, { required: ['艾莉', '我'], fields, userName: '我' })
  check(
    '补全：没有上一份时给空条目',
    JSON.stringify(fresh.people.find((p) => p.name === '我')?.fields) === '{}',
  )
  // 沿用的列表是拷贝，不能与上一份共享数组
  ;(by('艾莉')!.fields['背包'] as string[]).push('盾')
  check('补全：沿用的是拷贝', JSON.stringify(prev.people[0]!.fields['背包']) === '["剑"]')
}
{
  const mk = (id: string, name: string, initial?: object) =>
    ({
      id,
      data: { name, extensions: { np: initial ? { status: { initial } } : {} } },
    }) as unknown as Character
  const a = mk('a', '艾莉', {
    场景: { 地点: '单人剧情的地点' },
    人物: [
      { 名字: '艾莉', 背包: ['剑'] },
      { 名字: '路人', 心情: 'x' },
    ],
  })
  const b = mk('b', '阿蓝', { 人物: [{ 名字: '阿蓝', 背包: ['琴'] }] })
  const g = {
    initial: {
      scene: { 地点: '广场' },
      people: [
        { name: '艾莉', fields: { 背包: ['花'] } },
        { name: '阿蓝', fields: {} },
      ],
    },
  }
  const init = initialFor({ isGroup: true, chars: [a, b], groupConfig: g })!
  const who = (n: string) => init.people.find((p) => p.name === n)
  check('演绎初始：演绎配置优先', JSON.stringify(who('艾莉')?.fields['背包']) === '["花"]')
  check('演绎初始：留空成员回落到角色卡本人', JSON.stringify(who('阿蓝')?.fields['背包']) === '["琴"]')
  check('演绎初始：角色卡的场景与别人不带进群', init.scene['地点'] === '广场' && !who('路人'))
  check(
    '1v1 初始：角色卡整份',
    initialFor({ isGroup: false, chars: [a] })?.scene['地点'] === '单人剧情的地点',
  )
  const ctx = resolveStatusContext({
    settings: defaultStatusSettings(),
    messages: [],
    userName: '我',
    members: [a, b],
    groupConfig: g,
  })
  // 编辑页存下的是内部形状 {scene, people:[{name, fields}]}，不能被当成模型输出解析
  const saved = mk('c', '小红')
  ;(saved.data.extensions as { np: object }).np = {
    status: { initial: { scene: { 天气: '晴' }, people: [{ name: '小红', fields: { 背包: ['伞'] } }] } },
  }
  const solo = initialFor({ isGroup: false, chars: [saved] })
  check(
    '内部形状初始状态：原样读回',
    solo?.scene['天气'] === '晴' && JSON.stringify(solo.people[0]?.fields) === '{"背包":["伞"]}',
  )
  check('上下文：演绎必填 = 全员 + 用户', ctx.required.join() === '艾莉,阿蓝,我')
  check('上下文：无快照时用初始状态', ctx.fromInitial && ctx.current?.scene['地点'] === '广场')
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
