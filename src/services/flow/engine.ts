/**
 * 流程控制求值引擎。纯 TS，不 import vue/pinia，verify-flow.ts 直接在 node 里跑断言。
 *
 * 一次 evaluateFlow = 一条 AI 回复落库前的检查：
 *  1. 上一份运行态里的剧情引导刚被这条回复用掉一轮 → 先扣减；
 *  2. 逐条规则求值，满足就执行动作；「改状态 / 设变量」可能让别的规则变为成立，
 *     所以最多重复 MAX_PASSES 遍，每条规则每次求值最多执行一次（防死循环）；
 *  3. 返回新运行态 + 改过的状态 / 变量 + 要插入的固定台词，由调用方落库。
 */

import type {
  FlowAction,
  FlowCondition,
  FlowConfig,
  FlowRule,
  FlowStage,
  FlowState,
  FlowTransition,
} from '@/types/flow'
import type { ChatMessage } from '@/types/chat'
import type { StatusData, StatusField, StatusValue } from '@/types/status'
import { clampNumber, numericValue } from '@/services/status/template'

const MAX_PASSES = 5

export interface FlowSourceInput {
  /** 规则归属（角色 id / 演绎 id），与规则 id 拼成运行态里的键 */
  ownerId: string
  config: FlowConfig | undefined
  /** 这份规则里 {{char}} 指谁：角色卡 = 角色本人；演绎 = 本轮发言者 */
  charName: string
}

export interface FlowInput {
  sources: FlowSourceInput[]
  prev: FlowState | null
  /** 含本条在内的 AI 回复条数 */
  turn: number
  status: StatusData | null
  fields: StatusField[]
  vars: Record<string, string>
  reply: string
  userName: string
}

export interface FlowOutput {
  state: FlowState
  status: StatusData | null
  statusChanged: boolean
  vars: Record<string, string>
  varsChanged: boolean
  says: { speaker: string; text: string }[]
  fired: string[]
  /** 本轮发生的阶段切换：「角色名 · 旧阶段 → 新阶段」 */
  stageMoves: string[]
}

export function subMacros(t: string, charName: string, userName: string): string {
  return t.replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName)
}

interface Ctx {
  status: StatusData | null
  vars: Record<string, string>
  input: FlowInput
  charName: string
  /** 当前求值的来源及其阶段表 */
  ownerId: string
  stageList: FlowStage[]
  /** ownerId → 当前阶段 id（就地改，即 state.stages） */
  stages: Record<string, string>
}

/** 某来源当前所在阶段：记录的 id 不存在（阶段被删）时回到第一个阶段 */
export function currentStage(
  stages: FlowStage[],
  state: Pick<FlowState, 'stages'> | null | undefined,
  ownerId: string,
): FlowStage | undefined {
  const id = state?.stages?.[ownerId]
  return stages.find((s) => s.id === id) ?? stages[0]
}

function readValue(c: FlowCondition, ctx: Ctx): StatusValue | undefined {
  const who = subMacros(c.who ?? '', ctx.charName, ctx.input.userName).trim()
  const key = (c.key ?? '').trim()
  switch (c.source) {
    case 'person':
      return ctx.status?.people.find((p) => p.name === who)?.fields[key]
    case 'scene':
      return ctx.status?.scene[key]
    case 'var':
      return ctx.vars[key]
    case 'turn':
      return String(ctx.input.turn)
    case 'reply':
      return ctx.input.reply
    case 'stage':
      return currentStage(ctx.stageList, ctx, ctx.ownerId)?.id ?? ''
  }
}

export function testCondition(c: FlowCondition, ctx: Ctx): boolean {
  const v = readValue(c, ctx)
  const want = subMacros(c.value ?? '', ctx.charName, ctx.input.userName).trim()
  // 阶段按 id 精确比较：id 是 UUID，走数字提取会把里面的数字当成值
  if (c.source === 'stage') {
    const same = v === want
    return c.op === 'ne' || c.op === 'notContains' ? !same : same
  }
  if (c.op === 'contains' || c.op === 'notContains') {
    const has = Array.isArray(v) ? v.some((x) => x.includes(want)) : (v ?? '').includes(want)
    return c.op === 'contains' ? has : !has
  }
  if (v === undefined) return c.op === 'ne'
  const a = numericValue(v)
  const b = numericValue(want)
  if (c.op === 'eq' || c.op === 'ne') {
    const text = Array.isArray(v) ? v.join('、') : v.trim()
    const same = a !== undefined && b !== undefined && !Array.isArray(v) ? a === b : text === want
    return c.op === 'eq' ? same : !same
  }
  if (a === undefined || b === undefined) return false
  switch (c.op) {
    case 'gt':
      return a > b
    case 'gte':
      return a >= b
    case 'lt':
      return a < b
    case 'lte':
      return a <= b
  }
  return false
}

