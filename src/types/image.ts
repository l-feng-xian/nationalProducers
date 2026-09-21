/** 文生图配置与聊天模型分别选择，密钥仍保存在 secrets store。 */
export interface ImageModelService {
  id: string
  name: string
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
}

export function newImageModelService(id: string = crypto.randomUUID()): ImageModelService {
  return {
    id,
    name: '',
    baseUrl: '',
    model: '',
    secretRef: `image-service:${id}`,
    proxyPrefix: '',
    size: '',
    quality: '',
    responseFormat: '',
    referenceMode: '',
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
}
