/**
 * AI 生成流程控制草稿：用户描述一条剧情线，模型产出「剧情阶段 + 规则」。
 *
 * 模型只写名字，不写 id：阶段之间、setStage 动作、「当前阶段」条件都用阶段名互指，
 * 这里统一换成新 id，再交给 sanitizeFlow 收敛 —— 与导入的角色卡走同一道校验。
 * 生成结果只是草稿，由对话框预览后再落进配置。纯 TS，不 import vue/pinia。
 */

import type { FlowAction, FlowCondition, FlowConfig, FlowRule, FlowStage } from '@/types/flow'
import type { StatusField, StatusScope } from '@/types/status'
import { thinkingField, type ProviderConfig } from '@/types/provider'
import type { ProviderSettings } from '@/types/settings'
import { chatOnce } from '@/services/provider/openaiCompatible'
import { stripThink } from '@/services/memory/stateCard'
import { estimateMessagesTokens } from '@/services/tokens'
import { sanitizeFlow } from './engine'

export interface SuggestedField {
  key: string
  scope: StatusScope
  min?: number
  max?: number
  hint?: string
}

export interface GeneratedFlow {
  config: FlowConfig
  /** 模型建议新增的数值状态字段（规则里用到、但当前字段模板里没有） */
  suggestedFields: SuggestedField[]
  /** 条件 / 动作引用了、但既不在字段模板也不在建议里的字段名 */
  unknownKeys: string[]
}

const MAX_STAGES = 8
const MAX_RULES = 15
const MAX_DESC = 3000

const SYSTEM_PROMPT = `你是一位互动剧情设计师，为角色扮演聊天设计「流程控制」：把剧情分成若干阶段，并写出由状态数值驱动的规则。
只输出一个完整 JSON 对象，不要解释、Markdown 代码块或 JSON 以外的内容：
{
  "suggestedFields": [{ "key": "好感度", "scope": "char", "min": 0, "max": 100, "hint": "对{{user}}的好感" }],
  "stages": [
    { "name": "相识", "guide": "身处该阶段时每轮给模型的剧情引导", "transitions": [
      { "to": "熟悉", "match": "all", "conditions": [{ "source": "person", "who": "{{char}}", "key": "好感度", "op": "gte", "value": "30" }] }
    ] }
  ],
  "rules": [
    { "name": "规则名", "mode": "once", "match": "all",
      "conditions": [{ "source": "stage", "op": "eq", "value": "告白" }],
      "actions": [{ "kind": "guide", "text": "…", "turns": 2 }] }
  ]
}
字段说明：
- condition.source：person（某人的状态字段，who 写 {{char}}/{{user}}/人名）、scene（场景字段）、var（会话变量）、turn（AI 回复条数）、reply（本轮回复正文）、stage（当前阶段，value 写阶段名）。
- condition.op：eq ne gt gte lt lte contains notContains。value 一律写成字符串。
- rule.mode：once（只触发一次）、edge（每次从不成立变为成立）、always（每次成立都触发，可加 cooldown）。
- action.kind：guide（引导剧情，text + turns，推荐）、say（原样插入台词，text，可选 speaker）、setStatus（who 写 scene 或人名，key，mode 为 set/add/push/pull，value）、setVar（key，mode 为 set/add，value）、setStage（stage 写阶段名）。
编写要求：
1. 3~6 个阶段，第一个是初始阶段；每个阶段的 guide 写这一段剧情里角色的状态与倾向，40~120 字，不写对白。
2. 阶段出口必须有条件；条件优先用数值字段（大于、小于），不要用无法判断的文本。
3. 规则 3~8 条，多数用 guide 引导剧情；say 只用于关键台词；不要替用户做决定。
4. 只使用下面列出的已有字段；需要新的数值字段时写进 suggestedFields（scope 为 char/user/person/scene），不要在规则里用未列出也未建议的字段。
5. 遵循用户指定的语言与风格；未指定时使用中文。
JSON 字符串中的换行必须转义为 \\n，字符串内的双引号必须转义。`

const GROUP_RULE = `
这是演绎的流程：{{char}} 指本轮发言者。还可以用 nextSpeaker（who 写成员名，指定下一位发言者）、mute / unmute（who 写成员名，本会话内静音 / 取消静音）。`

