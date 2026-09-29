/**
 * 「用户和每个角色都必须有记录」的两半：
 *  - initialFor：还没有快照时，把群聊 / 角色卡上配的初始状态拼成一份；
 *  - completeStatus：模型漏写了某人（或某人的某个字段）时，沿用上一份。
 * 以及生成链路与侧栏共用的 resolveStatusContext —— 两边必须看到同一套字段与名单。
 *
 * 纯 service：不 import vue/pinia，verify-status.ts 直接在 node 里跑断言。
 */

import type { Character } from '@/types/character'
import type { ChatMessage } from '@/types/chat'
import {
  fieldsFor,
  type CharacterStatusConfig,
  type StatusData,
  type StatusField,
  type StatusPerson,
  type StatusSettings,
} from '@/types/status'
import { configInitialStatus, latestStatus, resolveStatusFields } from './template'

export interface StatusContext {
  /** 本轮生效的字段（已过滤停用） */
  fields: StatusField[]
  /** 快照里必须出现的人：角色们 + 用户（用户排最后） */
  required: string[]
  userName: string
  /** 最新快照；没有时是拼好的初始状态；都没有为 null */
  current: StatusData | null
  /** current 来自初始状态而不是某条消息 */
  fromInitial: boolean
}

export function resolveStatusContext(args: {
  settings: StatusSettings
  messages: readonly ChatMessage[]
  userName: string
  /** 1v1：本会话的角色；群聊：不传 */
  char?: Character | null
  /** 群聊：成员（按群聊成员顺序）与群聊覆盖配置 */
  members?: Character[]
  groupConfig?: CharacterStatusConfig | null
}): StatusContext {
  const isGroup = !!args.members
  const chars = isGroup ? args.members! : args.char ? [args.char] : []
  const override = isGroup ? args.groupConfig : args.char?.data.extensions.np?.status
  const fields = resolveStatusFields(args.settings, override)
  const required = [...chars.map((c) => c.data.name), args.userName]
  const latest = latestStatus(args.messages)?.status.data ?? null
  const initial = latest ? null : initialFor({ isGroup, chars, groupConfig: args.groupConfig })
  return {
    fields,
    required,
    userName: args.userName,
    current: latest ?? initial,
    fromInitial: !latest && !!initial,
  }
}

/**
 * 初始状态。
 * 1v1：角色卡上的整份。
 * 群聊：以群聊配的为底；群聊没配到的成员，从**那位成员自己的角色卡**里取出他本人那一条补上
 * （角色卡上的场景与其他人物不带进群聊 —— 那是为单人剧情写的）。
 */
export function initialFor(args: {
  isGroup: boolean
  chars: Character[]
  groupConfig?: CharacterStatusConfig | null
}): StatusData | null {
  if (!args.isGroup) return configInitialStatus(args.chars[0]?.data.extensions.np?.status)
  const base = configInitialStatus(args.groupConfig) ?? { scene: {}, people: [] }
  // 群聊页的初始状态表单会把每个成员都列出来；一个字段都没填的等于「留空」，要回落到角色卡
  const people = base.people.filter((p) => Object.keys(p.fields).length)
  for (const c of args.chars) {
    const name = c.data.name
    if (people.some((p) => p.name === name)) continue
    const own = configInitialStatus(c.data.extensions.np?.status)?.people.find(
      (p) => p.name === name,
    )
    if (own) people.push(own)
  }
  const out = { scene: base.scene, people }
  return Object.keys(out.scene).length || people.length ? out : null
}

/**
 * 补全模型本轮的快照：
 *  - required 里漏掉的人整条沿用 prev（prev 也没有就给空条目），标 carried；
 *  - 写了的人，模板字段缺失而 prev 里有值的，逐字段沿用。
 * 返回新对象，不改入参。
 */
export function completeStatus(
  next: StatusData,
  prev: StatusData | null,
  opts: { required: string[]; fields: StatusField[]; userName: string },
): StatusData {
  const before = new Map((prev?.people ?? []).map((p) => [p.name, p]))
  const people: StatusPerson[] = next.people.map((p) => {
    const old = before.get(p.name)
    if (!old) return { name: p.name, fields: { ...p.fields } }
    const fields = { ...p.fields }
    for (const f of fieldsFor(opts.fields, p.name === opts.userName)) {
      if (!(f.key in fields) && f.key in old.fields) fields[f.key] = copy(old.fields[f.key]!)
    }
    return { name: p.name, fields }
  })
  for (const name of opts.required) {
    if (people.some((p) => p.name === name)) continue
    const old = before.get(name)
    people.push({ name, fields: old ? copyFields(old.fields) : {}, carried: true })
  }

  const scene = { ...next.scene }
  for (const f of opts.fields) {
    if (f.scope !== 'scene' || f.key in scene) continue
    const v = prev?.scene[f.key]
    if (v !== undefined) scene[f.key] = copy(v)
  }
  return { scene, people }
}

function copy<T extends string | string[]>(v: T): T {
  return (Array.isArray(v) ? [...v] : v) as T
}
function copyFields(r: StatusPerson['fields']): StatusPerson['fields'] {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, copy(v)]))
}
