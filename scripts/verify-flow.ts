/**
 * 流程控制：数值字段收敛 / 条件求值 / 触发模式 / 动作 / 连锁 / 配置收敛 的断言。
 *
 * 跑法： npm run verify:flow
 */

import {
  evaluateFlow,
  guideBlock,
  loreKeys,
  sanitizeFlow,
  type FlowInput,
} from '@/services/flow/engine'
import { buildFlowGenMessages, parseGeneratedFlow } from '@/services/flow/generate'
import { buildGraph, pruneLayout } from '@/services/flow/graph'
import {
  actionKindPatch,
  conditionOpPatch,
  conditionSourcePatch,
  dropStageRefs,
} from '@/services/flow/edit'
import { normalizeNumberFields, numericValue, sanitizeFields } from '@/services/status/template'
import type { FlowConfig, FlowRule, FlowState } from '@/types/flow'
import type { StatusData, StatusField } from '@/types/status'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else failed++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const FIELDS: StatusField[] = [
  { key: '好感度', scope: 'char', kind: 'number', enabled: true, min: 0, max: 100 },
  { key: '地点', scope: 'scene', kind: 'text', enabled: true },
  { key: '背包', scope: 'person', kind: 'list', enabled: true },
]
const status = (fav: string, place = '酒馆', bag: string[] = []): StatusData => ({
  scene: { 地点: place },
  people: [
    { name: '艾莉', fields: { 好感度: fav, 背包: bag } },
    { name: '我', fields: {} },
  ],
})
const rule = (p: Partial<FlowRule>): FlowRule => ({
  id: 'r1',
  name: '规则',
  enabled: true,
  trigger: { kind: 'afterReply' },
  match: 'all',
  conditions: [],
  mode: 'once',
  actions: [],
  ...p,
})
const run = (config: FlowConfig, over: Partial<FlowInput> = {}) =>
  evaluateFlow({
    sources: [{ ownerId: 'c1', config, charName: '艾莉' }],
    prev: null,
    turn: 1,
    status: status('50'),
    fields: FIELDS,
    vars: {},
    reply: '',
    userName: '我',
    ...over,
  })
const favGte = (v: string) => ({
  id: 'c',
  source: 'person' as const,
  who: '{{char}}',
  key: '好感度',
  op: 'gte' as const,
  value: v,
})

// ── 1. 数值字段 ──
{
  const f = sanitizeFields([{ key: 'x', scope: 'char', kind: 'number', min: 100, max: 0 }])[0]
  check('number 类型保留，上下限写反自动对调', f?.kind === 'number' && f.min === 0 && f.max === 100)
  const t = sanitizeFields([{ key: 'x', kind: 'text', min: 1 }])[0]
  check('非 number 字段丢掉上下限', t?.min === undefined)
  check('取第一个数字', numericValue('好感度 65 点') === 65 && numericValue('1,200') === 1200)
  check('列表取条数', numericValue(['a', 'b']) === 2)
  const n = normalizeNumberFields(status('120'), FIELDS, null)
  check('超出上限夹到 100', n.people[0]?.fields['好感度'] === '100')
  const keep = normalizeNumberFields(status('较高'), FIELDS, status('40'))
  check('取不出数时沿用上一份', keep.people[0]?.fields['好感度'] === '40')
  const drop = normalizeNumberFields(status('较高'), FIELDS, null)
  check('上一份也没有就删掉', !('好感度' in (drop.people[0]?.fields ?? {})))
}

