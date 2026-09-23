/** 文生图配置与聊天模型分别选择，密钥仍保存在 secrets store。 */
export interface ImageModelService {
  id: string
  name: string
  /**
   * 后端类型。'openai' 走 OpenAI Images 兼容接口（一次 POST 返图）；
   * 'comfyui' 走本地 ComfyUI（/prompt→轮询 /history→/view）。
   * 旧记录缺省，load() 里 coalesce 会补成 'openai'。
   */
  backend: 'openai' | 'comfyui'
  baseUrl: string
  model: string
  secretRef: string
  proxyPrefix: string
  size: string
  quality: string
  responseFormat: '' | 'b64_json' | 'url'
  /**
   * 参考图请求格式的自适应缓存：'' 自动（先 multipart，被拒降级 JSON），
   * 'multipart'（OpenAI 标准）或 'json'（xAI image_urls）为已验证可用的格式，
   * 命中后只发一次请求。换用后端不同的服务时会自愈（失败即重试另一种并改写）。
   */
  referenceMode: '' | 'multipart' | 'json'
  // ── 以下仅 backend==='comfyui' 时生效（本地 Qwen-Image-2.1 工作流参数） ──
  // Qwen 由三份文件组成，分别用 UnetLoaderGGUF / CLIPLoader(qwen_image) / VAELoader 加载：
  //   model     = DiT（扩散主干）GGUF 文件名（如 Qwen-Image-2.1-Q4.gguf）
  //   clipName  = 文本编码器（如 qwen3vl_8b_w4a8.safetensors）
  //   vaeName   = VAE（如 qwen_image_2.1_vae_bf16.safetensors）
  /** 文本编码器文件名（CLIPLoader，type=qwen_image） */
  clipName: string
  /** VAE 文件名（VAELoader） */
  vaeName: string
  /** 负面提示词（CFG=1 时不生效，保留供高级用途） */
  negativePrompt: string
  /** 采样步数（Qwen-2.1 是引导蒸馏模型，12 步已足够；越多越慢） */
  steps: number
  /** CFG（Qwen-2.1 引导蒸馏，固定 1；改高会明显变慢且未必更好） */
  cfg: number
  /** 采样器 */
  sampler: string
  /** 调度器 */
  scheduler: string
  /**
   * 分辨率（方图边长，32 的倍数；Qwen-2.1 原生 1024）。Qwen 原生管线只出方图，
   * 尺寸由这一个值决定；图生图时参考图按它等比缩放。越大越慢。
   */
  resolution: number
  /** 图生图去噪强度：Qwen 编辑靠 reference_latents，用 1.0；降低会更贴近参考但改动更弱 */
  denoise: number
}

export function newImageModelService(id: string = crypto.randomUUID()): ImageModelService {
  return {
    id,
    name: '',
    backend: 'openai',
    baseUrl: '',
    model: '',
    secretRef: `image-service:${id}`,
    proxyPrefix: '',
    size: '',
    quality: '',
    responseFormat: '',
    referenceMode: '',
    // ComfyUI(Qwen-Image-2.1) 默认值：切到 comfyui 即带出一套本机已部署、实测可用的参数
    clipName: 'qwen3vl_8b_w4a8.safetensors',
    vaeName: 'qwen_image_2.1_vae_bf16.safetensors',
    negativePrompt: 'blurry, low quality, distorted, watermark, text',
    steps: 12,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'simple',
    resolution: 1024,
    denoise: 1,
  }
}

export interface GeneratedImage {
  blob: Blob
  prompt: string
  model: string
  serviceName: string
  /** 带参考图生成时实际成功的请求格式，供调用方更新 referenceMode 缓存。 */
  referenceMode?: 'multipart' | 'json'
}

/** 生成窗口固定本次所用的角色封面，不从后续路由或角色变更中重新取图。 */
export interface CharacterImageReference {
  characterId: string
  name: string
  blobId?: string
}

export interface ImageReferenceInput {
  name: string
  blob: Blob
}

export interface MessageImage {
  blobId: string
  prompt: string
  model: string
  serviceName: string
  createdAt: number
  /**
   * 像素尺寸，附图时探测一次存下来。用来在图真正解码出来之前就把高度占住：
   * 配图是从 IndexedDB 异步取 Blob 再 createObjectURL 的，不占位的话这一行会
   * 先塌成一行占位文字、再撑到最高 560px —— 虚拟滚动下每次滚回来都跳一次。
   * 老记录没有这两个字段，回退到原来的自适应高度。
   */
  width?: number
  height?: number
}