function fieldLine(f: StatusField): string {
  const kind = f.kind === 'number' ? '数值' : f.kind === 'list' ? '列表' : '文本'
  const range =
    f.kind === 'number' && (f.min !== undefined || f.max !== undefined)
      ? `，${f.min ?? '-∞'}~${f.max ?? '∞'}`
      : ''
  return `- ${f.key}（${kind}${range}，${f.scope === 'scene' ? '场景' : '人物'}）`
}

export function buildFlowGenMessages(input: {
  description: string
  fields: StatusField[]
  brief?: string
  people?: string[]
  isGroup?: boolean
}) {
  const parts: string[] = []
  if (input.brief?.trim()) parts.push(`【角色基础信息】\n${input.brief.trim()}`)
  if (input.people?.length) parts.push(`【演绎成员】\n${input.people.join('、')}`)
  parts.push(
    input.fields.length
      ? `【已有状态字段】\n${input.fields.map(fieldLine).join('\n')}`
      : '【已有状态字段】\n（无，需要的数值字段请写进 suggestedFields）',
  )
  parts.push(`【用户想要的剧情线】\n${input.description.trim()}`)
  return [
    { role: 'system' as const, content: SYSTEM_PROMPT + (input.isGroup ? GROUP_RULE : '') },
    { role: 'user' as const, content: parts.join('\n\n') },
  ]
}

const OP_ALIAS: Record<string, FlowCondition['op']> = {
  '=': 'eq',
  '==': 'eq',
  '!=': 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
}
const SCOPES: StatusScope[] = ['scene', 'person', 'char', 'user']
const str = (v: unknown) =>
  typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''
const fin = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : []

