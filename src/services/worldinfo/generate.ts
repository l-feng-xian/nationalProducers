/**
 * AI 生成世界书条目。
 *
 * 两种模式：
 *  - character：以角色的基础信息（名字 / 简介 / 性格 / 场景）为底，加上用户的补充描述，
 *    生成「角色所处世界」的条目。刻意要求**不复述角色卡**：角色卡每轮都在提示词里，
 *    再写一遍只会重复占用 token。
 *  - global：只用用户描述，生成可被多个角色共用的世界观条目。
 *
 * 生成结果只是草稿，由对话框让用户勾选后再落库。纯 TS，不 import vue/pinia。
 */

import type { Character } from '@/types/character'
import { thinkingField, type ProviderConfig } from '@/types/provider'
import type { ProviderSettings } from '@/types/settings'
import { DEFAULT_WI_ENTRY, world_info_position, type WorldInfoEntry } from '@/types/worldinfo'
import { chatOnce } from '@/services/provider/openaiCompatible'
import { stripThink } from '@/services/memory/stateCard'
import { estimateMessagesTokens } from '@/services/tokens'

export type WorldGenMode = 'character' | 'global'

export interface GeneratedEntry {
  title: string
  keys: string[]
  content: string
  /** 常驻：不靠关键词、每轮都注入。只该用于极少数全局基调 */
  constant: boolean
}

export interface GeneratedWorldBook {
  name: string
  entries: GeneratedEntry[]
}

const MAX_ENTRIES = 40
const MAX_DESC = 3000

const SYSTEM_PROMPT = `你是一位世界观设定师，为角色扮演聊天编写「世界书」。世界书由若干条目组成：当对话里出现条目的关键词时，这条设定才会被插入提示词，让模型知道相关背景。
只输出一个完整 JSON 对象，不要解释、Markdown 代码块或 JSON 以外的内容：
{
  "name": "世界书名称，10字以内",
  "entries": [
    {
      "title": "条目标题，如地名、组织名、人物名、概念名",
      "keys": ["触发关键词1", "别称或简称"],
      "content": "该条目的设定正文，客观、具体、可直接供模型参考，60~200字",
      "constant": false
    }
  ]
}
编写要求：
1. 生成 8~15 个条目，覆盖地点、势力组织、重要人物（NPC）、历史事件、规则体系（如魔法/科技/社会制度）、特殊物品等，按设定需要取舍。
2. 每条只讲一件事，条目之间不要重复；正文写设定事实，不写剧情对白，不替用户做决定。
3. keys 写对话里真的会出现的词：名称、简称、别称，2~4 个，不要用「的」「他」这类泛词。
4. constant 只给 1~2 条全局基调（如世界总体背景、时代）设为 true，其余一律 false —— 常驻条目每轮都会占用上下文。
5. 遵循用户指定的语言与风格；未指定时使用中文。
JSON 字符串中的换行必须转义为 \\n，字符串内的双引号必须转义。`

const CHARACTER_RULE = `
这是某个角色专属的世界书。角色卡本身每轮都会发给模型，所以**不要**再写一条介绍这个角色本人的条目，也不要复述角色简介；要写的是他/她所处的世界：去过的地方、所属的组织、身边的人、经历过的事、会用到的物品和规则。条目正文里提到该角色时直接写角色名。`