// ── 2. 条件与模式 ──
{
  const cfg = {
    rules: [
      rule({
        conditions: [favGte('80')],
        actions: [{ id: 'a', kind: 'say', text: '{{user}}，谢谢你。' }],
      }),
    ],
  }
  check('未达阈值不触发', run(cfg).fired.length === 0)
  const r = run(cfg, { status: status('85') })
  check('达到阈值触发，宏替换', r.says[0]?.text === '我，谢谢你。' && r.says[0]?.speaker === '艾莉')
  const again = run(cfg, { status: status('90'), prev: r.state, turn: 2 })
  check('once：之后不再触发', again.fired.length === 0)

  const edge = {
    rules: [
      rule({
        mode: 'edge',
        conditions: [favGte('80')],
        actions: [{ id: 'a', kind: 'setVar', key: 'n', mode: 'add', value: '1' }],
      }),
    ],
  }
  const e1 = run(edge, { status: status('85') })
  const e2 = run(edge, { status: status('90'), prev: e1.state, turn: 2, vars: e1.vars })
  const e3 = run(edge, { status: status('60'), prev: e2.state, turn: 3, vars: e2.vars })
  const e4 = run(edge, { status: status('82'), prev: e3.state, turn: 4, vars: e3.vars })
  check(
    'edge：持续成立不重复，跌落后再涨回再触发',
    e1.vars['n'] === '1' && e2.vars['n'] === '1' && e4.vars['n'] === '2',
  )

  const always = {
    rules: [
      rule({
        mode: 'always',
        cooldown: 2,
        actions: [{ id: 'a', kind: 'setVar', key: 'n', mode: 'add', value: '1' }],
      }),
    ],
  }
  let st: FlowState | null = null
  let vars: Record<string, string> = {}
  const hits: number[] = []
  for (let t = 1; t <= 5; t++) {
    const o = run(always, { prev: st, turn: t, vars })
    if (o.fired.length) hits.push(t)
    st = o.state
    vars = o.vars
  }
  check('always + 冷却 2：第 1、3、5 轮触发', hits.join() === '1,3,5', hits.join())

  const every = { rules: [rule({ mode: 'always', trigger: { kind: 'everyN', n: 3 } })] }
  check(
    '每 3 轮检查一次',
    run(every, { turn: 2 }).fired.length === 0 && run(every, { turn: 3 }).fired.length === 1,
  )

  const any = {
    rules: [
      rule({
        match: 'any',
        conditions: [
          favGte('99'),
          { id: 'p', source: 'scene', key: '地点', op: 'contains', value: '酒' },
        ],
      }),
    ],
  }
  check('任一满足', run(any).fired.length === 1)
  const bag = {
    rules: [
      rule({
        conditions: [
          { id: 'b', source: 'person', who: '艾莉', key: '背包', op: 'contains', value: '钥匙' },
        ],
      }),
    ],
  }
  check(
    '列表包含',
    run(bag, { status: status('1', '酒馆', ['旧钥匙']) }).fired.length === 1 &&
      run(bag).fired.length === 0,
  )
  const reply = {
    rules: [rule({ conditions: [{ id: 'r', source: 'reply', op: 'contains', value: '告白' }] })],
  }
  check('本轮回复正文', run(reply, { reply: '她终于告白了' }).fired.length === 1)
}

// ── 3. 动作 ──
{
  const add = {
    rules: [
      rule({
        actions: [
          { id: 'a', kind: 'setStatus', who: '{{char}}', key: '好感度', mode: 'add', value: '60' },
        ],
      }),
    ],
  }
  const o = run(add)
  check('状态数值加减并夹上限', o.statusChanged && o.status?.people[0]?.fields['好感度'] === '100')
  check('不改入参', run(add).status !== null && status('50').people[0]?.fields['好感度'] === '50')
  const push = {
    rules: [
      rule({
        actions: [
          { id: 'a', kind: 'setStatus', who: '艾莉', key: '背包', mode: 'push', value: '信' },
        ],
      }),
    ],
  }
  check('列表加入物品', (run(push).status?.people[0]?.fields['背包'] as string[]).includes('信'))
  const scene = {
    rules: [
      rule({ actions: [{ id: 'a', kind: 'setStatus', who: 'scene', key: '地点', value: '灯塔' }] }),
    ],
  }
  check('改场景字段', run(scene).status?.scene['地点'] === '灯塔')

  const guide = {
    rules: [
      rule({ actions: [{ id: 'a', kind: 'guide', text: '{{char}}开始回避话题', turns: 2 }] }),
    ],
  }
  const g1 = run(guide)
  check(
    '引导写进运行态',
    g1.state.guides[0]?.text === '艾莉开始回避话题' &&
      guideBlock(g1.state).includes('艾莉开始回避话题'),
  )
  const g2 = run(guide, { prev: g1.state, turn: 2 })
  const g3 = run(guide, { prev: g2.state, turn: 3 })
  check('引导 2 轮后失效', g2.state.guides.length === 1 && g3.state.guides.length === 0)
}

