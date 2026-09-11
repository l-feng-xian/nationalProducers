/**
 * 字节与文本之间的通用转换。
 *
 * 与 services/io/pngCard.ts 里那几个私有 helper 刻意不合并：那边的 `latin1` 是为了
 * 不破坏 PNG 块偏移、`inflate` 收的是 zlib(RFC1950) 包装、`crc32` 是给 PNG 块校验用的，
 * 全是 PNG 格式专用。这里只放跟格式无关的基础件。
 */

/** base64url：把 `+/` 换成 `-_` 并去掉 `=`，可直接塞进二维码与 URL */
export function bytesToBase64url(b: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i] ?? 0)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64urlToBytes(s: string): Uint8Array {
  const norm = s.replace(/-/g, '+').replace(/_/g, '/')
  // atob 要求长度是 4 的倍数，补回被去掉的 =
  const bin = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 十六进制串转字节。分隔符（如指纹里的冒号）会被忽略 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length % 2) throw new Error('十六进制串长度必须是偶数')
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** 字节转十六进制，`sep` 用于还原 SDP 指纹那种冒号分隔的写法 */
export function bytesToHex(b: Uint8Array, sep = ''): string {
  const parts: string[] = []
  for (let i = 0; i < b.length; i++) parts.push((b[i] ?? 0).toString(16).padStart(2, '0'))
  return parts.join(sep)
}

/**
 * 走 Blob().stream().pipeThrough() 而不是自己 getWriter()：
 * 一来 TS6 下 `Uint8Array<ArrayBufferLike>` 喂不进 writer 的 BufferSource 重载，
 * 二来手写 writer 得留意「先 await write 再读 readable」会死锁。
 * pngCard.ts 里的 inflate 早就是这个写法，保持一致。
 */
async function pipe(
  data: Uint8Array,
  s: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(s)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

/**
 * deflate-raw（RFC1951，无 zlib/gzip 头）。
 * 同步的载荷是一大坨 JSON，压缩比很高；但里面的头像已是 base64 过的压缩图，
 * 那部分几乎压不动 —— 进度条要按**压缩后**的字节数走，否则会一路卡在末尾。
 */
export function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('deflate-raw'))
}

export function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('deflate-raw'))
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

export function fromUtf8(b: Uint8Array): string {
  return new TextDecoder().decode(b)
}
