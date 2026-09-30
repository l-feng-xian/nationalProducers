import type { CharacterDataV2 } from '@/types/character'
import { thinkingField, type ProviderConfig } from '@/types/provider'
import type { ProviderSettings } from '@/types/settings'
import { parseExampleBlocks, serializeExampleBlocks } from '@/utils/mesExample'
import { chatOnce } from '@/services/provider/openaiCompatible'
import { stripThink } from '@/services/memory/stateCard'
import { estimateMessagesTokens } from '@/services/tokens'

export type GeneratedCharacterData = Pick<
  CharacterDataV2,
  | 'name'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'first_mes'
  | 'alternate_greetings'
  | 'mes_example'
>

const TEXT_FIELDS = {
  name: '角色名',
  description: '角色简介',
  personality: '性格',
  scenario: '场景',
  first_mes: '开场白',
  mes_example: '对话示例',
} as const

const SYSTEM_PROMPT = `你是一位角色扮演创作者。根据用户的简短描述，创作一个设定连贯、有鲜明说话风格、可以直接开始对话的角色。
遵循用户指定的名字、身份、性格、世界观和语言；未指定时使用中文并补全合理细节。
只输出一个完整 JSON 对象，不要解释、Markdown 代码块或 JSON 以外的内容。使用以下字段：
{
  "name": "角色名",
  "description": "外貌、身份、背景、目标以及与用户的关系，约150字",
  "personality": "具体性格、喜好、弱点和说话风格，约80字",
  "scenario": "故事的时间、地点、当前处境和相遇缘由，约80字",
  "first_mes": "主开场白，包含动作、环境及角色台词，给用户留下回应空间，约120字",
  "alternate_greetings": ["另一个合理情境的开场白，约100字"],
  "mes_example": "<START>\\n{{user}}: 用户的话\\n{{char}}: 角色的回应\\n<START>\\n{{user}}: 另一种情境的话\\n{{char}}: 展现角色性格的回应"
}
所有字段必须完整且非空，alternate_greetings 是字符串数组。对话示例至少两组，每组由 <START> 开始，各自包含用户和角色的发言，使用 {{user}}: 和 {{char}}: 前缀。
开场白与对话示例要写出具体内容，不要复述字段说明。用 *动作描写* 表示动作。
开场白不要替用户发言或决定用户的行动。称呼当前角色和用户时可使用 {{char}} 和 {{user}} 宏。
JSON 字符串中的换行必须转义为 \\n，字符串内的双引号必须转义。`

/** 只提取可编辑的创作字段，模型无法修改角色 ID、图片或高级配置。 */
export function parseGeneratedCharacter(raw: string): GeneratedCharacterData {
  const text = stripThink(raw)
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let value: unknown
  try {
    value = JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text)
  } catch {
    throw new Error('模型返回的角色内容不完整或格式错误，请重试。')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('模型未返回有效的角色资料，请重试。')
  }
  // 兼容服务自行包装成标准 V2 角色卡的情况。
  const object = value as Record<string, unknown>
  const data =
    object.data && typeof object.data === 'object' && !Array.isArray(object.data)
      ? (object.data as Record<string, unknown>)
      : object
  const fields = {} as Omit<GeneratedCharacterData, 'alternate_greetings'>
  for (const key of Object.keys(TEXT_FIELDS) as (keyof typeof TEXT_FIELDS)[]) {
    const field = data[key]
    if (typeof field !== 'string' || !field.trim()) {
      throw new Error(`模型返回的${TEXT_FIELDS[key]}缺失或格式错误，请重试。`)
    }
    fields[key] = field.trim()
  }
  const alternates = data.alternate_greetings ?? []
  if (!Array.isArray(alternates) || alternates.some((item) => typeof item !== 'string')) {
    throw new Error('模型返回的备选开场白格式错误，请重试。')
  }
  const examples = parseExampleBlocks(fields.mes_example)
  if (
    !examples.length ||
    examples.some(
      (block) =>
        block.raw !== undefined ||
        block.turns.some((turn) => !turn.text.trim()) ||
        !block.turns.some((turn) => turn.who === 'user') ||
        !block.turns.some((turn) => turn.who === 'char'),
    )
  ) {
    throw new Error('模型返回的对话示例格式错误，请重试。')
  }
  return {
    ...fields,
    mes_example: serializeExampleBlocks(examples),
    alternate_greetings: [...new Set(alternates.map((item: string) => item.trim()))].filter(
      (item) => item && item !== fields.first_mes,
    ),
  }
}

export async function generateCharacter(input: {
  description: string
  provider: ProviderSettings
  apiKey: string
  signal: AbortSignal
}): Promise<GeneratedCharacterData> {
  const description = input.description.trim()
  if (!description) throw new Error('请先输入角色描述。')
  if (description.length > 3000) throw new Error('角色描述请控制在 3000 字以内。')
  const p = input.provider
  if (!p.baseUrl || !p.model) throw new Error('请先在模型管理中配置并选择模型服务。')
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: description },
  ]
  // 整张角色卡需要独立输出预算，不沿用通常只有 1024 的聊天回复上限。
  const remaining = Math.floor(p.contextWindow - estimateMessagesTokens(messages, 16) * 1.3 - 256)
  if (remaining < 1024)
    throw new Error('当前模型的上下文窗口不足，请缩短描述或在模型管理中调整上下文窗口。')
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
      maxTokens: Math.min(4096, remaining),
    },
    input.signal,
  )
  input.signal.throwIfAborted()
  return parseGeneratedCharacter(raw)
}
