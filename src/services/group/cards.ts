/**
 * 演绎的角色卡注入。对齐 SillyTavern group-chats.js getGroupCharacterCardsLazy。
 *
 * SWAP(0)             只用当前发言者的卡（默认，最省 token）
 * APPEND(1)           拼接所有**未静音**成员的卡
 * APPEND_DISABLED(2)  拼接全部成员的卡（含静音）
 *
 * 静音规则：跳过静音成员，**除非**它就是当前发言者，或模式为 APPEND_DISABLED。
 */

import { group_generation_mode, type Group } from '@/types/group'
import type { Character } from '@/types/character'

export interface JoinedCards {
  description: string
  personality: string
  scenario: string
  mesExample: string
}

const FIELD_LABEL = {
  description: '简介',
  personality: '性格',
  scenario: '场景',
  mesExample: '对话示例',
} as const

type FieldKey = keyof typeof FIELD_LABEL

function fieldOf(c: Character, f: FieldKey): string {
  switch (f) {
    case 'description':
      return c.data.description
    case 'personality':
      return c.data.personality
    case 'scenario':
      return c.data.scenario
    case 'mesExample':
      return c.data.mes_example
  }
}

/**
 * 返回拼接后的卡片字段；SWAP 模式返回 null 表示「走单角色路径」。
 *
 * @param sub 宏展开函数，需支持传入 charName 覆盖 {{char}}
 */
export function joinGroupCards(
  group: Group,
  members: Character[],
  speakerId: string,
  sub: (text: string, charName: string) => string,
): JoinedCards | null {
  if (group.generation_mode === group_generation_mode.SWAP) return null

  const collect = (f: FieldKey): string => {
    const parts: string[] = []
    for (const c of members) {
      const muted = group.disabled_members.includes(c.id)
      if (
        muted &&
        c.id !== speakerId &&
        group.generation_mode !== group_generation_mode.APPEND_DISABLED
      ) {
        continue
      }
      let value = fieldOf(c, f).trim()
      if (!value) continue
      // 对话示例每段都要有自己的 <START>
      if (f === 'mesExample' && !value.startsWith('<START>')) value = `<START>\n${value}`

      const label = FIELD_LABEL[f]
      const prefix = transform(group.generation_mode_join_prefix, label, c.data.name, sub)
      const suffix = transform(group.generation_mode_join_suffix, label, c.data.name, sub)
      // 卡片正文里的 {{char}} 应解析为**该成员自己**，不是当前发言者
      parts.push(`${prefix}${sub(value, c.data.name)}${suffix}`)
    }
    return parts.filter(Boolean).join('\n')
  }

  return {
    description: collect('description'),
    personality: collect('personality'),
    scenario: collect('scenario'),
    mesExample: collect('mesExample'),
  }
}

/** 前后缀支持 <FIELDNAME> 占位与宏 */
function transform(
  tpl: string,
  fieldLabel: string,
  charName: string,
  sub: (text: string, charName: string) => string,
): string {
  if (!tpl) return ''
  return sub(tpl.replace(/<FIELDNAME>/gi, fieldLabel), charName)
}

/**
 * 兜底截断：模型有时会替其他角色续写。
 * 一旦输出里出现 `\n其他成员名:`，就从那里砍掉。
 */
export function cleanGroupMessage(text: string, speakerName: string, allNames: string[]): string {
  let out = text
  for (const name of allNames) {
    if (name === speakerName) continue
    const re = new RegExp(`(^|\\n)\\s*${escapeRegex(name)}\\s*[:：]`)
    const m = out.match(re)
    if (m && m.index !== undefined) out = out.slice(0, m.index)
  }
  return out.trimEnd()
}

/** 其他成员名作为 stop sequence，从源头压制串台 */
export function groupStopStrings(speakerName: string, allNames: string[]): string[] {
  return allNames.filter((n) => n && n !== speakerName).map((n) => `\n${n}:`)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
