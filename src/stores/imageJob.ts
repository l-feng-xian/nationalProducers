import { defineStore } from 'pinia'
import { ref, shallowRef } from 'vue'
import router from '@/router'
import type { GeneratedImage, ImageRefCandidate } from '@/types/image'

/** 传给 ImageGenerationDialog 的参数（App.vue 里 v-bind 整个对象） */
export interface ImageJobProps {
  title: string
  applyLabel: string
  apply: (image: GeneratedImage) => Promise<void>
  candidates?: ImageRefCandidate[]
  defaultSelected?: string[]
  requireReferences?: boolean
  buildPrompt?: (refs: ImageRefCandidate[]) => string
  generatePrompt?: (signal: AbortSignal, refs: ImageRefCandidate[]) => Promise<string>
  size?: string
}

/** 等聊天页去执行的「定位到配图」 */
export interface RevealRequest {
  chatId: string
  messageId: string
  blobId?: string
}

/**
 * 聊天页的配图任务，**挂在应用层**而不是聊天页里。
 *
 * 为什么：配图可以最小化后继续做别的事。手机上聊天页是二级页，一个返回手势就离开了 ——
 * 对话框若长在 ChatView 里，页面一卸载，生成请求就跟着被取消。放到 App.vue 渲染，
 * 离开聊天页、去角色页、再回来，生成都不受影响；完成后的「查看」提示再把人带回原会话。
 *
 * 同一时刻只有一个任务：再点「生成配图」会把最小化的那个展开，而不是开第二个。
 */
export const useImageJobStore = defineStore('imageJob', () => {
  const job = shallowRef<ImageJobProps | null>(null)
  const minimized = ref(false)
  const reveal = ref<RevealRequest | null>(null)

  /** 开一个任务；已有任务时把它展开并返回 false */
  function start(props: ImageJobProps): boolean {
    if (job.value) {
      minimized.value = false
      return false
    }
    job.value = props
    minimized.value = false
    return true
  }

  function finish() {
    job.value = null
    minimized.value = false
  }

  /** 定位到配图：不在那个会话就先跳过去，由 ChatView 看到 reveal 后滚动并高亮 */
  async function requestReveal(req: RevealRequest) {
    reveal.value = req
    const path = `/chat/${req.chatId}`
    if (router.currentRoute.value.path !== path) await router.push(path)
  }

  return { job, minimized, reveal, start, finish, requestReveal }
})
