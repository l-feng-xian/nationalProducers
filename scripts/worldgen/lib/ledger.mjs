/**
 * 生成账本：缓存去重 + 断点续跑 + 精确成本记账。
 *
 * ## ⭐ 缓存键**包含 prompt**
 * 键 = sha256(模型, prompt 全文, size, n, 参考图内容哈希, promptVersion)。
 *
 * 于是：
 *   - 重跑脚本 = 零花费（键没变，直接跳过）
 *   - 改了 prompt 的任何一个字 = 键变了，自动重出（不会拿着旧图当新结果）
 *   - 换了风格母版 = 参考图哈希变了，全部重出（这是对的：母版换了风格就变了）
 *
 * ## ⚠️ 账本必须原子写
 * 每完成一个 job 就落一次盘，写法是 `写 .tmp → rename`。
 * 直接覆写的话，中途 Ctrl+C 会留下半截 JSON —— 下次启动解析失败，
 * 整个账本作废，已经花掉的钱全部要重花一遍。
 */

import { createHash } from 'node:crypto'
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/** 固定键序序列化，保证同样的输入永远得到同样的键 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
    .join(',')}}`
}

export function cacheKeyOf({ model, prompt, size, n, refHashes, promptVersion }) {
  return sha256(stable({ model, prompt, size, n, refHashes, promptVersion })).slice(0, 12)
}

export class Ledger {
  constructor(file) {
    this.file = file
    this.data = { runStartedAt: new Date().toISOString(), usdAtStart: null, jobs: {} }
  }

  async load() {
    if (!existsSync(this.file)) return this
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed.jobs) this.data = parsed
    } catch {
      // ⚠️ 解析失败不能静默清空 —— 那会让「已经花过钱的记录」凭空消失，
      // 下次跑就是全额重花。改名留证，让人能看到出了什么事。
      const broken = this.file + '.broken-' + Date.now()
      await rename(this.file, broken).catch(() => {})
      console.warn(`⚠️  账本解析失败，已保留为 ${path.basename(broken)}；本次从空账本开始`)
    }
    return this
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(tmp, this.file)
  }

  get(id) {
    return this.data.jobs[id]
  }

  /**
   * 命中条件：键一致、状态不是 failed、**被采纳的候选正是这个键出的**、且文件还在。
   *
   * ⚠️ 最后那条不是画蛇添足，见 `addCandidate`。
   */
  isFresh(id, key, rootDir) {
    const job = this.data.jobs[id]
    if (!job || job.cacheKey !== key || job.status === 'failed') return false
    const picked = this.picked(id)
    if (!picked) return false
    // 老账本的候选没有 cacheKey 字段，放行（那时只可能有一个键）
    if (picked.cacheKey !== undefined && picked.cacheKey !== key) return false
    return existsSync(path.resolve(rootDir, picked.file))
  }

  /** 当前采纳的候选 */
  picked(id) {
    const job = this.data.jobs[id]
    return job?.candidates?.[job?.picked ?? 0]
  }

  record(id, patch) {
    this.data.jobs[id] = { ...(this.data.jobs[id] ?? {}), ...patch }
  }

  /**
   * 追加一个候选。
   *
   * ## ⚠️ 新键出的图必须自动被采纳
   * 早先这里写的是 `job.picked = job.picked ?? 0` —— 改了 prompt 重出之后，
   * `picked` 仍然是 0，指着**上一版的旧图**。于是：
   *   - 钱照花（$0.09/张）
   *   - 账本记成功、`cacheKey` 也更新成新键
   *   - 切图、入引擎、验收看到的全是旧图
   * 表现是「改了提示词画面毫无变化」，而最自然的反应是**再花一次钱重写措辞**。
   * 这个 bug 会一直悄悄乘以重试次数。
   *
   * 现在的规则：候选自带它是哪个键出的；键换了就把 `picked` 移到本轮第一个候选。
   * 同一个键内追加（`--n 4` 出多候选）则保持不动，人工挑图的选择不会被覆盖。
   */
  addCandidate(id, candidate) {
    const job = this.data.jobs[id] ?? { candidates: [] }
    const list = [...(job.candidates ?? []), candidate]
    job.candidates = list
    const current = list[job.picked ?? -1]
    if (!current || current.cacheKey !== candidate.cacheKey) job.picked = list.length - 1
    this.data.jobs[id] = job
  }

  /** 从账本里累计实际花费（分） */
  totalSpentCents() {
    let sum = 0
    for (const job of Object.values(this.data.jobs)) {
      for (const c of job.candidates ?? []) {
        if (Number.isFinite(c.usdAfter) && Number.isFinite(c.usdBefore)) {
          sum += c.usdAfter - c.usdBefore
        }
      }
    }
    return sum
  }
}