/** 解析模型输出 → 带新 id 的配置。阶段名互指在这里换成 id，指向不存在阶段的引用直接丢掉 */
export function parseGeneratedFlow(raw: string, fields: StatusField[]): GeneratedFlow {
  const text = stripThink(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
  } catch {
    throw new Error('模型返回的流程内容不完整或格式错误，请重试。')
  }
  if (!obj || typeof obj !== 'object') throw new Error('模型没有返回流程，请重试。')

  const suggestedFields: SuggestedField[] = []
  for (const f of arr(obj['suggestedFields'])) {
    const key = str(f['key'])
    if (!key || fields.some((x) => x.key === key) || suggestedFields.some((x) => x.key === key))
      continue
    const scope = SCOPES.includes(f['scope'] as StatusScope) ? (f['scope'] as StatusScope) : 'char'
    const min = fin(f['min'])
    const max = fin(f['max'])
    suggestedFields.push({
      key,
      scope,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(str(f['hint']) ? { hint: str(f['hint']) } : {}),
    })
  }

  // 阶段名 → 新 id（同名只认第一个）
  const stageRaw = arr(obj['stages']).slice(0, MAX_STAGES)
  const idByName = new Map<string, string>()
  for (const s of stageRaw) {
    const name = str(s['name'])
    if (name && !idByName.has(name)) idByName.set(name, crypto.randomUUID())
  }

  const toCond = (c: Record<string, unknown>): FlowCondition | null => {
    const op = OP_ALIAS[str(c['op'])] ?? (str(c['op']) as FlowCondition['op'])
    const source = str(c['source']) as FlowCondition['source']
    let value = str(c['value'])
    if (source === 'stage') {
      const id = idByName.get(value)
      if (!id) return null
      value = id
    }
    return {
      id: crypto.randomUUID(),
      source,
      ...(str(c['who']) ? { who: str(c['who']) } : {}),
      ...(str(c['key']) ? { key: str(c['key']) } : {}),
      op,
      value,
    }
  }
  const conds = (v: unknown) =>
    arr(v)
      .map(toCond)
      .filter((c): c is FlowCondition => !!c)

  const stages: FlowStage[] = []
  for (const s of stageRaw) {
    const name = str(s['name'])
    const id = idByName.get(name)
    if (!id || stages.some((x) => x.id === id)) continue
    stages.push({
      id,
      name,
      ...(str(s['guide']) ? { guide: str(s['guide']) } : {}),
      transitions: arr(s['transitions'])
        .map((t) => ({
          id: crypto.randomUUID(),
          to: idByName.get(str(t['to'])) ?? '',
          match: t['match'] === 'any' ? ('any' as const) : ('all' as const),
          conditions: conds(t['conditions']),
        }))
        .filter((t) => t.to && t.to !== id && t.conditions.length),
    })
  }

  const rules: FlowRule[] = arr(obj['rules'])
    .slice(0, MAX_RULES)
    .map((r, i) => {
      const cd = fin(r['cooldown'])
      return {
        id: crypto.randomUUID(),
        name: str(r['name']) || `规则 ${i + 1}`,
        enabled: true,
        trigger: { kind: 'afterReply' as const },
        match: r['match'] === 'any' ? ('any' as const) : ('all' as const),
        conditions: conds(r['conditions']),
        mode: (['once', 'edge', 'always'].includes(str(r['mode']))
          ? str(r['mode'])
          : 'once') as FlowRule['mode'],
        ...(cd !== undefined ? { cooldown: cd } : {}),
        actions: arr(r['actions']).map((a) => {
          const turns = fin(a['turns'])
          const stage = a['kind'] === 'setStage' ? idByName.get(str(a['stage'])) : undefined
          return {
            id: crypto.randomUUID(),
            kind: str(a['kind']) as FlowAction['kind'],
            ...(str(a['text']) ? { text: str(a['text']) } : {}),
            ...(turns !== undefined ? { turns } : {}),
            ...(str(a['speaker']) ? { speaker: str(a['speaker']) } : {}),
            ...(str(a['who']) ? { who: str(a['who']) } : {}),
            ...(str(a['key']) ? { key: str(a['key']) } : {}),
            ...(str(a['mode']) ? { mode: str(a['mode']) as NonNullable<FlowAction['mode']> } : {}),
            ...(str(a['value']) ? { value: str(a['value']) } : {}),
            ...(stage ? { stage } : {}),
          }
        }),
      }
    })

  // 统一走一遍收敛：非法来源 / 比较 / 动作、悬空的连线都在这里丢掉
  const config = sanitizeFlow({ rules, stages })
  if (!config.rules.length && !config.stages?.length) {
    throw new Error('模型没有返回可用的阶段或规则，请重试。')
  }

  const known = new Set([...fields.map((f) => f.key), ...suggestedFields.map((f) => f.key)])
  const used = [
    ...config.rules.flatMap((r) => r.conditions),
    ...(config.stages ?? []).flatMap((s) => s.transitions.flatMap((t) => t.conditions)),
  ]
    .filter((c) => c.source === 'person' || c.source === 'scene')
    .map((c) => c.key ?? '')
    .concat(
      config.rules.flatMap((r) =>
        r.actions.filter((a) => a.kind === 'setStatus').map((a) => a.key ?? ''),
      ),
    )
  const unknownKeys = [...new Set(used.filter((k) => k && !known.has(k)))]
  return { config, suggestedFields, unknownKeys }
}

export async function generateFlow(input: {
  description: string
  fields: StatusField[]
  brief?: string
  people?: string[]
  isGroup?: boolean
  provider: ProviderSettings
  apiKey: string
  signal: AbortSignal
}): Promise<GeneratedFlow> {
  if (!input.description.trim()) throw new Error('请先描述你想要的剧情线。')
  if (input.description.length > MAX_DESC) throw new Error(`描述请控制在 ${MAX_DESC} 字以内。`)
  const p = input.provider
  if (!p.baseUrl || !p.model) throw new Error('请先在模型管理中配置并选择模型服务。')

  const messages = buildFlowGenMessages(input)
  const remaining = Math.floor(p.contextWindow - estimateMessagesTokens(messages, 16) * 1.3 - 256)
  if (remaining < 1536) {
    throw new Error('当前模型的上下文窗口不足，请缩短描述或在模型管理中调整上下文窗口。')
  }
  const cfg: ProviderConfig = {
    baseUrl: p.baseUrl,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(p.proxyPrefix ? { proxyPrefix: p.proxyPrefix } : {}),
    headers: p.extraHeaders,
    ...thinkingField(p.thinking),
  }
  input.signal.throwIfAborted()
  const raw = await chatOnce(
    cfg,
    {
      model: p.model,
      messages,
      stream: false,
      temperature: p.temperature,
      maxTokens: Math.min(8192, remaining),
    },
    input.signal,
  )
  input.signal.throwIfAborted()
  return parseGeneratedFlow(raw, input.fields)
}