// ── 4. 连锁与防死循环 ──
{
  const chain: FlowConfig = {
    rules: [
      rule({ id: 'a', actions: [{ id: 'x', kind: 'setVar', key: 'stage', value: '2' }] }),
      rule({
        id: 'b',
        conditions: [{ id: 'c', source: 'var', key: 'stage', op: 'eq', value: '2' }],
        actions: [{ id: 'y', kind: 'say', text: '第二幕' }],
      }),
    ],
  }
  const reversed = { rules: [...chain.rules].reverse() }
  check('改变量后连锁触发（与规则顺序无关）', run(reversed).says[0]?.text === '第二幕')
  const loop = {
    rules: [
      rule({
        mode: 'always',
        actions: [{ id: 'x', kind: 'setVar', key: 'n', mode: 'add', value: '1' }],
      }),
    ],
  }
  check('同一规则每轮最多执行一次', run(loop).vars['n'] === '1')
  const off = { rules: [rule({ enabled: false, actions: [{ id: 'x', kind: 'say', text: 'x' }] })] }
  check('停用的规则不跑', run(off).says.length === 0)
}

// ── 5. 演绎：成员卡上的规则 {{char}} 指成员本人 ──
{
  const cfg = {
    rules: [
      rule({
        conditions: [favGte('80')],
        actions: [{ id: 'a', kind: 'say', text: '{{char}}脸红了' }],
      }),
    ],
  }
  const o = evaluateFlow({
    sources: [
      { ownerId: 'g1', config: undefined, charName: '布兰' },
      { ownerId: 'c1', config: cfg, charName: '艾莉' },
    ],
    prev: null,
    turn: 1,
    status: status('85'),
    fields: FIELDS,
    vars: {},
    reply: '',
    userName: '我',
  })
  check('成员规则按成员本人求值', o.says[0]?.text === '艾莉脸红了' && o.says[0]?.speaker === '艾莉')
}

// ── 6. 配置收敛 ──
{
  const s = sanitizeFlow({
    rules: [
      {
        id: 'a',
        name: 'ok',
        conditions: [
          { source: 'person', op: 'gte', value: '1' },
          { source: 'bad', op: 'eq' },
        ],
        actions: [{ kind: 'say', text: 'x' }, { kind: 'rm -rf' }],
      },
      { id: 'a', name: '重复 id' },
      'garbage',
      { name: '没有 id' },
    ],
  })
  check(
    '丢掉非法条件 / 动作 / 重复与无 id 规则',
    s.rules.length === 1 && s.rules[0]?.conditions.length === 1 && s.rules[0]?.actions.length === 1,
  )
  check(
    '非对象输入给空配置',
    sanitizeFlow(undefined).rules.length === 0 && sanitizeFlow('x').rules.length === 0,
  )
}

// ── 7. 剧情阶段 ──
{
  const stages = [
    {
      id: 's1',
      name: '相识',
      guide: '{{char}}还很拘谨',
      transitions: [{ id: 't1', to: 's2', match: 'all' as const, conditions: [favGte('30')] }],
    },
    {
      id: 's2',
      name: '熟悉',
      guide: '{{char}}开始主动分享',
      transitions: [{ id: 't2', to: 's3', match: 'all' as const, conditions: [favGte('70')] }],
    },
    { id: 's3', name: '告白', transitions: [] },
  ]
  const cfg: FlowConfig = {
    rules: [
      rule({
        id: 'enter3',
        conditions: [{ id: 'c', source: 'stage', op: 'eq', value: 's3' }],
        actions: [{ id: 'a', kind: 'say', text: '终于到这一步了' }],
      }),
    ],
    stages,
  }
  const src = [{ ownerId: 'c1', config: cfg, charName: '艾莉' }]
  check(
    '没有记录时在第一个阶段，注入其引导',
    guideBlock(null, src).includes('【当前阶段：相识】艾莉还很拘谨'),
  )
  const a = run(cfg, { status: status('10') })
  check('条件不满足不切换', a.stageMoves.length === 0 && !a.state.stages)
  const b = run(cfg, { status: status('90') })
  check('每条回复最多推进一格', b.state.stages?.['c1'] === 's2' && b.stageMoves.length === 1)
  check(
    '阶段切换写进日志',
    (b.state.log ?? []).some((l) => l.includes('相识 → 熟悉')),
  )
  check('切换后引导跟着变', guideBlock(b.state, src).includes('【当前阶段：熟悉】艾莉开始主动分享'))
  const c = run(cfg, { status: status('90'), prev: b.state, turn: 2 })
  check(
    '下一轮继续推进，阶段条件连锁触发规则',
    c.state.stages?.['c1'] === 's3' && c.says[0]?.text === '终于到这一步了',
  )
  const jump = {
    rules: [rule({ actions: [{ id: 'a', kind: 'setStage' as const, stage: 's3' }] })],
    stages,
  }
  check('setStage 动作直接跳转', run(jump).state.stages?.['c1'] === 's3')
  const gone = run(cfg, {
    status: status('10'),
    prev: { fired: {}, truth: {}, guides: [], stages: { c1: 'deleted' } },
  })
  check('记录的阶段被删了就回到第一个', guideBlock(gone.state, src).includes('相识'))
  const s = sanitizeFlow({
    rules: [],
    stages: [
      {
        id: 'x',
        name: 'X',
        transitions: [{ to: 'x' }, { to: 'nope' }, { to: 'y', conditions: [] }],
      },
      { id: 'y', name: 'Y' },
    ],
  })
  check('丢掉指向自己 / 不存在阶段的连线', s.stages?.[0]?.transitions.length === 1)
  const noCond = { rules: [], stages: s.stages }
  check('没有条件的连线不自动走', !run(noCond).state.stages)
}