function matchAll(
  r: { match: 'all' | 'any'; conditions: FlowCondition[] },
  ctx: Ctx,
  emptyIs = true,
): boolean {
  if (!r.conditions.length) return emptyIs
  return r.match === 'any'
    ? r.conditions.some((c) => testCondition(c, ctx))
    : r.conditions.every((c) => testCondition(c, ctx))
}
const ruleTrue = (r: FlowRule, ctx: Ctx) => matchAll(r, ctx)

function triggerDue(r: FlowRule, turn: number): boolean {
  if (r.trigger.kind === 'everyN') {
    const n = Math.max(1, Math.round(r.trigger.n ?? 1))
    return turn % n === 0
  }
  return true
}

function cloneStatus(s: StatusData | null): StatusData {
  if (!s) return { scene: {}, people: [] }
  const copy = (r: Record<string, StatusValue>) =>
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
  return {
    scene: copy(s.scene),
    people: s.people.map((p) => ({ ...p, fields: copy(p.fields) })),
  }
}

/** setStatus：就地改 ctx.status（调用前已 clone）。返回是否真的改了 */
function applyStatus(a: FlowAction, ctx: Ctx): boolean {
  const key = (a.key ?? '').trim()
  if (!key) return false
  const whoRaw = (a.who ?? '').trim()
  const status = (ctx.status ??= { scene: {}, people: [] })
  let rec: Record<string, StatusValue>
  if (!whoRaw || whoRaw === 'scene') rec = status.scene
  else {
    const who = subMacros(whoRaw, ctx.charName, ctx.input.userName)
    let p = status.people.find((x) => x.name === who)
    if (!p) status.people.push((p = { name: who, fields: {} }))
    rec = p.fields
  }
  const field = ctx.input.fields.find((f) => f.key === key)
  const val = subMacros(a.value ?? '', ctx.charName, ctx.input.userName).trim()
  const before = JSON.stringify(rec[key] ?? null)
  const mode = a.mode ?? 'set'
  if (mode === 'add') {
    const n = (numericValue(rec[key]) ?? 0) + (numericValue(val) ?? 0)
    rec[key] = String(field ? clampNumber(n, field) : n)
  } else if (mode === 'push' || mode === 'pull') {
    const cur = rec[key]
    const list = Array.isArray(cur) ? [...cur] : cur ? [cur] : []
    if (mode === 'push' && val && !list.includes(val)) list.push(val)
    rec[key] = mode === 'pull' ? list.filter((x) => x !== val) : list
  } else if (field?.kind === 'number') {
    const n = numericValue(val)
    if (n === undefined) return false
    rec[key] = String(clampNumber(n, field))
  } else if (field?.kind === 'list') {
    rec[key] = val
      ? val
          .split(/[,，、]/)
          .map((x) => x.trim())
          .filter(Boolean)
      : []
  } else rec[key] = val
  return JSON.stringify(rec[key] ?? null) !== before
}

