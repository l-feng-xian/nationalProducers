import { getDb } from '../schema'
import { toPlain } from '../plain'
import { defaultSettings, type Settings } from '@/types/settings'

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
  return coalesce(defaultSettings(), existing)
}

export async function save(s: Settings): Promise<void> {
  s.updatedAt = Date.now()
  const db = await getDb()
  await db.put('settings', toPlain(s))
}
