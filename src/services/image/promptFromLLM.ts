/**
 * 用「已配置的聊天 LLM」把角色资料 / 对话上下文转成绘图提示词。
 *
 * 复用 `chatOnce`（单次非流式补全）+ 当前激活的 provider。任何失败（未配置模型、
 * 网络错误、空返回）都**回退到静态模板**（prompts.ts），保证生图入口始终可用。
 */
import type { CharacterDataV2 } from '@/types/character'
import type { ChatMessage } from '@/types/chat'
import { thinkingField, type ProviderConfig } from '@/types/provider'
import type { ProviderSettings } from '@/types/settings'
import { chatOnce } from '@/services/provider/openaiCompatible'
import { stripThink } from '@/services/memory/stateCard'
import type { StatusData } from '@/types/status'
import {
  characterImagePrompt,
  dialogueImagePrompt,
  groupCoverPrompt,
  referenceLines,
  statusLines,
  type PromptRef,
} from './prompts'

const IMAGE_PROMPT_CONTEXT_ROUNDS = 10

const CHARACTER_SYSTEM = `你是文生图提示词专家。根据下面的角色资料，写一段用于「文生图」的画面提示词。
要求：聚焦人物外貌、发型、五官、体态、服饰与整体气质，并补上呼应设定的场景与光线；具体、可视化、可直接绘制。
只输出提示词本身，不要解释、标题、引号或 Markdown；画面里不要出现文字、水印、边框或聊天气泡。中文或英文均可，控制在 150 字以内。`

const DIALOGUE_SYSTEM = `你是图生图提示词专家。给你参考图说明（按「参考图 1、参考图 2……」编号，与输入参考图的顺序一一对应）、人物此刻的状态和最近的对话，为「需要配图的这句」写一段图生图画面提示词。
按以下顺序写，每一项都要具体、可视化：
1. 场景：地点、时间、天气、光线与氛围。以「当前状态」为准，没有就从对话推断。
2. 人物：用「参考图 N 中的人物」逐一指代（多人时编号绝不能混淆），分别写出此刻的表情与眼神、肢体动作与姿态、人物之间的互动，以及穿着——穿着以「当前状态」里的衣着或对话中提到的为准，都没有时与参考图一致。
3. 构图：景别与视角，要让表情和动作看得清。
硬性要求：每个人的五官、发型、发色、瞳色、脸型与体型必须与参考图一致、保持不变；画面中只出现给定的人物，不要添加其他角色。「此前的画面」类参考图只用来延续场景、服装与画风，不要照抄其构图与动作。
只输出提示词本身，不要解释、标题、引号或 Markdown；画面里不要出现文字、聊天气泡或水印。控制在 250 字以内。`

const GROUP_COVER_SYSTEM = `你是文生图提示词专家。给你一个演绎的名字、成员参考图说明（按「参考图 1、参考图 2……」编号，与输入参考图的顺序一一对应）与成员之间的关系，写一段「横版合影封面」的画面提示词。
要求：用「参考图 N 中的人物」逐一指代每位成员，所有成员同框、完整出现且清晰可辨认；五官、发型、发色、瞳色、服饰与体型必须与参考图一致；用站位、朝向、神态和互动体现他们的关系；补上呼应共同故事氛围的背景与光线，横版构图。
只输出提示词本身，不要解释、标题、引号或 Markdown；画面里不要出现文字、水印或边框。控制在 200 字以内。`

function providerConfig(p: ProviderSettings, apiKey: string): ProviderConfig {
  return {
    baseUrl: p.baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(p.proxyPrefix ? { proxyPrefix: p.proxyPrefix } : {}),
    headers: p.extraHeaders,
    ...thinkingField(p.thinking),
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
  /** 已选参考图，顺序即「参考图 N」的编号 */
  refs: PromptRef[]
  /** 目标消息那一刻的角色状态（prompts.ts statusAt），没有就是 null */
  status: StatusData | null
  provider: ProviderSettings
  apiKey: string
  signal: AbortSignal
}): Promise<string> {
  const fallback = () => dialogueImagePrompt(input.message, input.refs, input.status)
  if (!input.provider.baseUrl || !input.provider.model) return fallback()
  // 取目标消息之前（含）的最近若干条真实对话作为上下文
  const recent = input.history
    .filter((m) => m.id !== input.message.id && !m.is_system && !m.exclude && m.mes.trim())
    .slice(-(IMAGE_PROMPT_CONTEXT_ROUNDS * 2))
    .map((m) => `${m.name}：${m.mes.trim().slice(0, 400)}`)
    .join('\n')
  // 编号与参考图发送顺序一一对应（与模板同一套 referenceLines），多人时 LLM 才能写出「参考图 2 中的……」；
  // 外貌设定写进去和参考图双重锚定长相
  const refLines = referenceLines(input.refs).join('\n')
  const cast = input.refs.filter((r) => r.kind === 'character').map((r) => r.name)
  const state = statusLines(input.status, cast).join('\n')
  const user = [
    refLines ? `参考图说明：\n${refLines}` : '',
    state ? `当前状态（场景与人物此刻的衣着、情绪、身体状况）：\n${state}` : '',
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

/** 演绎封面（横版合影）提示词。失败回退 `groupCoverPrompt` 模板。 */
export async function groupCoverPromptViaLLM(input: {
  name: string
  refs: PromptRef[]
  relations?: string
  provider: ProviderSettings
  apiKey: string
  signal: AbortSignal
}): Promise<string> {
  const fallback = () =>
    groupCoverPrompt({
      name: input.name,
      refs: input.refs,
      ...(input.relations ? { relations: input.relations } : {}),
    })
  if (!input.provider.baseUrl || !input.provider.model) return fallback()
  const user = [
    `演绎名：${input.name}`,
    `参考图说明：\n${referenceLines(input.refs).join('\n')}`,
    input.relations?.trim() ? `人物关系：\n${input.relations.trim().slice(0, 1500)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const text = await runOnce(input.provider, input.apiKey, GROUP_COVER_SYSTEM, user, input.signal)
    return text || fallback()
  } catch (error) {
    if (input.signal.aborted) throw error
    return fallback()
  }
}
