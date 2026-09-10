/**
 * Tavern 角色卡 PNG 编解码（纯浏览器，无 pako 依赖）。
 *
 * 卡片数据以 base64 JSON 存在 PNG 的 tEXt/zTXt 块里，关键字 `ccv3`（v3）或 `chara`（v2）。
 * 改编自 sillyTavernTauri/src/services/{import/pngCard.ts,export/card.ts}，
 * 补齐了 noUncheckedIndexedAccess 下的边界守卫。
 */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10]

interface PngTextChunk {
  keyword: string
  compressed: boolean
  /** 原始文本字节（zTXt 时仍是压缩态） */
  data: Uint8Array
}

function readUint32(b: Uint8Array, off: number): number {
  const a = b[off] ?? 0
  const c = b[off + 1] ?? 0
  const d = b[off + 2] ?? 0
  const e = b[off + 3] ?? 0
  return ((a << 24) | (c << 16) | (d << 8) | e) >>> 0
}

function latin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] ?? 0)
  return s
}

function parseTextChunks(bytes: Uint8Array): PngTextChunk[] {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bytes[i] !== PNG_SIG[i]) throw new Error('不是有效的 PNG 文件')
  }
  const chunks: PngTextChunk[] = []
  let off = 8
  while (off + 8 <= bytes.length) {
    const len = readUint32(bytes, off)
    const type = latin1(bytes.subarray(off + 4, off + 8))
    const dataStart = off + 8
    const data = bytes.subarray(dataStart, dataStart + len)
    if (type === 'tEXt' || type === 'zTXt') {
      const nul = data.indexOf(0)
      if (nul !== -1) {
        const keyword = latin1(data.subarray(0, nul))
        chunks.push(
          type === 'tEXt'
            ? { keyword, compressed: false, data: data.subarray(nul + 1) }
            : // zTXt: keyword \0 compressionMethod(1byte) compressedText
              { keyword, compressed: true, data: data.subarray(nul + 2) },
        )
      }
    }
    if (type === 'IEND') break
    off = dataStart + len + 4 // 跳过 data + CRC
  }
  return chunks
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  // zTXt 用 zlib(RFC1950) → DecompressionStream('deflate')
  const ds = new DecompressionStream('deflate')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

function decodeBase64Json(text: string): unknown {
  const binary = atob(text.trim())
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return JSON.parse(new TextDecoder('utf-8').decode(bytes))
}

/** 从 PNG 里读出原始角色卡 JSON（v1/v2/v3 皆可），失败抛错 */
export async function readCharaFromPng(bytes: Uint8Array): Promise<unknown> {
  const chunks = parseTextChunks(bytes)
  for (const keyword of ['ccv3', 'chara']) {
    const chunk = chunks.find((c) => c.keyword.toLowerCase() === keyword)
    if (!chunk) continue
    const textBytes = chunk.compressed ? await inflate(chunk.data) : chunk.data
    return decodeBase64Json(latin1(textBytes))
  }
  throw new Error('这张 PNG 里没有角色卡数据（缺少 chara/ccv3 块）')
}

// ─────────────────────────── 写入 ───────────────────────────

/** 标准 zlib CRC-32（已对齐官方测试向量 cbf43926） */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] ?? 0
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

function textChunk(keyword: string, text: string): Uint8Array {
  const enc = new TextEncoder()
  const kw = enc.encode(keyword)
  const val = enc.encode(text)
  const body = new Uint8Array(kw.length + 1 + val.length)
  body.set(kw, 0)
  body[kw.length] = 0
  body.set(val, kw.length + 1)

  const type = enc.encode('tEXt')
  const crcInput = new Uint8Array(type.length + body.length)
  crcInput.set(type, 0)
  crcInput.set(body, type.length)

  const chunk = new Uint8Array(12 + body.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, body.length)
  chunk.set(type, 4)
  chunk.set(body, 8)
  view.setUint32(chunk.length - 4, crc32(crcInput))
  return chunk
}

function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** 把角色卡 JSON 作为 tEXt 块插进 PNG（IHDR 之后） */
export function buildCardPng(png: Uint8Array, cardJson: string): Uint8Array {
  const b64 = toBase64Utf8(cardJson)
  const ccv3 = textChunk('ccv3', b64)
  const chara = textChunk('chara', b64)

  // 签名(8) + IHDR(4长度 + 4类型 + 13数据 + 4CRC = 25)
  const insertAt = 8 + 25
  const out = new Uint8Array(png.length + ccv3.length + chara.length)
  out.set(png.subarray(0, insertAt), 0)
  out.set(ccv3, insertAt)
  out.set(chara, insertAt + ccv3.length)
  out.set(png.subarray(insertAt), insertAt + ccv3.length + chara.length)
  return out
}
