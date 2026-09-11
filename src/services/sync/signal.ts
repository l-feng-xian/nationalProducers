/**
 * 把一份 WebRTC SDP 压成能塞进二维码的短串，再原样还原回去。
 *
 * 为什么不直接把 SDP 塞进二维码：实测纯 datachannel 的 SDP 是 587 字节，
 * deflate 之后 429 字节 —— 二维码要到版本 25（117×117 模块）才装得下，
 * 密到需要好摄像头加大屏幕才扫得动。而 SDP 里真正因会话而异的只有五样东西
 * （ufrag / pwd / 指纹 / 候选地址 / 端口），其余全是模板。只搬这五样是 **83 字节**，
 * base64url 之后 111 个字符，实测落在二维码版本 7（45×45 模块），手机一扫即中。
 *
 * 可行性是实测过的，不是推断：把 foundation 换成递增序号、priority 固定成
 * 2113937151、generation 与 network-cost 整个丢掉之后重建 SDP，两端照样连通、
 * 数据照样过得去。
 *
 * 纯 service：不 import vue/pinia。
 */

import { base64urlToBytes, bytesToBase64url, bytesToHex, hexToBytes } from '@/utils/bytes'

export type SignalKind = 'offer' | 'answer'

/** 协议版本。改动二进制布局时必须 +1，解码侧靠它给出人话报错而不是乱解 */
const VERSION = 1

/** 候选地址的三种形态 */
const ADDR_MDNS = 0
const ADDR_IPV4 = 1
const ADDR_IPV6 = 2

interface HostCandidate {
  address: string
  port: number
}

interface SignalFields {
  ufrag: string
  pwd: string
  /** SHA-256 指纹，冒号分隔的十六进制 */
  fingerprint: string
  candidates: HostCandidate[]
}

/**
 * 所有 host 候选。
 *
 * 只要 `typ host` —— 没配 STUN 时本来也只会有这一种，而这正是「只走局域网」的
 * 含义所在。srflx/relay 一旦出现反而说明流量绕出去了。
 */
function parseFields(sdp: string): SignalFields {
  const one = (re: RegExp, what: string): string => {
    const m = sdp.match(re)
    if (!m?.[1]) throw new Error(`SDP 里找不到 ${what}`)
    return m[1]
  }
  const candidates: HostCandidate[] = []
  for (const m of sdp.matchAll(/^a=candidate:\S+ \d+ udp \d+ (\S+) (\d+) typ host/gim)) {
    const address = m[1]
    const port = Number(m[2])
    if (address && Number.isFinite(port)) candidates.push({ address, port })
  }
  return {
    ufrag: one(/^a=ice-ufrag:(.+)$/m, 'ice-ufrag'),
    pwd: one(/^a=ice-pwd:(.+)$/m, 'ice-pwd'),
    fingerprint: one(/^a=fingerprint:sha-256 (.+)$/im, 'sha-256 指纹'),
    candidates,
  }
}

function encodeAddress(address: string): Uint8Array {
  // Chrome 出于隐私会把局域网 IP 换成 <uuid>.local 的 mDNS 名，这是最常见的一种
  if (address.endsWith('.local')) {
    const uuid = address.slice(0, -'.local'.length).replace(/-/g, '')
    if (uuid.length !== 32) throw new Error(`无法识别的 mDNS 候选：${address}`)
    return new Uint8Array([ADDR_MDNS, ...hexToBytes(uuid)])
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(address)) {
    const parts = address.split('.').map(Number)
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error(`无法识别的 IPv4 候选：${address}`)
    }
    return new Uint8Array([ADDR_IPV4, ...parts])
  }
  if (address.includes(':')) {
    return new Uint8Array([ADDR_IPV6, ...expandIpv6(address)])
  }
  throw new Error(`无法识别的候选地址：${address}`)
}

/** `::` 缩写展开成定长 16 字节 */
function expandIpv6(addr: string): Uint8Array {
  const [head = '', tail = ''] = addr.split('::', 2)
  const toWords = (s: string) => (s ? s.split(':').filter(Boolean) : [])
  const a = toWords(head)
  const b = addr.includes('::') ? toWords(tail) : []
  const fill = 8 - a.length - b.length
  if (fill < 0) throw new Error(`无法识别的 IPv6 候选：${addr}`)
  const words = [...a, ...Array<string>(addr.includes('::') ? fill : 0).fill('0'), ...b]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    const w = parseInt(words[i] ?? '0', 16)
    out[i * 2] = (w >> 8) & 0xff
    out[i * 2 + 1] = w & 0xff
  }
  return out
}

