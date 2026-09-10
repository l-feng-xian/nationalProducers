/**
 * 关系图谱 → 提示词文本（需求 3）。
 * 这是 SillyTavern 没有的自研功能。
 */

import type { GroupRelation } from '@/types/group'

export interface RenderRelationsInput {
  relations: GroupRelation[]
  /** characterId → 角色名 */
  nameOf: Map<string, string>
  /** 支持 {{from}} {{to}} {{label}} {{desc}} */
  template: string
}

/**
 * 有向边逐条渲染。A→B 与 B→A 是两条独立的边，各自成行，
 * 因此「A 暗恋 B / B 把 A 当妹妹」这种不对称关系能被完整表达。
 */
export function renderRelations(input: RenderRelationsInput): string {
  const lines: string[] = []
  for (const e of input.relations) {
    const from = input.nameOf.get(e.from)
    const to = input.nameOf.get(e.to)
    if (!from || !to) continue // 成员已被移除
    const label = e.label.trim()
    if (!label) continue
    const desc = (e.desc ?? '').trim()
    const line = input.template
      .replace(/\{\{from\}\}/gi, from)
      .replace(/\{\{to\}\}/gi, to)
      .replace(/\{\{label\}\}/gi, label)
      .replace(/\{\{desc\}\}/gi, desc)
    lines.push(desc && !input.template.includes('{{desc}}') ? `- ${line}（${desc}）` : `- ${line}`)
  }
  return lines.join('\n')
}
