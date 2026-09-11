/**
 * 深度估计模型预设。
 *
 * 与嵌入模型分开一张表：那边的 dim / pooling / queryPrefix 对深度模型毫无意义，
 * 硬塞进同一个类型只会得到一堆永远为空的字段。
 *
 * 纯 service：不 import vue/pinia，Worker 里也要用。
 */

export interface DepthModelPreset {
  /** HF 仓库 id，同时是缓存标识 */
  id: string
  name: string
  /** 下载体积（全部必需文件之和，实测字节） */
  bytes: number
  /** 单张推理耗时的量级，用于 UI 提示 */
  approxMs: number
  mobileFriendly: boolean
  blurb: string
}

export const DEPTH_PRESETS: readonly DepthModelPreset[] = Object.freeze([
  {
    id: 'onnx-community/depth-anything-v2-small',
    name: 'Depth Anything V2 Small',
    bytes: 27_258_801 + 38 + 461,
    approxMs: 3000,
    mobileFriendly: false,
    blurb:
      '给立绘估算深度，用来做真正的视差。实测在二次元插画上也能干净地分出人物、前景遮挡物与背景 —— 它虽然是照片数据训练的，但对插画一样有效。单张约 3 秒，只在上传图片时算一次并永久缓存。',
  },
])

export const DEFAULT_DEPTH_PRESET_ID = 'onnx-community/depth-anything-v2-small'

export function findDepthPreset(id: string): DepthModelPreset | undefined {
  return DEPTH_PRESETS.find((p) => p.id === id)
}

/**
 * 生成深度图时把立绘缩到的长边。
 *
 * 512 是实测拐点：384 与 512 耗时相同（都约 3.0s，模型内部按 ~518 的倍数处理），
 * 而 768 会跳到 14.8s —— 超过内部分辨率后计算量直接翻五倍。
 * 深度本身是低频信息，512 对视差完全够用，再高只是白烧 CPU 和存储。
 */
export const DEPTH_MAX_EDGE = 512

/** 深度估计的 pipeline 任务名，与 transformers 的注册表一致 */
export const DEPTH_TASK = 'depth-estimation'
/** 与嵌入模型一致：单文件 q8，不用外部权重格式（见 embedder.worker 的说明） */
export const DEPTH_DTYPE = 'q8'
