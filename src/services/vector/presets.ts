/**
 * 可选的嵌入模型预设。
 *
 * 只给挑好的几个，不开放任意 HF 仓库 id —— pooling 方式、是否需要检索前缀、
 * 前缀内容这几项**填错了不会报任何错**，只会让召回质量静默变差。
 * 让用户去填这些，等于给他们一个看不见的坑。
 *
 * 体积与维度是对 HF 实测出来的（HEAD 拿 x-linked-size，config.json 拿 hidden_size），
 * 不是从模型卡片上抄的 —— 「small」并不总是小，multilingual-e5-small 的
 * 分词器就有 16MB，整体比 bge-base 还大。
 *
 * 纯 service：不 import vue/pinia，Worker 里也要用。
 */

export interface EmbedModelPreset {
  /** HF 仓库 id，同时是缓存与索引里的模型标识 */
  id: string
  name: string
  /** 向量维度。换模型必然换维度，旧索引全部作废 */
  dim: number
  /**
   * 池化方式。bge 系用 CLS，e5 系用 mean。
   * 写错不报错，只掉几个点的检索质量 —— 这正是不开放自定义的原因。
   */
  pooling: 'cls' | 'mean'
  /**
   * 查询侧前缀。
   * bge 是**非对称**检索：只加查询侧，文档侧加了反而抵消（实测区分度 +62%）。
   */
  queryPrefix: string
  /**
   * 文档侧前缀。bge 系必须为空；e5 系两侧都要加且内容不同（query:/passage:）。
   * 它只在**嵌入那一刻**拼接，不写进 memchunks.text —— 那段文本要原样进提示词。
   */
  docPrefix: string
  /** 下载体积（全部必需文件之和，实测字节） */
  bytes: number
  /** 低端安卓是否跑得动 */
  mobileFriendly: boolean
  blurb: string
}

export const EMBED_PRESETS: readonly EmbedModelPreset[] = Object.freeze([
  {
    id: 'Xenova/bge-small-zh-v1.5',
    name: 'BGE Small 中文',
    dim: 512,
    pooling: 'cls',
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    docPrefix: '',
    bytes: 24_010_842 + 439_125 + 716 + 367 + 125,
    mobileFriendly: true,
    blurb:
      '4 层浅模型，手机也能跑。实测桌面冷启约 1 秒、单条嵌入 13 毫秒。中文召回够用，是默认推荐。',
  },
  {
    id: 'Xenova/bge-base-zh-v1.5',
    name: 'BGE Base 中文',
    dim: 768,
    pooling: 'cls',
    queryPrefix: '为这个句子生成表示以用于检索相关文章：',
    docPrefix: '',
    bytes: 102_868_746 + 439_125 + 716 + 367 + 125,
    mobileFriendly: false,
    blurb:
      '12 层，维度 768。相关与无关的区分度明显好过 Small —— Small 那点差距只有 0.03 一档，很吃阈值。代价是体积大四倍、嵌入慢几倍，低端手机不建议。',
  },
  {
    id: 'Xenova/multilingual-e5-small',
    name: 'E5 Small 多语种',
    dim: 384,
    pooling: 'mean',
    queryPrefix: 'query: ',
    docPrefix: 'passage: ',
    bytes: 118_308_185 + 17_082_734 + 716 + 367 + 125,
    mobileFriendly: false,
    blurb:
      '中英混合场景用它（英文角色卡、中英夹杂的对话）。纯中文场景不如 BGE。注意它体积并不小：分词器是多语种的，光这一项就 16MB。',
  },
])

export const DEFAULT_PRESET_ID = 'Xenova/bge-small-zh-v1.5'

export function findPreset(id: string): EmbedModelPreset | undefined {
  return EMBED_PRESETS.find((p) => p.id === id)
}

/** 传给 Worker 的最小模型描述。Worker 不该依赖整张预设表 */
export interface ModelSpec {
  id: string
  pooling: 'cls' | 'mean'
}

export function toSpec(p: EmbedModelPreset): ModelSpec {
  return { id: p.id, pooling: p.pooling }
}
