/**
 * 角色卡导入 / 导出。
 *
 * 因为内部模型直接用 ST 原生字段名，这一层几乎是恒等映射 ——
 * 主要工作是把 v1 顶层字段回填进 `data`，以及补齐缺失字段。
 */

import { emptyCharacter, type Character, type CharacterDataV2 } from '@/types/character'

type Raw = Record<string, unknown>

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v ? [v] : []
  return v.filter((x): x is string => typeof x === 'string')
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 原始卡 JSON（v1 扁平 / v2 / v3 带 data）→ 本地 Character。
 * v2/v3 的 `data` 优先；缺的字段回落到 v1 顶层镜像。
 */
export function normalizeCard(raw: unknown, id: string): Character {
  const r = (raw ?? {}) as Raw
  const d = (r['data'] && typeof r['data'] === 'object' ? r['data'] : r) as Raw

  const pick = (k: string): unknown => (d[k] !== undefined ? d[k] : r[k])

  const c = emptyCharacter(id, str(pick('name'), '未命名角色'))
  const data: CharacterDataV2 = c.data
  data.name = str(pick('name'), '未命名角色')
  data.description = str(pick('description'))
  data.personality = str(pick('personality'))
  data.scenario = str(pick('scenario'))
  data.first_mes = str(pick('first_mes'))
  data.mes_example = str(pick('mes_example'))
  data.creator_notes = str(pick('creator_notes'), str(r['creatorcomment']))
  data.system_prompt = str(pick('system_prompt'))
  data.post_history_instructions = str(pick('post_history_instructions'))
  data.tags = strArr(pick('tags'))
  data.creator = str(pick('creator'))
  data.character_version = str(pick('character_version'))
  data.alternate_greetings = strArr(pick('alternate_greetings'))

  const ext = (d['extensions'] && typeof d['extensions'] === 'object' ? d['extensions'] : {}) as Raw
  data.extensions = {
    ...ext,
    talkativeness: num(ext['talkativeness'] ?? r['talkativeness'], 0.5),
    fav: ext['fav'] === true || r['fav'] === true || r['fav'] === 'true',
  }
  const dp = ext['depth_prompt']
  if (dp && typeof dp === 'object') {
    const p = dp as Raw
    const role = str(p['role'], 'system')
    data.extensions.depth_prompt = {
      prompt: str(p['prompt']),
      depth: num(p['depth'], 4),
      role: role === 'user' || role === 'assistant' ? role : 'system',
    }
  }
  // ST 的单本角色书书名，记下来供后续按名关联
  const world = str(ext['world'])
  if (world) data.extensions.world = world

  const book = d['character_book']
  if (book && typeof book === 'object') {
    data.character_book = book as CharacterDataV2['character_book']
  }

  c.fav = data.extensions.fav
  c.favIdx = c.fav ? 1 : 0
  return c
}

/** 导出为 v2 规范 JSON（同时写 v1 顶层镜像，最大化兼容性） */
export function characterToCardJson(c: Character): string {
  const d = c.data
  const card = {
    // v1 顶层镜像
    name: d.name,
    description: d.description,
    personality: d.personality,
    scenario: d.scenario,
    first_mes: d.first_mes,
    mes_example: d.mes_example,
    creatorcomment: d.creator_notes,
    tags: d.tags,
    talkativeness: d.extensions.talkativeness,
    fav: d.extensions.fav,
    // v2 规范
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: d,
  }
  return JSON.stringify(card, null, 2)
}

export async function exportCharacterJson(c: Character): Promise<Blob> {
  return new Blob([characterToCardJson(c)], { type: 'application/json' })
}
