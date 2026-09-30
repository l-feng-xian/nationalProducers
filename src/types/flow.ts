/**
 * 流程控制：「触发 → 条件 → 动作」规则，挂在角色卡（extensions.np.flow）与演绎（Group.flow）上。
 *
 * 运行态（哪些规则触发过、还在生效的剧情引导）**按消息**存在 `MessageExtra.flow` 上，
 * 与状态快照同一思路：重新生成 / 删消息 / 分支会自然回滚或复制，不会出现「重掷后规则
 * 以为自己已经触发过」的错位。「当前运行态」= 倒序第一条带 flow 的消息。
 */

/** 什么时候检查 */
export type FlowTriggerKind = 'afterReply' | 'everyN'

export interface FlowTrigger {
  kind: FlowTriggerKind
  /** everyN：每 N 条 AI 回复检查一次 */
  n?: number
}

/**
 * 条件的取值来源：
 *  person = 某人的状态字段；scene = 场景字段；var = 会话变量；
 *  turn = 已有 AI 回复条数；reply = 本轮回复正文
 */
export type FlowSource = 'person' | 'scene' | 'var' | 'turn' | 'reply' | 'stage'

export type FlowOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'notContains'

export interface FlowCondition {
  id: string
  source: FlowSource
  /** person：人名，支持 {{char}} / {{user}} */
  who?: string
  /** person / scene：字段键；var：变量名 */
  key?: string
  op: FlowOp
  value: string
}

/**
 * 动作：
 *  guide = 给之后 N 轮注入一段剧情引导（推荐：由模型自然写出）；
 *  say = 原样插入一段固定台词（不调用模型）；
 *  setStatus = 改状态字段（set 设值 / add 数值增减 / push、pull 列表加减）；
 *  setVar = 写会话变量；setStage = 切换剧情阶段；
 *  activateLore = 强制激活某条世界书条目 N 轮；
 *  nextSpeaker = 演绎指定下一位发言者（只生效一次）；
 *  mute / unmute = 演绎里本会话内静音 / 取消静音某位成员（不改演绎设置）
 */
export type FlowActionKind =
  | 'guide'
  | 'say'
  | 'setStatus'
  | 'setVar'
  | 'setStage'
  | 'activateLore'
  | 'nextSpeaker'
  | 'mute'
  | 'unmute'
  | 'image'

export interface FlowAction {
  id: string
  kind: FlowActionKind
  /** guide / say：正文，支持 {{char}} {{user}} */
  text?: string
  /** guide：生效轮数，默认 1 */
  turns?: number
  /** say：以谁的身份说；空 = 本轮发言者 */
  speaker?: string
  /** setStatus：scene 或某人（支持 {{char}} / {{user}}） */
  who?: string
  key?: string
  mode?: 'set' | 'add' | 'push' | 'pull'
  value?: string
  /** setStage：目标阶段 id */
  stage?: string
  /** activateLore：世界书 id 与条目 uid */
  book?: string
  uid?: number
}

/**
 * once = 只触发一次；
 * edge = 条件从不成立变为成立时触发（可反复，如好感度跌破后再次涨回）；
 * always = 每次检查都成立就触发（配 cooldown 限频）
 */
export type FlowRuleMode = 'once' | 'edge' | 'always'

export interface FlowRule {
  id: string
  name: string
  enabled: boolean
  trigger: FlowTrigger
  /** all = 全部满足；any = 任一满足 */
  match: 'all' | 'any'
  conditions: FlowCondition[]
  mode: FlowRuleMode
  /** always 模式下两次触发至少间隔多少条 AI 回复 */
  cooldown?: number
  actions: FlowAction[]
}

/** 阶段之间的一条连线：当前在 from 阶段、条件成立时进入 to */
export interface FlowTransition {
  id: string
  to: string
  match: 'all' | 'any'
  conditions: FlowCondition[]
}

/**
 * 剧情阶段：整张图是一个状态机。每个阶段自带一段常驻引导（身处该阶段时每轮注入），
 * 出边按顺序检查，第一条成立的生效。第一个阶段 = 初始阶段。
 */
export interface FlowStage {
  id: string
  name: string
  guide?: string
  transitions: FlowTransition[]
}

/** 节点流程图上的坐标：节点 id → 位置。只影响编辑器显示，不影响规则求值 */
export type FlowLayout = Record<string, { x: number; y: number }>

export interface FlowConfig {
  rules: FlowRule[]
  stages?: FlowStage[]
  layout?: FlowLayout
}

/** 仍在生效的剧情引导 */
export interface FlowGuide {
  ruleKey: string
  text: string
  /** 还要注入几轮（含下一轮） */
  left: number
}

/** 被流程强制激活、仍在生效的世界书条目 */
export interface FlowLore {
  book: string
  uid: number
  /** 还要激活几轮（含下一轮） */
  left: number
}

/** 按消息存的运行态 */
export interface FlowState {
  /** ruleKey → 最近一次触发时的 AI 回复序号 */
  fired: Record<string, number>
  /** ruleKey → 上次检查时条件是否成立（edge 模式用） */
  truth: Record<string, boolean>
  guides: FlowGuide[]
  /** ownerId → 当前阶段 id；缺省 = 该来源的第一个阶段 */
  stages?: Record<string, string>
  lore?: FlowLore[]
  /** 演绎：下一轮强制由此人发言（角色名），用一次即清 */
  nextSpeaker?: string
  /** 演绎：本会话内被流程静音的成员（角色名），持续到 unmute */
  muted?: string[]
  /** 本条回复需要配图：聊天页在生成结束后打开配图面板（用户确认后才调用生图）。不往后带 */
  image?: boolean
  /** 本轮触发的规则名，给气泡 / 侧栏显示 */
  log?: string[]
}

export const FLOW_OP_LABEL: Record<FlowOp, string> = {
  eq: '等于',
  ne: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  contains: '包含',
  notContains: '不包含',
}

export const FLOW_SOURCE_LABEL: Record<FlowSource, string> = {
  person: '人物状态',
  scene: '场景状态',
  var: '会话变量',
  turn: '回复轮数',
  reply: '本轮回复正文',
  stage: '当前阶段',
}

export const FLOW_ACTION_LABEL: Record<FlowActionKind, string> = {
  guide: '引导剧情',
  say: '输出固定台词',
  setStatus: '修改状态',
  setVar: '设置变量',
  setStage: '切换阶段',
  activateLore: '激活世界书条目',
  nextSpeaker: '指定下一位发言者',
  mute: '静音成员',
  unmute: '取消静音',
  image: '生成配图',
}

/** 只在演绎里有意义的动作：角色卡在 1v1 下编辑时隐藏 */
export const GROUP_ONLY_ACTIONS: FlowActionKind[] = ['nextSpeaker', 'mute', 'unmute']

export const FLOW_MODE_LABEL: Record<FlowRuleMode, string> = {
  once: '只触发一次',
  edge: '每次变为成立时',
  always: '每次都成立就触发',
}

export function emptyFlowState(): FlowState {
  return { fired: {}, truth: {}, guides: [] }
}

export function newFlowRule(id: string, name = '新规则'): FlowRule {
  return {
    id,
    name,
    enabled: true,
    trigger: { kind: 'afterReply' },
    match: 'all',
    conditions: [],
    mode: 'once',
    actions: [],
  }
}
