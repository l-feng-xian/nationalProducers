/**
 * 一次生图最多带几张参考图，按后端定。
 *
 * - ComfyUI（本机 Qwen-Image，6GB 显存）：每多一张参考图就多一份 reference latent 与视觉 token，
 *   3 张以上明显变慢且容易 OOM，人物多了面孔与服饰也更容易互相串；
 * - OpenAI 兼容接口（gpt-image 系 /images/edits 的 image[]）：服务端处理，放宽到 6 张。
 */
import type { ImageModelService } from '@/types/image'

export const MAX_REFERENCES = { comfyui: 3, openai: 6 } as const

export function maxReferencesFor(service: Pick<ImageModelService, 'backend'> | undefined): number {
  return service?.backend === 'comfyui' ? MAX_REFERENCES.comfyui : MAX_REFERENCES.openai
}
