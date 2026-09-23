import { getDb } from '../schema'
import { toPlain } from '../plain'
import { defaultSettings, type ModelService, type Settings } from '@/types/settings'
import { newImageModelService } from '@/types/image'

/**
 * 按**默认值的形状**合并：只有类型对得上的值才允许覆盖默认值。
 *
 * ⚠️ 展开运算符只兜「键不存在」，兜不住「键存在但值是 null」——
 * `{ ...d.provider, ...existing.provider }` 里一个 `extraHeaders: null`
 * 会原样把默认的 `{}` 盖掉。而 `applyBackup` 是零校验原样回写：手改过的备份、
 * 别的工具导出的、老版本写的，都可能带着 null 叶子进来。
 *
 * 后果**持久且致命**，三条都验证过：
 *  - `provider.extraHeaders: null` → `providerConfig()` 里 `Object.keys(null)` 抛，
 *    **每一次发送都失败**；
 *  - `provider.stop: null` → 拼停止词时 `p.stop.length` 抛，单聊与群聊两条路都断；
 *  - `worldInfo.globalBookIds: null` → 世界书页渲染时 `.includes()` 抛（白屏），
 *    删世界书也一起失败。
 *
 * 这一行存在库里，重启依旧 —— 只有清站点数据能恢复，而那会把 API Key 一起赔进去
 * （`schema.ts` 里记着同一类事故）。原来那段注释只推演了「键缺失」这一种情形，
 * 所以 `?.` 只出现在容器上、从没落到叶子上。
 *
 * 规则：
 *  - 数组只认数组；
 *  - 对象逐键递归，但**先把 raw 原样铺进去**再逐键收敛 —— `extraHeaders` 这种
 *    「默认为空、键由用户自定」的字段才不会被递归清空；
 *  - 基本类型只认 `typeof` 相同且非 null 的值。
 *
 * `defaultSettings()` 里没有任何 null/undefined 默认值，所以「按默认值定形状」
 * 这个前提是成立的。
 */
function coalesce<T>(def: T, raw: unknown): T {
  if (Array.isArray(def)) return (Array.isArray(raw) ? raw : def) as T
  if (def !== null && typeof def === 'object') {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return def
    const src = raw as Record<string, unknown>
    const out: Record<string, unknown> = { ...src }
    for (const [k, dv] of Object.entries(def as Record<string, unknown>)) {
      out[k] = coalesce(dv, src[k])
    }
    return out as T
  }
  return (raw !== null && typeof raw === typeof def ? raw : def) as T
}

/** 读取全局配置；不存在则写入默认值。同时按默认值的形状补齐，见 coalesce */
export async function load(): Promise<Settings> {
  const db = await getDb()
  const existing = await db.get('settings', 'app')
  if (!existing) {
    const s = defaultSettings()
    await db.put('settings', toPlain(s))
    return s
  }
  const s = coalesce(defaultSettings(), existing)
  if (!Array.isArray(existing.modelServices)) {
    // 保留旧 secretRef，已有密钥无需重新输入。
    s.modelServices = [{ id: 'default', name: '默认服务', provider: s.provider }]
    s.activeModelServiceId = 'default'
  } else {
    const ids = new Set<string>()
    s.modelServices = existing.modelServices.flatMap((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      const service = coalesce<ModelService>(
        { id: '', name: '', provider: defaultSettings().provider },
        raw,
      )
      if (!service.id || ids.has(service.id)) return []
      ids.add(service.id)
      service.name = service.name.trim() || '未命名服务'
      const rawProvider = (raw as { provider?: { secretRef?: unknown } }).provider
      if (typeof rawProvider?.secretRef !== 'string' || !rawProvider.secretRef) {
        service.provider.secretRef = `model-service:${service.id}`
      }
      const cache = service.provider.modelCache
      if (cache) {
        service.provider.modelCache = {
          at: typeof cache.at === 'number' ? cache.at : 0,
          ids: Array.isArray(cache.ids) ? cache.ids.filter((id) => typeof id === 'string') : [],
        }
      }
      return [service]
    })
  }
  const active =
    s.modelServices.find((service) => service.id === s.activeModelServiceId) ?? s.modelServices[0]
  s.activeModelServiceId = active?.id ?? ''
  s.provider = active?.provider ?? defaultSettings().provider
  const imageIds = new Set<string>()
  s.imageModelServices = s.imageModelServices.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const service = coalesce(newImageModelService(''), raw)
    if (!service.id || imageIds.has(service.id)) return []
    imageIds.add(service.id)
    service.name = service.name.trim() || '未命名文生图配置'
    // 文生图密钥使用独立命名空间，不接受导入数据中的共享引用。
    service.secretRef = `image-service:${service.id}`
    if (!['openai', 'comfyui'].includes(service.backend)) service.backend = 'openai'
    if (!['', 'b64_json', 'url'].includes(service.responseFormat)) service.responseFormat = ''
    if (!['', 'multipart', 'json'].includes(service.referenceMode)) service.referenceMode = ''
    // ComfyUI(Qwen) 数值字段夹取到安全范围（coalesce 已保证是 number）
    service.steps = Number.isFinite(service.steps)
      ? Math.min(100, Math.max(1, Math.round(service.steps)))
      : 12
    service.cfg = Number.isFinite(service.cfg) ? Math.min(30, Math.max(0, service.cfg)) : 1
    // Qwen 只出方图：分辨率单值(32 的倍数)。老记录若存过 width/height（SDXL 时期），取其一回填。
    const rawObj = raw as Record<string, unknown>
    const clampRes = (n: number) => Math.min(2048, Math.max(256, Math.round(n / 32) * 32))
    const legacyWH = Number(rawObj.width) || Number(rawObj.height)
    service.resolution =
      Number.isFinite(service.resolution) && service.resolution >= 256
        ? clampRes(service.resolution)
        : Number.isFinite(legacyWH) && legacyWH >= 256
          ? clampRes(legacyWH)
          : 1024
    // 清掉已废弃的 width/height（coalesce 的 {...src} 会把它们原样带进来）
    delete (service as unknown as Record<string, unknown>).width
    delete (service as unknown as Record<string, unknown>).height
    service.denoise = Number.isFinite(service.denoise)
      ? Math.min(1, Math.max(0.1, service.denoise))
      : 1
    return [service]
  })
  if (!s.imageModelServices.some((service) => service.id === s.activeImageModelServiceId)) {
    s.activeImageModelServiceId = s.imageModelServices[0]?.id ?? ''
  }
  return s
}

export async function save(s: Settings): Promise<void> {
  s.updatedAt = Date.now()
  const db = await getDb()
  await db.put('settings', toPlain(s))
}
