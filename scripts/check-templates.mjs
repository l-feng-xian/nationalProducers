/**
 * 模板静态检查 —— 补 vue-tsc 看不见的那一类错误。
 *
 * 目前只查一条，但它已经咬过三次：
 *   在 Vue 模板里写字面量 `{{ '{{char}}' }}` 会被解析器在**内层 `}}`** 提前闭合插值，
 *   编译直接失败（Unterminated string constant），而 `npm run type-check` 完全不报。
 *   正确做法：在 <script setup> 里定义常量 `const CHAR_MACRO = '{{char}}'`，模板写 `{{ CHAR_MACRO }}`。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.vue')) out.push(p)
  }
  return out
}

/** 插值里出现嵌套的 {{ …}} 字面量 */
const NESTED_MUSTACHE = /\{\{[^}]*\{\{/

let bad = 0
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8')
  const tpl = src.match(/<template>([\s\S]*)<\/template>/)
  if (!tpl?.[1]) continue
  const lines = tpl[1].split('\n')
  lines.forEach((line, i) => {
    if (!NESTED_MUSTACHE.test(line)) return
    bad++
    console.error(
      `${relative(ROOT, file)}:${i + 1}  模板插值里嵌套了 {{ }}，Vue 会提前闭合导致编译失败\n    ${line.trim()}\n    → 改用 <script setup> 常量，例如 const CHAR_MACRO = '{{char}}' 再写 {{ CHAR_MACRO }}`,
    )
  })
}

if (bad) {
  console.error(`\n✗ 模板检查未通过：${bad} 处`)
  process.exit(1)
}
console.log('✓ 模板检查通过')