// ── 8. 第三期动作：世界书激活 / 下一位发言者 / 静音 ──
{
  const lore = {
    rules: [
      rule({ actions: [{ id: 'a', kind: 'activateLore' as const, book: 'b1', uid: 3, turns: 2 }] }),
    ],
  }
  const l1 = run(lore)
  check('激活世界书写进运行态', loreKeys(l1.state).join() === 'b1.3')
  const l2 = run({ rules: [] }, { prev: l1.state, turn: 2 })
  const l3 = run({ rules: [] }, { prev: l2.state, turn: 3 })
  check('世界书激活 2 轮后失效', loreKeys(l2.state).length === 1 && loreKeys(l3.state).length === 0)
  const bad = {
    rules: [rule({ actions: [{ id: 'a', kind: 'activateLore' as const, book: 'b1' }] })],
  }
  check('没选条目不激活', loreKeys(run(bad).state).length === 0)

  const next = {
    rules: [rule({ actions: [{ id: 'a', kind: 'nextSpeaker' as const, who: '布兰' }] })],
  }
  const n1 = run(next)
  check('指定下一位发言者', n1.state.nextSpeaker === '布兰')
  check(
    '下一位发言者只生效一次',
    !run({ rules: [] }, { prev: n1.state, turn: 2 }).state.nextSpeaker,
  )

  const mute = { rules: [rule({ actions: [{ id: 'a', kind: 'mute' as const, who: '{{char}}' }] })] }
  const m1 = run(mute)
  const m2 = run({ rules: [] }, { prev: m1.state, turn: 2 })
  check('静音持续到取消', m1.state.muted?.[0] === '艾莉' && m2.state.muted?.[0] === '艾莉')
  // 规则 id 必须与上面的静音规则不同：同 id + once 模式会被当成已触发过
  const unmute = {
    rules: [rule({ id: 'r2', actions: [{ id: 'a', kind: 'unmute' as const, who: '艾莉' }] })],
  }
  check('取消静音', !run(unmute, { prev: m2.state, turn: 3 }).state.muted)

  const s = sanitizeFlow({
    rules: [
      { id: 'x', actions: [{ kind: 'activateLore', book: 'b', uid: 2.4 }, { kind: 'mute' }] },
    ],
  })
  check('新动作通过配置收敛', s.rules[0]?.actions[0]?.uid === 2 && s.rules[0]?.actions.length === 2)
}