function decodeAddress(b: Uint8Array, off: number): { address: string; next: number } {
  const kind = b[off]
  if (kind === ADDR_MDNS) {
    const h = bytesToHex(b.subarray(off + 1, off + 17))
    const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
    return { address: `${uuid}.local`, next: off + 17 }
  }
  if (kind === ADDR_IPV4) {
    const p = Array.from(b.subarray(off + 1, off + 5))
    return { address: p.join('.'), next: off + 5 }
  }
  if (kind === ADDR_IPV6) {
    const words: string[] = []
    for (let i = 0; i < 8; i++) {
      words.push((((b[off + 1 + i * 2] ?? 0) << 8) | (b[off + 2 + i * 2] ?? 0)).toString(16))
    }
    return { address: words.join(':'), next: off + 17 }
  }
  throw new Error('配对码里有无法识别的候选地址类型')
}

function writeAscii(out: number[], s: string): void {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length > 255) throw new Error('ICE 凭据过长，无法编码')
  out.push(bytes.length, ...bytes)
}

/** 把 SDP 压成可放进二维码的短串 */
export function packSignal(sdp: string, kind: SignalKind): string {
  const f = parseFields(sdp)
  if (!f.candidates.length) {
    throw new Error('没有可用的局域网候选地址，可能网络接口被禁用了')
  }
  const fp = hexToBytes(f.fingerprint)
  if (fp.length !== 32) throw new Error('指纹长度异常，期望 SHA-256')

  const out: number[] = [(VERSION << 1) | (kind === 'answer' ? 1 : 0)]
  writeAscii(out, f.ufrag)
  writeAscii(out, f.pwd)
  out.push(...fp)
  out.push(f.candidates.length)
  for (const c of f.candidates) {
    out.push(...encodeAddress(c.address), (c.port >> 8) & 0xff, c.port & 0xff)
  }
  return bytesToBase64url(new Uint8Array(out))
}

/**
 * SDP 模板。
 *
 * foundation 用递增序号、priority 固定值、丢掉 generation 与 network-cost ——
 * 这些字段只影响候选配对的排序偏好，单候选场景下毫无差别，实测重建后照常连通。
 */
function buildSdp(f: SignalFields, kind: SignalKind): string {
  const lines = [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...f.candidates.map(
      (c, i) => `a=candidate:${i + 1} 1 udp 2113937151 ${c.address} ${c.port} typ host`,
    ),
    `a=ice-ufrag:${f.ufrag}`,
    `a=ice-pwd:${f.pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${f.fingerprint}`,
    // offer 声明「两个角色都行」，answer 必须挑一个定下来
    `a=setup:${kind === 'offer' ? 'actpass' : 'active'}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ]
  // 末尾必须留一个 CRLF，少了它 Chrome 会拒绝整份 SDP
  return lines.join('\r\n') + '\r\n'
}

export function unpackSignal(code: string): { kind: SignalKind; sdp: string } {
  let b: Uint8Array
  try {
    b = base64urlToBytes(code.trim())
  } catch {
    throw new Error('这不是本应用的配对码')
  }
  if (b.length < 40) throw new Error('这不是本应用的配对码')

  const head = b[0] ?? 0
  const version = head >> 1
  if (version !== VERSION) {
    throw new Error(
      `配对码版本不一致（对方 v${version}，本机 v${VERSION}），请把两台设备更新到同一版本`,
    )
  }
  const kind: SignalKind = (head & 1) === 1 ? 'answer' : 'offer'

  let off = 1
  const readAscii = (): string => {
    const len = b[off] ?? 0
    const s = new TextDecoder().decode(b.subarray(off + 1, off + 1 + len))
    off += 1 + len
    return s
  }
  const ufrag = readAscii()
  const pwd = readAscii()
  const fingerprint = bytesToHex(b.subarray(off, off + 32), ':').toUpperCase()
  off += 32

  const count = b[off] ?? 0
  off += 1
  const candidates: HostCandidate[] = []
  for (let i = 0; i < count; i++) {
    const { address, next } = decodeAddress(b, off)
    const port = ((b[next] ?? 0) << 8) | (b[next + 1] ?? 0)
    candidates.push({ address, port })
    off = next + 2
  }
  if (!ufrag || !pwd || !candidates.length) throw new Error('配对码内容不完整')

  return { kind, sdp: buildSdp({ ufrag, pwd, fingerprint, candidates }, kind) }
}
