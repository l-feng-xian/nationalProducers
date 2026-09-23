import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { settingsRepo, secretsRepo } from '@/db/repositories'
import { defaultSettings, type ModelService, type Settings } from '@/types/settings'
import { toPlain } from '@/utils/plain'
import { setRemoteHost } from '@/services/ml/downloadHost'
import type { ImageModelService } from '@/types/image'

/**
 * 全局配置。写路径：先改内存（乐观）→ 防抖落盘。
 * API Key 不在 Settings 里，单独走 secrets store。
 */
export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(defaultSettings())
  const loaded = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  // 下载源是纯 service 模块里的一份状态（Worker 宿主要读它塞进消息，而它们不能 import pinia）。
  // 这里把设置同步过去：immediate 覆盖初始默认，load() 换掉 settings.value 后也会再同步一次。
  watch(() => settings.value.modelDownloadHost, (h) => setRemoteHost(h), { immediate: true })

  const isConfigured = computed(
    () => !!settings.value.provider.baseUrl && !!settings.value.provider.model,
  )
  const activeImageService = computed(() =>
    settings.value.imageModelServices.find(
      (item) => item.id === settings.value.activeImageModelServiceId,
    ),
  )

  async function load() {
    settings.value = await settingsRepo.load()
    loaded.value = true
  }

  function flushSoon() {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void settingsRepo.save(settings.value)
    }, 400)
  }

  /** 浅合并顶层字段；嵌套字段直接改 settings.value.xxx 后调 touch() */
  function patch(partial: Partial<Settings>) {
    settings.value = { ...settings.value, ...partial }
    flushSoon()
  }

  /** 直接改了嵌套字段后调用，触发落盘 */
  function touch() {
    flushSoon()
  }

  async function flushNow() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    await settingsRepo.save(settings.value)
  }

  async function getApiKey(secretRef = settings.value.provider.secretRef): Promise<string> {
    return secretsRepo.get(secretRef)
  }

  async function setApiKey(
    value: string,
    secretRef = settings.value.provider.secretRef,
  ): Promise<void> {
    await secretsRepo.set(secretRef, value)
  }

  function activateService(id: string) {
    const service = settings.value.modelServices.find((item) => item.id === id)
    settings.value.activeModelServiceId = service?.id ?? ''
    settings.value.provider = service?.provider ?? defaultSettings().provider
  }

  async function saveModelService(service: ModelService, apiKey: string) {
    const saved = toPlain(service)
    await setApiKey(apiKey.trim(), saved.provider.secretRef)
    const index = settings.value.modelServices.findIndex((item) => item.id === saved.id)
    if (index >= 0) settings.value.modelServices[index] = saved
    else settings.value.modelServices.push(saved)
    activateService(settings.value.activeModelServiceId || saved.id)
    await flushNow()
  }

  async function selectModelService(id: string) {
    if (!settings.value.modelServices.some((service) => service.id === id)) return
    activateService(id)
    await flushNow()
  }

  async function removeModelService(id: string) {
    const service = settings.value.modelServices.find((item) => item.id === id)
    if (!service) return
    settings.value.modelServices = settings.value.modelServices.filter((item) => item.id !== id)
    if (settings.value.activeModelServiceId === id) {
      activateService(settings.value.modelServices[0]?.id ?? '')
    }
    await flushNow()
    if (
      !settings.value.modelServices.some(
        (item) => item.provider.secretRef === service.provider.secretRef,
      ) &&
      !settings.value.imageModelServices.some(
        (item) => item.secretRef === service.provider.secretRef,
      )
    ) {
      await secretsRepo.remove(service.provider.secretRef)
    }
  }

  async function saveImageModelService(service: ImageModelService, apiKey: string) {
    const saved = toPlain(service)
    saved.secretRef = `image-service:${saved.id}`
    await setApiKey(apiKey.trim(), saved.secretRef)
    const index = settings.value.imageModelServices.findIndex((item) => item.id === saved.id)
    if (index >= 0) settings.value.imageModelServices[index] = saved
    else settings.value.imageModelServices.push(saved)
    if (!settings.value.activeImageModelServiceId)
      settings.value.activeImageModelServiceId = saved.id
    await flushNow()
  }

  async function selectImageModelService(id: string) {
    if (!settings.value.imageModelServices.some((item) => item.id === id)) return
    settings.value.activeImageModelServiceId = id
    await flushNow()
  }

  /** 回写参考图请求格式的自适应缓存，避免每次生成先白跑一趟被拒的请求。 */
  async function patchImageReferenceMode(id: string, mode: 'multipart' | 'json') {
    const service = settings.value.imageModelServices.find((item) => item.id === id)
    if (!service || service.referenceMode === mode) return
    service.referenceMode = mode
    // 立即落盘：防抖会与刷新/退出竞态，丢掉这次写入就会退回探测模式。
    await flushNow()
  }

  async function removeImageModelService(id: string) {
    const service = settings.value.imageModelServices.find((item) => item.id === id)
    if (!service) return
    settings.value.imageModelServices = settings.value.imageModelServices.filter(
      (item) => item.id !== id,
    )
    if (settings.value.activeImageModelServiceId === id) {
      settings.value.activeImageModelServiceId = settings.value.imageModelServices[0]?.id ?? ''
    }
    await flushNow()
    if (
      !settings.value.modelServices.some((item) => item.provider.secretRef === service.secretRef)
    ) {
      await secretsRepo.remove(service.secretRef)
    }
  }

  return {
    settings,
    loaded,
    isConfigured,
    activeImageService,
    load,
    patch,
    touch,
    flushNow,
    getApiKey,
    setApiKey,
    saveModelService,
    selectModelService,
    removeModelService,
    saveImageModelService,
    selectImageModelService,
    patchImageReferenceMode,
    removeImageModelService,
  }
})
