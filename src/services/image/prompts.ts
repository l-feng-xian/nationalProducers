import type { Character } from '@/types/character'
import type { ChatMessage } from '@/types/chat'
import type { ImageRefCandidate } from '@/types/image'
import type { StatusData, StatusValue } from '@/types/status'
import { latestStatus } from '@/services/status/template'

/** 提示词只需要参考图的这几项；顺序 = 发送顺序 = 「参考图 N」的编号 */
export type PromptRef = Pick<ImageRefCandidate, 'kind' | 'name' | 'description' | 'label'>

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

/**
 * 演绎配图**默认勾选**几位出场人物。只是默认值：用户可以在对话框里再加，
 * 真正的上限按后端定（services/image/limits.ts）。画面人物一多，面孔与服饰也更容易互相串。
 */
export const MAX_SCENE_REFERENCES = 3

/**
 * 演绎配图：挑出**这一幕真正出场的人**，而不是把全体成员都塞进参考图。
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

/**
 * 「参考图 N 是……」—— 模板与 LLM 两条路共用，编号必须与参考图的发送顺序一一对应。
 * 三类参考图的用途不同，要分别告诉模型怎么用，否则历史配图的构图会被原样照抄。
 */
export function referenceLines(refs: PromptRef[]): string[] {
  return refs.map((r, index) => {
    const n = `参考图 ${index + 1}`
    if (r.kind === 'group')
      return `${n} 是群像「${r.name}」：只参考其中人物的整体画风与长相，不要照抄构图`
    if (r.kind === 'history')
      return `${n} 是此前的一幅画面（${r.label}）：延续其场景、人物服装与画风，不要照抄构图和动作`
    const look = r.description?.trim() ? `，外貌设定：${r.description.trim().slice(0, 600)}` : ''
    return `${n} 是「${r.name}」的形象${look}`
  })
}

/** 目标消息那一刻的状态快照：seq ≤ 目标的最新一份（角色状态功能，见 types/status.ts） */
export function statusAt(messages: readonly ChatMessage[], seq: number): StatusData | null {
  return latestStatus(messages.filter((m) => m.seq <= seq))?.status.data ?? null
}

function valueText(v: StatusValue): string {
  return Array.isArray(v) ? v.join('、') : v
}

/**
 * 状态快照 → 提示词里的「当前状态」几行。只取画面相关的人：给了参考图的人物。
 * 用户本人不画（没有参考图），他的状态不写进来，免得模型把他也画上。
 */
export function statusLines(status: StatusData | null, names: string[]): string[] {
  if (!status) return []
  const lines: string[] = []
  const scene = Object.entries(status.scene)
    .filter(([, v]) => valueText(v).trim())
    .map(([k, v]) => `${k}：${valueText(v)}`)
  if (scene.length) lines.push(`场景 —— ${scene.join('；')}`)
  for (const p of status.people) {
    if (!names.includes(p.name)) continue
    const fields = Object.entries(p.fields)
      .filter(([, v]) => valueText(v).trim())
      .map(([k, v]) => `${k}：${valueText(v)}`)
      .join('；')
    if (fields) lines.push(`${p.name} —— ${fields.slice(0, 400)}`)
  }
  return lines
}

/** 画面里出场的人物（只有「角色封面」类参考图代表人物），带编号 */
function castOf(refs: PromptRef[]): { n: number; name: string }[] {
  return refs.flatMap((r, i) => (r.kind === 'character' ? [{ n: i + 1, name: r.name }] : []))
}

/**
 * 对话配图（图生图）的模板提示词。也是 LLM 版失败时的回退。
 *
 * 着重四件事：当前场景、每个人的表情、肢体动作、穿着。
 * 五官 / 发型 / 发色 / 瞳色 / 体型锁死在参考图上；**穿着跟当前状态走**（状态里的「衣着」
 * 或对话里提到的），都没有才沿用参考图 —— 原模板一律锁死服饰，换了装的剧情画不出来。
 */
export function dialogueImagePrompt(
  message: ChatMessage,
  refs: PromptRef[],
  status: StatusData | null = null,
): string {
  const cast = castOf(refs)
  const state = statusLines(
    status,
    cast.map((c) => c.name),
  )
  const people = cast.length
    ? cast.map(
        (c) =>
          `- 参考图 ${c.n} 中的${c.name}：写清此刻的表情与眼神、肢体动作与姿态、与他人的互动；` +
          `穿着以「当前状态」里的衣着或对话中提到的为准，都没有时与参考图一致`,
      )
    : ['- 人物与参考画面中的保持一致，写清表情、动作与穿着']
  return [
    '请为对话中的这一刻画一张插画，重点表现：当前场景、人物的表情、肢体动作与穿着。',
    `【场景】${state.length ? '按下方「当前状态」里的地点、时间与天气' : '根据对话推断地点、时间与天气'}，交代光线与氛围。`,
    `【人物】画面中${cast.length ? `只出现以下 ${cast.length} 个人物，与参考图编号一一对应，不要混淆彼此的长相` : '的人物'}：`,
    ...people,
    '【保持不变】每个人的五官、发型、发色、瞳色、脸型与体型必须与其参考图一致。',
    '【构图】选择能看清表情与动作的景别和视角，画面不要出现文字、聊天气泡或水印。',
    `参考图说明：\n${referenceLines(refs).join('\n')}`,
    ...(state.length ? [`当前状态：\n${state.join('\n')}`] : []),
    `当前对话：\n${message.name}：${message.mes.trim()}`,
  ].join('\n\n')
}

/** 演绎封面（横版合影）的模板提示词 */
export function groupCoverPrompt(input: {
  name: string
  refs: PromptRef[]
  relations?: string
}): string {
  const cast = castOf(input.refs)
  return [
    `请为演绎「${input.name}」画一张横版合影封面：${cast.length} 个人物同框，每个人都完整出现、清晰可辨认，人物之间的站位与神态体现彼此的关系，背景呼应他们共同的故事氛围。`,
    '每个人的五官、发型、发色、瞳色、服饰与体型必须与其参考图一致；不要添加其他人物，画面不要出现文字、水印或边框。',
    `参考图说明：\n${referenceLines(input.refs).join('\n')}`,
    ...(input.relations?.trim() ? [`人物关系：\n${input.relations.trim()}`] : []),
  ].join('\n\n')
}