// ── 9. AI 生成流程草稿的解析 ──
{
  const raw = `<think>先想想</think>好的：
{
  "suggestedFields": [{ "key": "信任", "scope": "char", "min": 0, "max": 100 }, { "key": "好感度", "scope": "char" }],
  "stages": [
    { "name": "相识", "guide": "拘谨", "transitions": [
      { "to": "熟悉", "conditions": [{ "source": "person", "who": "{{char}}", "key": "好感度", "op": ">=", "value": 30 }] },
      { "to": "不存在", "conditions": [{ "source": "turn", "op": "gte", "value": "5" }] },
      { "to": "熟悉", "conditions": [] }
    ] },
    { "name": "熟悉", "transitions": [] },
    { "name": "相识", "transitions": [] }
  ],
  "rules": [
    { "name": "进入熟悉", "conditions": [{ "source": "stage", "op": "eq", "value": "熟悉" }],
      "actions": [{ "kind": "guide", "text": "开始分享", "turns": 2 }, { "kind": "setStage", "stage": "相识" }, { "kind": "hack" }] },
    { "conditions": [{ "source": "person", "key": "神秘值", "op": "gt", "value": "1" }], "actions": [] }
  ]
}`
  const g = parseGeneratedFlow(raw, FIELDS)
  const st = g.config.stages ?? []
  check('去掉 think、同名阶段只留一个', st.length === 2 && st[0]?.name === '相识')
  check(
    '阶段连线用 id，丢掉悬空 / 无条件的连线，op 别名换成标准写法',
    st[0]?.transitions.length === 1 &&
      st[0]?.transitions[0]?.to === st[1]?.id &&
      st[0]?.transitions[0]?.conditions[0]?.op === 'gte' &&
      st[0]?.transitions[0]?.conditions[0]?.value === '30',
  )
  const r0 = g.config.rules[0]
  check('「当前阶段」条件的阶段名换成 id', r0?.conditions[0]?.value === st[1]?.id)
  check(
    'setStage 的阶段名换成 id，非法动作丢掉',
    r0?.actions.length === 2 && r0?.actions[1]?.stage === st[0]?.id,
  )
  check('没名字的规则给默认名', g.config.rules[1]?.name === '规则 2')
  check('建议字段去掉已有的', g.suggestedFields.map((f) => f.key).join() === '信任')
  check('未知字段被列出', g.unknownKeys.join() === '神秘值')
  let threw = false
  try {
    parseGeneratedFlow('不是 JSON', FIELDS)
  } catch {
    threw = true
  }
  check('格式错误时报错', threw)
  const ids = buildFlowGenMessages({ description: 'x', fields: FIELDS, isGroup: true })
  check('演绎提示词带上演绎动作说明', ids[0]!.content.includes('nextSpeaker'))
}

// ── 10. 生成配图标记只作用于本条 ──
{
  const img = { rules: [rule({ actions: [{ id: 'a', kind: 'image' as const }] })] }
  const i1 = run(img)
  check('配图动作打标记', i1.state.image === true)
  check('配图标记不往后带', !run({ rules: [] }, { prev: i1.state, turn: 2 }).state.image)
}

// ── 11. 节点流程图：配置 → 节点 / 连线，坐标清理 ──
{
  const cfg = {
    stages: [
      {
        id: 's1',
        name: '相识',
        transitions: [
          { id: 't1', to: 's2', match: 'all' as const, conditions: [] },
          { id: 't2', to: 'gone', match: 'all' as const, conditions: [] },
        ],
      },
      { id: 's2', name: '熟悉', transitions: [] },
    ],
    rules: [
      rule({
        conditions: [{ id: 'c1', source: 'stage' as const, op: 'eq' as const, value: 's2' }],
        actions: [
          { id: 'a1', kind: 'guide' as const, text: 'x' },
          { id: 'a2', kind: 'setStage' as const, stage: 's1' },
        ],
      }),
    ],
    layout: { 's:s1': { x: 5, y: 6 }, 'r:gone': { x: 1, y: 1 } },
  }
  const g = buildGraph(cfg)
  const ids = g.nodes.map((n) => n.id)
  check('节点：阶段 + 规则 + 动作', ids.join() === 's:s1,s:s2,r:r1,a:r1:a1,a:r1:a2')
  check('初始阶段打标', g.nodes[0]?.data.initial === true && !g.nodes[1]?.data.initial)
  check('坐标优先取 layout', g.nodes[0]?.position.x === 5 && g.nodes[0]?.position.y === 6)
  const kinds = g.edges.map((e) => `${e.data.kind}:${e.source}>${e.target}`)
  check(
    '阶段出口连线，悬空的丢掉',
    kinds.filter((k) => k.startsWith('transition')).join() === 'transition:s:s1>s:s2',
  )
  check(
    '动作依次连成链',
    kinds.includes('chain:r:r1>a:r1:a1') && kinds.includes('chain:a:r1:a1>a:r1:a2'),
  )
  check('切换阶段动作连到目标阶段', kinds.includes('jump:a:r1:a2>s:s1'))
  check('阶段条件连到规则', kinds.includes('when:s:s2>r:r1'))
  check(
    '连线都用流动连线类型',
    g.edges.every((e) => e.type === 'flow'),
  )
  const pruned = pruneLayout(cfg)
  check('坐标清理掉已删节点', !!pruned && Object.keys(pruned).join() === 's:s1')
  check(
    '没有有效坐标时返回 undefined',
    pruneLayout({ rules: [], layout: { 'r:x': { x: 0, y: 0 } } }) === undefined,
  )
  const s = sanitizeFlow({
    rules: [],
    layout: { a: { x: 1.6, y: 2 }, b: { x: 'x', y: 1 }, c: null },
  })
  check('layout 收敛：只留有限数字并取整', JSON.stringify(s.layout) === '{"a":{"x":2,"y":2}}')
}

