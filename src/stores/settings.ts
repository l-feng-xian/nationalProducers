import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { settingsRepo, secretsRepo } from '@/db/repositories'
import { defaultSettings, type Settings } from '@/types/settings'

/**
 * 全局配置。写路径：先改内存（乐观）→ 防抖落盘。
 * API Key 不在 Settings 里，单独走 secrets store。
 */
export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(defaultSettings())
  const loaded = ref(false)
  let timer: ReturnType<typeof setTimeout> | null = null

  const isConfigured = computed(
    () => !!settings.value.provider.baseUrl && !!settings.value.provider.model,
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

  async function getApiKey(): Promise<string> {
    return secretsRepo.get(settings.value.provider.secretRef)
  }

  async function setApiKey(value: string): Promise<void> {
    await secretsRepo.set(settings.value.provider.secretRef, value)
  }

  return { settings, loaded, isConfigured, load, patch, touch, flushNow, getApiKey, setApiKey }
})
