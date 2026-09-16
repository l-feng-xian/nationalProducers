/**
 * 凭据解析。
 *
 * ⚠️ 这个项目的 OPENAI_API_KEY / OPENAI_BASE_URL 只存在于 Windows 注册表的
 * HKCU\Environment 里，**当前 shell 的 process.env 取不到**（改过用户环境变量后
 * 已开着的终端不会继承，必须新开）。这是实测结论，不是猜测 —— 所以这里必须
 * 有一条注册表回退路径，否则脚本在开发机上直接跑不起来。
 *
 * ⚠️ OPENAI_BASE_URL 的值是 `https://api.yoshub.com`，**不带 /v1**。
 * 所有调用路径必须自己带上 /v1 前缀。
 *
 * 密钥永不打印、永不写盘、永不进 ledger。
 */

import { execFileSync } from 'node:child_process'

/**
 * 从注册表读一个用户环境变量。
 *
 * execFileSync 不过 shell，所以 `HKCU\Environment` 里的反斜杠不需要任何转义。
 * reg.exe 在中文 Windows 上按 GBK 输出，但 REG_SZ 的值本身是 ASCII，
 * 用 latin1 解码可无损拿到值（错误信息会乱码，但我们只看有没有匹配到）。
 */
function fromRegistry(name) {
  if (process.platform !== 'win32') return ''
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'latin1',
      windowsHide: true,
      timeout: 5000,
    })
    const m = out.match(/REG_(?:SZ|EXPAND_SZ)\s{2,}([^\r\n]*)/)
    return m ? m[1].trim() : ''
  } catch {
    return ''
  }
}

const DEFAULT_BASE_URL = 'https://api.yoshub.com'

/** 优先级：显式 CLI 参数 > process.env > 注册表 > 默认值 */
export function resolveCredentials(argv = {}) {
  const apiKey = argv.apiKey || process.env.OPENAI_API_KEY || fromRegistry('OPENAI_API_KEY')

  const rawBase =
    argv.baseUrl || process.env.OPENAI_BASE_URL || fromRegistry('OPENAI_BASE_URL') || DEFAULT_BASE_URL

  // 去掉尾斜杠；也容忍用户把 /v1 写进了环境变量（我们自己拼 /v1，重复会 404）
  const baseUrl = rawBase.replace(/\/+$/, '').replace(/\/v1$/, '')

  if (!apiKey) {
    throw new Error(
      [
        '找不到 OPENAI_API_KEY。依次尝试了 --api-key、process.env、HKCU\\Environment。',
        '',
        '临时用法：  node scripts/worldgen/probe.mjs --api-key sk-xxx',
        '或者：改过用户环境变量后**新开一个终端**再跑（已开着的终端不会继承）。',
      ].join('\n'),
    )
  }

  return { apiKey, baseUrl }
}

/** 只用于日志：永远不要打印完整密钥 */
export function maskKey(key) {
  if (!key || key.length < 12) return '***'
  return `${key.slice(0, 6)}...${key.slice(-4)}`
}
