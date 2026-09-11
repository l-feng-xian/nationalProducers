/**
 * 角色卡类型 —— 对齐 SillyTavern Character Card Spec V2（`chara_card_v2` / `2.0`）。
 *
 * 关键决策：`data.*` 是**唯一权威**。v1 顶层镜像字段只在导入时读（回填 data）、
 * 导出时写，运行时一律读 `char.data.description`，杜绝双真相源。
 */

export interface DepthPrompt {
  prompt: string
  depth: number
  role: 'system' | 'user' | 'assistant'
}

export const DEPTH_PROMPT_DEPTH_DEFAULT = 4
export const DEPTH_PROMPT_ROLE_DEFAULT = 'system'
export const TALKATIVENESS_DEFAULT = 0.5

export interface CharacterExtensions {
  /** 0..1，默认 0.5。1vN NATURAL 策略的发言概率权重 */
  talkativeness: number
  fav: boolean
  /** ST 的单本角色世界书**书名**；导入时转成本地 worldBookIds */
  world?: string
  depth_prompt?: DepthPrompt
  /** 本 app 的命名空间，保证往返无损 */
  np?: { worldBookNames?: string[] }
  [k: string]: unknown
}

/** 角色卡内嵌世界书（V2 character_book）。导入时拆成独立 WorldBook */
export interface CharacterBookSpec {
  name?: string
  description?: string
  entries: unknown[]
  [k: string]: unknown
}

export interface CharacterDataV2 {
  name: string
  /** 角色简介（需求 2） */
  description: string
  /** 性格（需求 2） */
  personality: string
  scenario: string
  /** 主开场白。与 alternate_greetings 共同组成开场白池 */
  first_mes: string
  /** 对话示例，`<START>` 分隔的多个块（需求 2：可多条） */
  mes_example: string
  creator_notes: string
  /** 角色级主提示词覆盖 */
  system_prompt: string
  /** 角色级后置指令（越狱）覆盖 */
  post_history_instructions: string
  tags: string[]
  creator: string
  character_version: string
  /** 需求 2：新对话从 [first_mes, ...alternate_greetings] 中随机取一条 */
  alternate_greetings: string[]
  character_book?: CharacterBookSpec
  extensions: CharacterExtensions
}

/** @deprecated 仅用于导入回填与导出镜像；运行时永远读 data.* */
export interface CharacterV1Mirror {
  name?: string
  description?: string
  personality?: string
  scenario?: string
  first_mes?: string
  mes_example?: string
  creatorcomment?: string
  tags?: string[]
  talkativeness?: number
  fav?: boolean
}

export interface Character extends CharacterV1Mirror {
  /** crypto.randomUUID()。不用 ST 的 avatar 文件名当主键（那是文件系统产物） */
  id: string
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: CharacterDataV2
  // ── 本 app 专有 ──
  /** blobs store 的 id，角色图片 */
  avatarBlobId?: string
  /**
   * blobs store 的 id，立绘的**深度图**（单通道灰度 PNG，长边 512）。
   * 有它才能在角色卡上做真视差；没有就退化成普通静态图片。
   *
   * 只在**上传图片时**生成，且必须先在模型管理里启用深度模型 ——
   * 单张推理实测约 3 秒，hover 现算和进页面批量都不现实。
   * 换头像时必须连带作废：深度图和立绘是一对，对不上就会渲染出错位的视差。
   */
  depthBlobId?: string
  /** 角色世界书。ST 只有单本 world，这里扩展成多本 */
  worldBookIds: string[]
  fav: boolean
  /** IndexedDB 不索引 boolean，故冗余成 0|1 供 by_fav 索引使用 */
  favIdx: 0 | 1
  createdAt: number
  updatedAt: number
}

export function emptyCharacterData(name = '新角色'): CharacterDataV2 {
  return {
    name,
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    tags: [],
    creator: '',
    character_version: '',
    alternate_greetings: [],
    extensions: {
      talkativeness: TALKATIVENESS_DEFAULT,
      fav: false,
      depth_prompt: {
        prompt: '',
        depth: DEPTH_PROMPT_DEPTH_DEFAULT,
        role: DEPTH_PROMPT_ROLE_DEFAULT,
      },
    },
  }
}

export function emptyCharacter(id: string, name = '新角色'): Character {
  const now = Date.now()
  return {
    id,
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: emptyCharacterData(name),
    worldBookIds: [],
    fav: false,
    favIdx: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 开场白池。对齐 ST 群聊规则：空串过滤后均匀随机。
 * 需求 2 的「多条开场白，新对话随机选取插入」即取自此池。
 */
export function greetingPool(c: Character): string[] {
  return [c.data.first_mes, ...c.data.alternate_greetings].filter((x) => !!x && x.trim() !== '')
}

export function talkativenessOf(c: Character): number {
  const t = c.data.extensions.talkativeness
  return typeof t === 'number' && !Number.isNaN(t) ? t : TALKATIVENESS_DEFAULT
}
