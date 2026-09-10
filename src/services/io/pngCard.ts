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

/** 只看魔数判断是不是 PNG —— Blob.type 与文件扩展名都不可信 */
export function isPngBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (bytes[i] !== PNG_SIG[i]) return false
  }
  return true
}

/**
 * 标准 zlib CRC-32（已对齐官方测试向量 cbf43926）。
 * ST 侧的 png-chunks-extract 会逐块比对 CRC，错一个字节整文件被拒收 ——
 * 这段已验证过，不要为了「优化」改成查表版。
 */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i] ?? 0
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

/** 字符串按 Latin-1 逐字符取低 8 位。块类型与 tEXt keyword 都必须走这里，
 *  用 TextEncoder 会把 >0x7F 的字符编成 2 字节，静默把后续块的偏移推歪。 */
function latin1Bytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff
  return b
}

export interface PngChunk {
  /** 4 字节块类型，如 'IHDR' / 'tEXt' / 'IEND' */
  type: string
  /** 块数据段，不含 长度(4) / 类型(4) / CRC(4) */
  data: Uint8Array
}

/**
 * 把 PNG 拆成块表。校验：签名、首块必须是 13 字节的 IHDR、块长度不越界、必须有 IEND。
 * 对齐 ST 的 png-chunks-extract（同样硬失败），唯一差别是不校验各块 CRC ——
 * 我们输出时整体重算 CRC，而 IDAT 里的位翻转本来就让图显示不出来，
 * 为此拒绝导出一张浏览器还能显示的头像不划算。IEND 之后的尾部垃圾会被丢弃。
 */
export function splitPngChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPngBytes(bytes)) throw new Error('不是有效的 PNG 文件（签名不匹配）')
  const chunks: PngChunk[] = []
  let off = 8
  let sawIend = false
  while (off + 12 <= bytes.length) {
    const len = readUint32(bytes, off)
    const type = latin1(bytes.subarray(off + 4, off + 8))
    const end = off + 12 + len
    if (len > 0x7fffffff || end > bytes.length) {
      throw new Error('PNG 文件已损坏（块长度越界）')
    }
    chunks.push({ type, data: bytes.subarray(off + 8, off + 8 + len) })
    off = end
    if (type === 'IEND') {
      sawIend = true
      break
    }
  }
  const first = chunks[0]
  if (!first || first.type !== 'IHDR' || first.data.length !== 13) {
    throw new Error('PNG 文件已损坏（首块不是 13 字节的 IHDR）')
  }
  if (!sawIend) throw new Error('PNG 文件已损坏（缺少 IEND）')
  return chunks
}

/** 从块表整体重建 PNG（重写签名 + 逐块重算 CRC），对齐 ST 的 src/png/encode.js */
export function encodePngChunks(chunks: PngChunk[]): Uint8Array {
  let total = 8
  for (const c of chunks) total += 12 + c.data.length
  const out = new Uint8Array(total)
  out.set(PNG_SIG, 0)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  let off = 8
  for (const c of chunks) {
    const type = latin1Bytes(c.type)
    view.setUint32(off, c.data.length)
    out.set(type, off + 4)
    out.set(c.data, off + 8)
    const crcInput = new Uint8Array(type.length + c.data.length)
    crcInput.set(type, 0)
    crcInput.set(c.data, type.length)
    view.setUint32(off + 8 + c.data.length, crc32(crcInput))
    off += 12 + c.data.length
  }
  return out
}

/** tEXt 数据段布局：keyword \0 text。text 必须是 Latin-1 且不含 0x00，base64 天然满足 */
function textChunkData(keyword: string, text: string): Uint8Array {
  const kw = latin1Bytes(keyword)
  const val = latin1Bytes(text)
  const body = new Uint8Array(kw.length + 1 + val.length)
  body.set(kw, 0)
  body[kw.length] = 0
  body.set(val, kw.length + 1)
  return body
}

function toBase64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

const CARD_KEYWORDS = ['chara', 'ccv3']

/**
 * 是不是「已有的角色卡文本块」。
 * ST 只清 tEXt，我们连 zTXt / iTXt 一起清 —— 我们的 reader 认 zTXt，
 * 只清 tEXt 会留下「新 tEXt + 旧 zTXt」并存，而 reader 是 find 取第一个匹配，
 * 块顺序一变就读到旧卡。
 */
function isCardTextChunk(c: PngChunk): boolean {
  if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') return false
  const nul = c.data.indexOf(0)
  if (nul <= 0) return false
  return CARD_KEYWORDS.includes(latin1(c.data.subarray(0, nul)).toLowerCase())
}

/**
 * 把角色卡 JSON 写进 PNG，产出新的 PNG 字节。
 *
 * 完全对齐 SillyTavern 的 character-card-parser.js `write()`：
 *   拆块 → 剥离所有已有的 chara/ccv3 文本块 → 在 IEND 之前依次插入
 *   chara（cardJson 原样 base64）与 ccv3（spec 覆写成 chara_card_v3/3.0）→ 整体重编码。
 * ccv3 的构造包在 try/catch 里：cardJson 不是合法 JSON 时只写 chara，与 ST 一致。
 *
 * 载体必须是**合法 PNG**，否则抛中文错（旧实现在偏移 33 硬插字节，喂 JPEG 会静默产出
 * 既不是 JPEG 也不是 PNG 的废文件）。
 */
export function buildCardPng(png: Uint8Array, cardJson: string): Uint8Array {
  const chunks = splitPngChunks(png).filter((c) => !isCardTextChunk(c))
  const inserted: PngChunk[] = [
    { type: 'tEXt', data: textChunkData('chara', toBase64Utf8(cardJson)) },
  ]
  try {
    const v3 = JSON.parse(cardJson) as Record<string, unknown>
    v3['spec'] = 'chara_card_v3'
    v3['spec_version'] = '3.0'
    inserted.push({ type: 'tEXt', data: textChunkData('ccv3', toBase64Utf8(JSON.stringify(v3))) })
  } catch {
    // 与 ST 一致：cardJson 解析不了就只写 chara，保证至少产出一张可用的卡
  }
  // splitPngChunks 在 IEND 处 break，所以 IEND 恒为最后一个元素
  chunks.splice(chunks.length - 1, 0, ...inserted)
  return encodePngChunks(chunks)
}
