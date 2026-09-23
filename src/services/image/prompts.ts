import type { Character } from '@/types/character'
import type { ChatMessage } from '@/types/chat'

/** 出场人物的外貌锚点：名字 + 角色简介（外貌来源）。用于图生图保持人物一致。 */
export interface DialogueCharacter {
  name: string
  description?: string
}

export function characterImagePrompt(
  data: Pick<Character['data'], 'name' | 'description' | 'personality' | 'scenario'>,
): string {
  return [
    '请根据以下角色资料绘制一张角色封面。突出人物的外貌、服饰与气质，主体清晰，背景呼应角色设定，画面不要出现文字、水印或边框。',
    `角色名：${data.name}`,
    `角色简介：${data.description.slice(0, 5000)}`,
    data.personality ? `性格气质：${data.personality.slice(0, 1000)}` : '',
    data.scenario ? `场景参考：${data.scenario.slice(0, 1000)}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function dialogueImagePrompt(message: ChatMessage, characters: DialogueCharacter[]): string {
  // 把角色外貌写进提示词，和参考图一起双重锚定人物；否则模型只靠参考latent，服饰易漂移。
  const who = characters.map((c, index) => {
    const look = c.description?.trim() ? `：${c.description.trim().slice(0, 600)}` : ''
    return `参考图 ${index + 1} ${c.name}${look}`
  })
  return [
    '请根据当前对话生成一张插画。务必保持每个人物的外貌、发型、发色、瞳色、脸型与服饰与其参考图及下方设定一致、保持不变，只改变人物的动作、表情与所处场景。不要绘制文字、聊天气泡或水印。',
    ...who,
    `当前对话：\n${message.name}：${message.mes.trim()}`,
  ].join('\n\n')
}
