/**
 * Node ESM 解析钩子：让 `node` 能直接跑本项目的 TypeScript 源码。
 *
 * ## 为什么需要它
 * 项目用 `moduleResolution: bundler`，源码里的相对导入**不带扩展名**
 * （`import { wrap } from './torus'`），别名用 `@/`。Vite 能解析这两种，
 * 但 Node 的 ESM 解析器两种都不认 —— 于是「写个脚本验证一下这个纯函数」
 * 这件最基本的事在本项目里原本做不到（没有 vitest、没有 tsx）。
 *
 * Node 24 自带 TS 类型剥离，缺的只是解析。这个钩子补上：
 *   1. `@/x`      → `<root>/src/x`
 *   2. `./x`      → 依次试 `./x.ts` / `./x.tsx` / `./x/index.ts`
 *
 * 用法：
 *   node --import ./scripts/ts-register.mjs scripts/verify-flow.ts
 *
 * ⚠️ 只用于本地验证脚本。生产构建走 Vite，与这里无关。
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const SRC = path.join(ROOT, 'src')

const CANDIDATE_SUFFIXES = ['.ts', '.tsx', '/index.ts', '/index.tsx']

function firstExisting(basePath) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = basePath + suffix
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  // 1) @/ 别名
  if (specifier.startsWith('@/')) {
    const base = path.join(SRC, specifier.slice(2))
    const hit = existsSync(base) && path.extname(base) ? base : firstExisting(base)
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
  }

  // 2) 无扩展名的相对导入
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : ROOT
    const base = path.resolve(path.dirname(parentPath), specifier)
    const hit = firstExisting(base)
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true }
  }

  return nextResolve(specifier, context)
}
