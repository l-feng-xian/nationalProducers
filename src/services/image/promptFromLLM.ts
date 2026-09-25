/**
 * 用「已配置的聊天 LLM」把角色资料 / 对话上下文转成绘图提示词。
 *
 * 复用 `chatOnce`（单次非流式补全）+ 当前激活的 provider。任何失败（未配置模型、
 * 网络错误、空返回）都**回退到静态模板**（prompts.ts），保证生图入口始终可用。
 */
import type { CharacterDataV2 } from '@/types/character'
import type { ChatMessage } from '@/types/chat'
import type { ProviderConfig } from '@/types/provider'
import type { ProviderSettings } from '@/types/settings'
import { chatOnce } from '@/services/provider/openaiCompatible'
import { stripThink } from '@/services/memory/stateCard'
import {
  characterImagePrompt,
  dialogueImagePrompt,
  referenceLines,
  type DialogueCharacter,
} from './prompts'

const CHARACTER_SYSTEM = `你是文生图提示词专家。根据下面的角色资料，写一段用于「文生图」的画面提示词。
要求：聚焦人物外貌、发型、五官、体态、服饰与整体气质，并补上呼应设定的场景与光线；具体、可视化、可直接绘制。
只输出提示词本身，不要解释、标题、引号或 Markdown；画面里不要出现文字、水印、边框或聊天气泡。中文或英文均可，控制在 150 字以内。`

const DIALOGUE_SYSTEM = `你是图生图提示词专家。给你若干出场人物的外貌设定（按「参考图 1、参考图 2……」编号，与输入参考图的顺序一一对应）和最近的对话，写一段用于「图生图」的画面提示词。
硬性要求：用「参考图 N 中的人物」来指代每个人（多人时必须逐一对应编号，绝不能混淆谁是谁），先明确复述每个出场人物的关键外貌——发型、发色、瞳色、脸型、服饰，必须与参考图和给定设定完全一致、保持不变；再描述当前这一刻的动作、表情、场景与氛围。画面中只出现给定的这些人物，不要添加其他角色。
除非对话明确要求换装或改变外貌，否则绝不改变人物的服饰、发型与长相。只输出提示词本身，不要解释、引号或 Markdown；画面里不要出现文字、聊天气泡或水印。控制在 200 字以内。`

function providerConfig(p: ProviderSettings, apiKey: string): ProviderConfig {
  return {
    baseUrl: p.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(p.proxyPrefix ? { proxyPrefix: p.proxyPrefix } : {}),
    headers: p.extraHeaders,
  }
}

async function runOnce(
  provider: ProviderSettings,
  apiKey: string,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  const raw = await chatOnce(
    providerConfig(provider, apiKey),
    {
      model: provider.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      temperature: provider.temperature,
      // ⚠️ 提示词正文虽短(<200字)，但**思维链模型**会先输出一大段 <think> 再给正文，
      // 512 会被思考吃光、正文被截断 → stripThink 后为空 → 白白回退到模板。
      // 给足预算让「思考 + 正文」都装得下（max_tokens 只是上限，模型输出完就停，不浪费）。
      maxTokens: 4096,
    },
    signal,
  )
  // 去掉思维链与包裹的引号/反引号
  return stripThink(raw)
    .trim()
    .replace(/^["'`「『]+|["'`」』]+$/g, '')
    .trim()
}

/** 角色封面（文生图）提示词。失败回退 `characterImagePrompt` 模板。 */
export async function characterImagePromptViaLLM(input: {
  data: Pick<CharacterDataV2, 'name' | 'description' | 'personality' | 'scenario'>
  provider: ProviderSettings
  apiKey: string
  signal: AbortSignal
}): Promise<string> {
  const fallback = () => characterImagePrompt(input.data)
  if (!input.provider.baseUrl || !input.provider.model) return fallback()
  const user = [
    `角色名：${input.data.name}`,
    `角色简介：${input.data.description.slice(0, 3000)}`,
    input.data.personality ? `性格气质：${input.data.personality.slice(0, 800)}` : '',
    input.data.scenario ? `场景设定：${input.data.scenario.slice(0, 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  try {
    const text = await runOnce(input.provider, input.apiKey, CHARACTER_SYSTEM, user, input.signal)
    return text || fallback()
  } catch (error) {
    if (input.signal.aborted) throw error
    return fallback()
  }
}

/** 对话配图（图生图）提示词。失败回退 `dialogueImagePrompt` 模板。 */
export async function dialogueImagePromptViaLLM(input: {
  message: ChatMessage
  history: ChatMessage[]
  characters: DialogueCharacter[]
  provider: ProviderSettings
  apiKey: string
  signal: AbortSignal
}): Promise<string> {
  const fallback = () => dialogueImagePrompt(input.message, input.characters)
  if (!input.provider.baseUrl || !input.provider.model) return fallback()
  // 取目标消息之前（含）的最近若干条真实对话作为上下文
  const recent = input.history
    .filter((m) => !m.is_system && !m.exclude && m.mes.trim())
    .slice(-8)
    .map((m) => `${m.name}：${m.mes.trim().slice(0, 400)}`)
    .join('\n')
  // 出场人物的外貌设定：让 LLM 把它写进提示词，和参考图一起双重锚定，避免服饰漂移
  // 编号与参考图发送顺序一一对应（与模板同一套 referenceLines），多人时 LLM 才能写出「参考图 2 中的……」
  const appearance = referenceLines(input.characters).join('\n')
  const user = [
    appearance ? `出场人物（外貌需与参考图一致、保持不变）：\n${appearance}` : '',
    recent ? `最近对话：\n${recent}` : '',
    `需要配图的这句：\n${input.message.name}：${input.message.mes.trim().slice(0, 600)}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const text = await runOnce(input.provider, input.apiKey, DIALOGUE_SYSTEM, user, input.signal)
    return text || fallback()
  } catch (error) {
    if (input.signal.aborted) throw error
    return fallback()
  }
}
