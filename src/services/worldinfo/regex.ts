/**
 * 世界书关键词的正则支持。
 *
 * 对齐 SillyTavern world-info.js:2821 parseRegexFromString，但修掉了上游两个 bug：
 *  - `.replace('\\/', '/')` 是字符串替换，只解转义第一个斜杠 → 改成 replaceAll
 *  - 保留 `g` 标志会让 `RegExp.test()` 带 lastIndex 状态，同一 key 连续匹配结果不同
 *    （非确定性 bug，排查代价极高）→ 一律剥掉 g
 */

const CACHE = new Map<string, RegExp | null>()

export function parseRegexFromString(input: string): RegExp | null {
  const cached = CACHE.get(input)
  if (cached !== undefined) return cached

  const result = compile(input)
  // 缓存无上限风险不大（key 数量有限），但仍设个软上限
  if (CACHE.size > 2000) CACHE.clear()
  CACHE.set(input, result)
  return result
}

function compile(input: string): RegExp | null {
  const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/)
  if (!match) return null
  const pattern = match[1]
  const flags = match[2]
  if (pattern === undefined || flags === undefined) return null
  // 模式里未转义的 / 说明这不是合法的正则字面量
  if (/(^|[^\\])\//.test(pattern)) return null
  try {
    // 必须剥掉 g：test() 会带 lastIndex 状态
    return new RegExp(pattern.replaceAll('\\/', '/'), flags.replace(/g/g, ''))
  } catch {
    return null
  }
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
