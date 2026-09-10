/**
 * SFC 模板编译检查 —— 补 vue-tsc 看不见的那一整类错误。
 *
 * `vue-tsc` 只做类型检查，**不会**报模板编译错误。已经咬过的两类：
 *   1. 模板里写字面 `{{ '{{char}}' }}` → 内层 `}}` 提前闭合插值
 *   2. 多语句内联 handler（尤其带换行的）→ 表达式解析失败
 * 两者都只在浏览器打开那个页面时才炸，改完不跑一遍根本发现不了。
 *
 * 这里直接调用 Vue 自己的编译器，任何模板编译错误都能提前拦下。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, compileTemplate } from 'vue/compiler-sfc'

const ROOT = fileURLToPath(new URL('../src', import.meta.url))

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}

let bad = 0
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const source = readFileSync(file, 'utf8')

  const { descriptor, errors } = parse(source, { filename: rel })
  for (const e of errors) {
    bad++
    console.error(`${rel}: SFC 解析失败 — ${e.message}`)
  }
  if (!descriptor.template) continue

  const res = compileTemplate({
    source: descriptor.template.content,
    filename: rel,
    id: rel,
    // 让编译器按 <script setup> 的方式处理，与实际构建一致
    compilerOptions: { expressionPlugins: ['typescript'] },
  })
  for (const e of res.errors) {
    bad++
    const msg = typeof e === 'string' ? e : e.message
    const loc = typeof e === 'object' && e.loc ? `:${e.loc.start.line}` : ''
    console.error(`${rel}${loc}: 模板编译失败 — ${msg}`)
    if (typeof e === 'object' && e.loc?.start.line) {
      const line = descriptor.template.content.split('\n')[e.loc.start.line - 1]
      if (line) console.error(`    ${line.trim()}`)
    }
  }
}

if (bad) {
  console.error(`\n✗ 模板检查未通过：${bad} 处`)
  process.exit(1)
}
console.log('✓ 模板检查通过')