function clip(s: string, n: number): string {
  const t = s.trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/** 角色基础信息 → 提示词里的一段设定摘要 */
export function characterBrief(c: Character): string {
  const d = c.data
  return [
    `角色名：${d.name}`,
    d.description.trim() && `简介：${clip(d.description, 1200)}`,
    d.personality.trim() && `性格：${clip(d.personality, 500)}`,
    d.scenario.trim() && `场景：${clip(d.scenario, 600)}`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function buildWorldGenMessages(input: {
  mode: WorldGenMode
  description: string
  character?: Character
  existingTitles?: string[]
}) {
  const parts: string[] = []
  if (input.mode === 'character' && input.character) {
    parts.push(`【角色基础信息】\n${characterBrief(input.character)}`)
  }
  const desc = input.description.trim()
  if (desc) parts.push(`【用户的补充描述】\n${desc}`)
  const titles = (input.existingTitles ?? []).filter((t) => t.trim()).slice(0, 80)
  if (titles.length) {
    parts.push(`【已有条目，不要重复】\n${titles.join('、')}`)
  }
  return [
    {
      role: 'system' as const,
      content: SYSTEM_PROMPT + (input.mode === 'character' ? CHARACTER_RULE : ''),
    },
    { role: 'user' as const, content: parts.join('\n\n') },
  ]
}

function strList(v: unknown): string[] {
  if (typeof v === 'string') return v.split(/[,，、]/)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 解析模型输出。容错：顶层直接是数组、字段名用 key/comment 等 ST 写法 */
export function parseGeneratedWorldBook(raw: string): GeneratedWorldBook {
  const text = stripThink(raw)
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  const isArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart)
  const start = isArray ? arrStart : objStart
  const end = isArray ? text.lastIndexOf(']') : text.lastIndexOf('}')
  let value: unknown
  try {
    value = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
  } catch {
    throw new Error('模型返回的世界书内容不完整或格式错误，请重试。')
  }
  const obj = (Array.isArray(value) ? { entries: value } : value) as Record<string, unknown>
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj['entries'])) {
    throw new Error('模型没有返回条目列表，请重试。')
  }

  const seen = new Set<string>()
  const entries: GeneratedEntry[] = []
  for (const item of obj['entries'] as unknown[]) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    const title = String(e['title'] ?? e['comment'] ?? e['name'] ?? '').trim()
    const content = typeof e['content'] === 'string' ? e['content'].trim() : ''
    if (!content) continue
    const keys = [
      ...new Set(
        strList(e['keys'] ?? e['key'])
          .map((k) => k.trim())
          .filter(Boolean),
      ),
    ]
    const constant = e['constant'] === true
    // 非常驻又没有关键词的条目永远不会被触发：用标题兜底
    if (!constant && !keys.length && title) keys.push(title)
    if (!constant && !keys.length) continue
    const dedupe = (title || content.slice(0, 20)).toLowerCase()
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    entries.push({ title: title || keys[0] || '未命名条目', keys, content, constant })
    if (entries.length >= MAX_ENTRIES) break
  }
  if (!entries.length) throw new Error('模型没有返回可用的条目，请重试。')
  const name = typeof obj['name'] === 'string' ? obj['name'].trim().slice(0, 30) : ''
  return { name, entries }
}

/** 生成条目 → 落库用的完整 WorldInfoEntry（其余字段取默认值） */
export function toWorldEntry(g: GeneratedEntry, uid: number): WorldInfoEntry {
  return {
    ...structuredClone(DEFAULT_WI_ENTRY),
    uid,
    comment: g.title,
    key: g.constant ? [] : g.keys,
    content: g.content,
    constant: g.constant,
    position: world_info_position.before,
  }
}

export async function generateWorldBook(input: {
  mode: WorldGenMode
  description: string
  character?: Character
  existingTitles?: string[]
  provider: ProviderSettings
  apiKey: string
  signal: AbortSignal
}): Promise<GeneratedWorldBook> {
  if (input.mode === 'character' && !input.character) throw new Error('请先选择关联的角色。')
  if (input.mode === 'global' && !input.description.trim()) {
    throw new Error('请先描述你想要的世界观。')
  }
  if (input.description.length > MAX_DESC) {
    throw new Error(`描述请控制在 ${MAX_DESC} 字以内。`)
  }
  const p = input.provider
  if (!p.baseUrl || !p.model) throw new Error('请先在模型管理中配置并选择模型服务。')

  const messages = buildWorldGenMessages(input)
  // 十几条设定正文需要独立的输出预算，不沿用聊天回复上限
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
  return parseGeneratedWorldBook(raw)
}
