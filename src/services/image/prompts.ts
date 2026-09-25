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

/** 群聊配图一次最多带几张参考图。6GB 显存上每多一张参考图就多一份 reference latent 与视觉 token，
 * 3 张以上明显变慢且更易 OOM；画面人物一多，面孔与服饰也更容易互相串 */
export const MAX_SCENE_REFERENCES = 3

/**
 * 群聊配图：挑出**这一幕真正出场的人**，而不是把全体成员都塞进参考图。
 *
 * 顺序即参考图顺序（参考图 1、2、3 …）：
 *  1. 这句话的发言者（AI 消息的 original_avatar）；
 *  2. 这句话里点到名字的其他成员，按首次出现的位置；
 *  3. 用户自己说的话且没点名任何人 → 退回离它最近的 AI 发言者（多半是在对谁说话）。
 * 发言者没有封面照样保留（配图弹窗会提示去设置封面）；**被点名的配角没有封面就跳过**，
 * 不能因为一个路人没封面把整张图卡住。单字名字不做点名匹配，误中率太高。
 */
export function pickSceneCharacters(
  message: ChatMessage,
  history: ChatMessage[],
  members: Character[],
  max = MAX_SCENE_REFERENCES,
): Character[] {
  const byId = new Map(members.map((c) => [c.id, c]))
  const picked: Character[] = []
  const add = (c: Character | undefined) => {
    if (c && !picked.includes(c) && picked.length < max) picked.push(c)
  }

  if (!message.is_user) add(byId.get(message.original_avatar ?? ''))

  const text = message.mes
  const mentioned = members
    .filter((c) => c.data.name.trim().length >= 2 && text.includes(c.data.name.trim()))
    .sort((a, b) => text.indexOf(a.data.name.trim()) - text.indexOf(b.data.name.trim()))
  for (const c of mentioned) if (c.avatarBlobId) add(c)

  if (!picked.length) {
    // 用户的话且没点名：取最近的 AI 发言者（先往前找，找不到再往后找）
    const idx = history.findIndex((m) => m.id === message.id)
    const around = [...history.slice(0, Math.max(0, idx)).reverse(), ...history.slice(idx + 1)]
    const near = around.find((m) => !m.is_user && !m.is_system && byId.has(m.original_avatar ?? ''))
    add(byId.get(near?.original_avatar ?? ''))
  }
  // 兜底：群里总得有人出场
  if (!picked.length) add(members.find((c) => c.avatarBlobId) ?? members[0])
  return picked
}

/** 「参考图 N 名字：外貌」—— 模板与 LLM 两条路共用，编号必须与参考图的发送顺序一一对应 */
export function referenceLines(characters: DialogueCharacter[]): string[] {
  return characters.map((c, index) => {
    const look = c.description?.trim() ? `：${c.description.trim().slice(0, 600)}` : ''
    return `参考图 ${index + 1} ${c.name}${look}`
  })
}

export function dialogueImagePrompt(message: ChatMessage, characters: DialogueCharacter[]): string {
  // 把角色外貌写进提示词，和参考图一起双重锚定人物；否则模型只靠参考latent，服饰易漂移。
  const who = referenceLines(characters)
  return [
    '请根据当前对话生成一张插画。务必保持每个人物的外貌、发型、发色、瞳色、脸型与服饰与其参考图及下方设定一致、保持不变，只改变人物的动作、表情与所处场景。不要绘制文字、聊天气泡或水印。',
    ...(characters.length > 1
      ? [
          `画面中只出现以下 ${characters.length} 个人物，每个人物与对应编号的参考图一一对应，不要混淆彼此的长相与服饰。`,
        ]
      : []),
    ...who,
    `当前对话：\n${message.name}：${message.mes.trim()}`,
  ].join('\n\n')
}