// ── 12. 联动清理：上级一改，下级残留必须清掉 ──
{
  const base = rule({
    actions: [
      { id: 'a1', kind: 'setStatus', who: '{{char}}', key: '好感度', mode: 'add', value: '10' },
    ],
  })
  // 换类型：新类型用不上的字段全清（只留 id / kind）
  const p1 = actionKindPatch(base.actions[0]!, 'image')
  check(
    '换动作类型：清掉不适用的字段',
    p1.key === undefined && p1.who === undefined && p1.mode === undefined && p1.value === undefined,
    JSON.stringify(p1),
  )
  const p2 = actionKindPatch(base.actions[0]!, 'setVar')
  check('换到 setVar：保留 key/mode/value，清掉 who', p2.who === undefined && p2.key === '好感度')
  const p3 = actionKindPatch({ id: 'x', kind: 'say', text: '你好' }, 'guide')
  check('换成引导剧情：留下台词文本并补默认轮数', p3.text === '你好' && p3.turns === 1)
  const p4 = actionKindPatch({ id: 'x', kind: 'guide', text: 'a', turns: 3 }, 'guide')
  check('同类型不动轮数', p4.turns === 3)

  // 换取值来源：字段名与比较值都清空
  const cond: FlowCondition = {
    id: 'c1',
    source: 'person',
    who: '{{char}}',
    key: '好感度',
    op: 'gte',
    value: '60',
  }
  const s1 = conditionSourcePatch(cond, 'scene')
  check(
    '换来源：清字段与值，且不带「谁」',
    s1.key === undefined && s1.value === '' && s1.who === undefined,
  )
  const s2 = conditionSourcePatch(cond, 'var')
  check('换到变量：同样清掉字段', s2.key === undefined && s2.value === '')
  const s3 = conditionSourcePatch(cond, 'person')
  check('换回人物：给个默认的「谁」', s3.who === '{{char}}')

  // 换比较方式：值清空
  check('换比较方式清空值', conditionOpPatch(cond, 'contains').value === '')

  // 删阶段：连线、setStage 动作、阶段条件都要跟着清
  const cfg: FlowConfig = {
    rules: [
      rule({
        id: 'r1',
        conditions: [{ id: 'c1', source: 'stage', op: 'eq', value: 's2' }],
        actions: [{ id: 'a1', kind: 'setStage', stage: 's2' }],
      }),
      rule({ id: 'r2', conditions: [{ id: 'c2', source: 'stage', op: 'eq', value: 's1' }] }),
    ],
    stages: [
      {
        id: 's1',
        name: '相识',
        transitions: [{ id: 't1', to: 's2', match: 'all', conditions: [] }],
      },
      { id: 's2', name: '熟悉', transitions: [] },
    ],
  }
  const after = dropStageRefs(cfg, 's2')
  check('删阶段：阶段少一个', after.stages?.length === 1)
  check('删阶段：指向它的连线清掉', after.stages?.[0]?.transitions.length === 0)
  check('删阶段：「切换阶段」动作的目标清空', after.rules[0]?.actions[0]?.stage === undefined)
  check('删阶段：「当前阶段 = 它」的条件值清空', after.rules[0]?.conditions[0]?.value === '')
  check('删阶段：指向别的阶段的条件不动', after.rules[1]?.conditions[0]?.value === 's1')
}

console.log(`\n${passed} passed, ${failed} failed`)
