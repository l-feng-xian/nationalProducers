import type { Character } from '@/types/character'
import type { ChatMessage } from '@/types/chat'
import type { CharacterImageReference } from '@/types/image'

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

export function dialogueImagePrompt(
  message: ChatMessage,
  references: CharacterImageReference[],
): string {
  return [
    '请根据当前对话生成画面。人物外貌、发型、服饰与对应参考图保持一致，动作和场景以对话为准。不要绘制文字、聊天气泡或水印。',
    ...references.map((reference, index) => `参考图 ${index + 1}：${reference.name}`),
    `当前对话：\n${message.name}：${message.mes.trim()}`,
  ].join('\n\n')
}