function runAction(
  a: FlowAction,
  key: string,
  ctx: Ctx,
  out: {
    state: FlowState
    says: FlowOutput['says']
    flags: { status: boolean; vars: boolean }
    moves: FlowOutput['stageMoves']
  },
) {
  const sub = (t: string | undefined) => subMacros(t ?? '', ctx.charName, ctx.input.userName).trim()
  switch (a.kind) {
    case 'guide': {
      const text = sub(a.text)
      if (!text) return
      const left = Math.max(1, Math.round(a.turns ?? 1))
      // 同一规则的同一段引导重复触发：刷新轮数，不叠加
      out.state.guides = out.state.guides.filter((g) => !(g.ruleKey === key && g.text === text))
      out.state.guides.push({ ruleKey: key, text, left })
      return
    }
    case 'say': {
      const text = sub(a.text)
      if (text) out.says.push({ speaker: sub(a.speaker || '{{char}}') || ctx.charName, text })
      return
    }
    case 'setStatus':
      if (applyStatus(a, ctx)) out.flags.status = true
      return
    case 'setVar': {
      const k = (a.key ?? '').trim()
      if (!k) return
      const val = sub(a.value)
      const next =
        a.mode === 'add' ? String((numericValue(ctx.vars[k]) ?? 0) + (numericValue(val) ?? 0)) : val
      if (ctx.vars[k] !== next) {
        ctx.vars[k] = next
        out.flags.vars = true
      }
      return
    }
    case 'setStage':
      moveStage(ctx, a.stage, out.moves)
      return
    case 'activateLore': {
      const book = (a.book ?? '').trim()
      if (!book || typeof a.uid !== 'number') return
      const left = Math.max(1, Math.round(a.turns ?? 1))
      // 同一条目重复激活：刷新轮数，不叠加
      const lore = (out.state.lore ?? []).filter((l) => !(l.book === book && l.uid === a.uid))
      lore.push({ book, uid: a.uid, left })
      out.state.lore = lore
      return
    }
    case 'nextSpeaker': {
      const who = sub(a.who || '{{char}}')
      if (who) out.state.nextSpeaker = who
      return
    }
    case 'image':
      out.state.image = true
      return
    case 'mute':
    case 'unmute': {
      const who = sub(a.who || '{{char}}')
      if (!who) return
      const list = (out.state.muted ?? []).filter((n) => n !== who)
      if (a.kind === 'mute') list.push(who)
      out.state.muted = list
    }
  }
}

/** 切到本来源的某个阶段；目标不存在或已在该阶段时什么都不做。返回是否切换了 */
function moveStage(ctx: Ctx, to: string | undefined, moves: string[]): boolean {
  const target = ctx.stageList.find((s) => s.id === to)
  const cur = currentStage(ctx.stageList, ctx, ctx.ownerId)
  if (!target || target.id === cur?.id) return false
  ctx.stages[ctx.ownerId] = target.id
  moves.push(`${ctx.charName} · ${cur?.name || '?'} → ${target.name || '?'}`)
  return true
}

function firstTrue(list: FlowTransition[], ctx: Ctx): FlowTransition | undefined {
  // 没有条件的连线不自动走：否则一进阶段就立刻被带走
  return list.find((t) => matchAll(t, ctx, false))
}

export function evaluateFlow(input: FlowInput): FlowOutput {
  const prev = input.prev ?? { fired: {}, truth: {}, guides: [] }
  // 上一份运行态里的引导已经注入进了这条回复：扣掉一轮
  const state: FlowState = {
    fired: { ...prev.fired },
    truth: { ...prev.truth },
    guides: prev.guides.map((g) => ({ ...g, left: g.left - 1 })).filter((g) => g.left > 0),
    stages: { ...prev.stages },
    // 世界书激活与引导同理：上一份里的已经作用于这条回复，扣掉一轮
    lore: (prev.lore ?? []).map((l) => ({ ...l, left: l.left - 1 })).filter((l) => l.left > 0),
    // 静音持续到取消；nextSpeaker 只管紧接着的那一轮，不往后带
    ...(prev.muted?.length ? { muted: [...prev.muted] } : {}),
  }
  const ctx: Ctx = {
    status: input.status ? cloneStatus(input.status) : null,
    vars: { ...input.vars },
    input,
    charName: '',
    ownerId: '',
    stageList: [],
    stages: state.stages!,
  }
  const out = {
    state,
    says: [] as FlowOutput['says'],
    flags: { status: false, vars: false },
    moves: [] as string[],
  }
  const fired: string[] = []
  const done = new Set<string>()
  /** 每个来源每条回复最多沿连线走一步：一轮剧情只推进一格 */
  const hopped = new Set<string>()
  const configs = input.sources.map((src) => sanitizeFlow(src.config))

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let progressed = false
    for (const [si, src] of input.sources.entries()) {
      const cfg = configs[si]!
      ctx.charName = src.charName
      ctx.ownerId = src.ownerId
      ctx.stageList = cfg.stages ?? []
      for (const r of cfg.rules) {
        if (!r.enabled) continue
        const key = `${src.ownerId}:${r.id}`
        if (done.has(key) || !triggerDue(r, input.turn)) continue
        const ok = ruleTrue(r, ctx)
        // edge 与「上一条消息时」比，不与本轮前几遍比：连锁里途经的中间值不算一次跳变
        const wasTrue = prev.truth[key] === true
        state.truth[key] = ok
        if (!ok) continue
        let fire = false
        if (r.mode === 'once') fire = !(key in state.fired)
        else if (r.mode === 'edge') fire = !wasTrue
        else {
          const last = state.fired[key]
          fire = last === undefined || input.turn - last >= Math.max(0, r.cooldown ?? 0)
        }
        if (!fire) continue
        done.add(key)
        progressed = true
        state.fired[key] = input.turn
        fired.push(r.name || '未命名规则')
        for (const a of r.actions) runAction(a, key, ctx, out)
      }
      // 规则跑完再看阶段连线：规则改过的状态 / 变量能直接推动剧情
      if (ctx.stageList.length && !hopped.has(src.ownerId)) {
        const cur = currentStage(ctx.stageList, ctx, src.ownerId)
        const t = cur ? firstTrue(cur.transitions, ctx) : undefined
        if (t && moveStage(ctx, t.to, out.moves)) {
          hopped.add(src.ownerId)
          progressed = true
        }
      }
    }
    if (!progressed) break
  }
  // 没有任何阶段记录就不留空对象，保持运行态干净
  if (!Object.keys(state.stages!).length) delete state.stages
  if (!state.lore?.length) delete state.lore
  if (!state.muted?.length) delete state.muted

  const log = [...fired, ...out.moves.map((m) => `阶段：${m}`)]
  if (log.length) state.log = log
  return {
    state,
    status: out.flags.status ? ctx.status : input.status,
    statusChanged: out.flags.status,
    vars: ctx.vars,
    varsChanged: out.flags.vars,
    says: out.says,
    fired,
    stageMoves: out.moves,
  }
}

