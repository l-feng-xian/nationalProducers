/**
 * 角色状态：每轮 AI 回复末尾随正文输出的结构化快照（时间、地点、心情、背包……）。
 *
 * 快照**按消息**存在 `MessageExtra.status` 上，而不是在会话元数据里另存一份「当前状态」：
 * 重新生成 / 删消息 / 分支都会自然回滚或复制，永远不会出现过期副本。
 * 「当前状态」= 倒序找到的第一条带快照的消息。
 */

export type StatusValue = string | string[]
export type StatusScope = 'scene' | 'person' | 'char' | 'user'

export interface StatusField {
  /** 同时是 JSON 键名与界面标签，所以直接用中文 */
  key: string
  /**
   * scene = 整个场景一份；person = 每个人各一份（角色与用户都有）；
   * char = 只有角色有（如「对用户的关系」）；user = 只有用户有（如「任务进度」）
   */
  scope: StatusScope
  kind: 'text' | 'list'
  /** 给模型的填写提示，支持 {{user}} {{char}} */
  hint?: string
  enabled: boolean
}

export interface StatusPerson {
  name: string
  fields: Record<string, StatusValue>
  /** 模型本轮漏写了这个人，整条沿用上一份（services/status/complete.ts） */
  carried?: boolean
}

export interface StatusData {
  scene: Record<string, StatusValue>
  people: StatusPerson[]
}

export interface MessageStatus {
  data: StatusData
  /** ai = 模型本轮输出；user = 用户在侧栏手改过 */
  source: 'ai' | 'user'
  updatedAt: number
}

export interface StatusSettings {
  enabled: boolean
  /** 注入深度。0 = 紧贴最后一条消息，模型最不容易忘记输出格式 */
  depth: number
  fields: StatusField[]
}

/**
 * 角色卡上的覆盖（extensions.np.status）。fields 只在 1v1 生效；
 * initial 在 1v1 整份生效，群聊里只取「角色本人」那一条作为兜底。
 */
export interface CharacterStatusConfig {
  /** 非空时整体替换全局字段模板 */
  fields?: StatusField[]
  /** 会话还没有任何快照时，作为「当前状态」注入 */
  initial?: StatusData
}

export function defaultStatusFields(): StatusField[] {
  return [
    {
      key: '时间',
      scope: 'scene',
      kind: 'text',
      hint: '故事内的日期与时段，如「第3天 傍晚」',
      enabled: true,
    },
    { key: '地点', scope: 'scene', kind: 'text', hint: '尽量具体到场所', enabled: true },
    { key: '天气', scope: 'scene', kind: 'text', enabled: true },
    { key: '心理状态', scope: 'person', kind: 'text', hint: '情绪与此刻的想法', enabled: true },
    { key: '身体状况', scope: 'person', kind: 'text', hint: '体力、伤势、饥饿等', enabled: true },
    { key: '衣着', scope: 'person', kind: 'text', enabled: true },
    { key: '背包', scope: 'person', kind: 'list', hint: '随身携带的物品', enabled: true },
    // 键名刻意不带 {{user}}：键要稳定，换了用户名旧快照的字段才对得上
    {
      key: '关系',
      scope: 'char',
      kind: 'text',
      hint: '对{{user}}的态度与关系',
      enabled: true,
    },
  ]
}

export function defaultStatusSettings(): StatusSettings {
  return { enabled: true, depth: 0, fields: defaultStatusFields() }
}

export function emptyStatusData(): StatusData {
  return { scene: {}, people: [] }
}

/** 群聊上的覆盖（Group.status）：与角色卡同形 */
export type GroupStatusConfig = CharacterStatusConfig

/** 某个人适用的人物字段：所有人 + (用户 ? 仅用户 : 仅角色) */
export function fieldsFor(fields: StatusField[], isUser: boolean): StatusField[] {
  return fields.filter((f) => f.scope === 'person' || f.scope === (isUser ? 'user' : 'char'))
}

export const STATUS_SCOPE_LABEL: Record<StatusScope, string> = {
  scene: '场景',
  person: '所有人',
  char: '仅角色',
  user: '仅用户',
}
