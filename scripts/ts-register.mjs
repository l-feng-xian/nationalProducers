/**
 * 注册 ts-resolve.mjs 解析钩子。
 *
 * 用法： node --import ./scripts/ts-register.mjs <某个.ts脚本>
 */

import { register } from 'node:module'

register('./ts-resolve.mjs', import.meta.url)