/**
 * 本轮要注入的剧情引导：上一份运行态里还在生效的规则引导 + 每个来源当前阶段的常驻引导。
 * 阶段引导里的 {{char}} 按来源替换（演绎成员卡 = 成员本人），{{user}} 留给 builder 统一替换。
 */
export function guideBlock(
  state: FlowState | null | undefined,
  sources: Pick<FlowSourceInput, 'ownerId' | 'config' | 'charName'>[] = [],
): string {
  const lines = (state?.guides ?? []).map((g) => g.text)
  for (const src of sources) {
    const stages = sanitizeFlow(src.config).stages ?? []
    const st = currentStage(stages, state, src.ownerId)
    const text = st?.guide?.trim()
    if (!st || !text) continue
    const named = text.replace(/\{\{char\}\}/gi, src.charName)
    lines.push(`【当前阶段：${st.name || '未命名'}】${named}`)
  }
  if (!lines.length) return ''
  return [
    '【剧情引导】接下来的回复请自然地体现以下发展，不要直接复述这段说明：',
    ...lines.map((t) => `- ${t}`),
  ].join('\n')
}

// ── 收敛：配置来自角色卡导入 / 备份，逐项校验 ──
const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains']
const SOURCES = ['person', 'scene', 'var', 'turn', 'reply', 'stage']
const ACTIONS = [
  'guide',
  'say',
  'setStatus',
  'setVar',
  'setStage',
  'activateLore',
  'nextSpeaker',
  'mute',
  'unmute',
  'image',
]
const MODES = ['once', 'edge', 'always']
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function sanitizeConditions(raw: unknown): FlowCondition[] {
  return (Array.isArray(raw) ? raw : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .filter((c) => SOURCES.includes(str(c['source'])) && OPS.includes(str(c['op'])))
    .map((c) => ({
      id: str(c['id']) || crypto.randomUUID(),
      source: str(c['source']) as FlowCondition['source'],
      ...(str(c['who']) ? { who: str(c['who']) } : {}),
      ...(str(c['key']) ? { key: str(c['key']) } : {}),
      op: str(c['op']) as FlowCondition['op'],
      value: str(c['value']),
    }))
}

function sanitizeStages(raw: unknown): FlowStage[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: FlowStage[] = []
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const r = x as Record<string, unknown>
    const id = str(r['id'])
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: str(r['name']),
      ...(str(r['guide']) ? { guide: str(r['guide']) } : {}),
      transitions: (Array.isArray(r['transitions']) ? r['transitions'] : [])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => ({
          id: str(t['id']) || crypto.randomUUID(),
          to: str(t['to']),
          match: t['match'] === 'any' ? ('any' as const) : ('all' as const),
          conditions: sanitizeConditions(t['conditions']),
        })),
    })
  }
  // 连线指向已删除的阶段、或指向自己：丢掉
  for (const st of out) {
    st.transitions = st.transitions.filter((t) => t.to !== st.id && seen.has(t.to))
  }
  return out
}

/** 节点坐标：只留有限数字，丢掉任何别的东西 */
function sanitizeLayout(raw: unknown): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as { x?: unknown; y?: unknown } | null
    const x = p?.x
    const y = p?.y
    if (
      k &&
      typeof x === 'number' &&
      typeof y === 'number' &&
      Number.isFinite(x) &&
      Number.isFinite(y)
    ) {
      out[k] = { x: Math.round(x), y: Math.round(y) }
    }
  }
  return out
}

export function sanitizeFlow(raw: unknown): FlowConfig {
  const obj = raw as { rules?: unknown; stages?: unknown; layout?: unknown } | undefined
  const stages = sanitizeStages(obj?.stages)
  const layout = sanitizeLayout(obj?.layout)
  const extra = {
    ...(stages.length ? { stages } : {}),
    ...(Object.keys(layout).length ? { layout } : {}),
  }
  const rules = obj?.rules
  if (!Array.isArray(rules)) return { rules: [], ...extra }
  const seen = new Set<string>()
  const out: FlowRule[] = []
  for (const x of rules) {
    if (!x || typeof x !== 'object') continue
    const r = x as Record<string, unknown>
    const id = str(r['id'])
    if (!id || seen.has(id)) continue
    seen.add(id)
    const trig = (r['trigger'] ?? {}) as Record<string, unknown>
    const n = num(trig['n'])
    const cd = num(r['cooldown'])
    out.push({
      id,
      name: str(r['name']),
      enabled: r['enabled'] !== false,
      trigger:
        trig['kind'] === 'everyN'
          ? { kind: 'everyN', n: Math.max(1, Math.round(n ?? 1)) }
          : { kind: 'afterReply' },
      match: r['match'] === 'any' ? 'any' : 'all',
      conditions: sanitizeConditions(r['conditions']),
      mode: MODES.includes(str(r['mode'])) ? (str(r['mode']) as FlowRule['mode']) : 'once',
      ...(cd !== undefined ? { cooldown: Math.max(0, Math.round(cd)) } : {}),
      actions: (Array.isArray(r['actions']) ? r['actions'] : [])
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .filter((a) => ACTIONS.includes(str(a['kind'])))
        .map((a) => {
          const turns = num(a['turns'])
          const mode = str(a['mode'])
          return {
            id: str(a['id']) || crypto.randomUUID(),
            kind: str(a['kind']) as FlowAction['kind'],
            ...(str(a['text']) ? { text: str(a['text']) } : {}),
            ...(turns !== undefined ? { turns: Math.max(1, Math.round(turns)) } : {}),
            ...(str(a['speaker']) ? { speaker: str(a['speaker']) } : {}),
            ...(str(a['who']) ? { who: str(a['who']) } : {}),
            ...(str(a['key']) ? { key: str(a['key']) } : {}),
            ...(['set', 'add', 'push', 'pull'].includes(mode)
              ? { mode: mode as NonNullable<FlowAction['mode']> }
              : {}),
            ...(str(a['value']) ? { value: str(a['value']) } : {}),
            ...(str(a['stage']) ? { stage: str(a['stage']) } : {}),
            ...(str(a['book']) ? { book: str(a['book']) } : {}),
            ...(num(a['uid']) !== undefined ? { uid: Math.round(num(a['uid'])!) } : {}),
          }
        }),
    })
  }
  return { rules: out, ...extra }
}

/** 这份配置有没有任何会生效的内容（规则或阶段） */
export function hasFlow(cfg: FlowConfig | undefined): boolean {
  const c = sanitizeFlow(cfg)
  return c.rules.length > 0 || (c.stages?.length ?? 0) > 0
}

/** 最新运行态：倒序第一条带 flow 的消息 */
export function latestFlowState(messages: readonly ChatMessage[]): FlowState | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const f = messages[i]!.extra?.flow
    if (f) return f
  }
  return null
}

/** AI 回复条数（固定台词不算一轮） */
export function aiTurnCount(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => !m.is_user && !m.is_system && !m.extra?.flowSay).length
}

/** 本轮要强制激活的世界书条目键（与世界书引擎一致：`${书 id}.${uid}`） */
export function loreKeys(state: FlowState | null | undefined): string[] {
  return (state?.lore ?? []).map((l) => `${l.book}.${l.uid}`)
}
