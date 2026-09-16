/**
 * 洋红抠像。
 *
 * ## ⚠️ 朴素阈值会毁掉整套美术
 * `if (r>200 && g<50 && b>200) alpha=0` 在**抗锯齿描边上留一圈粉边**。
 * 描边正是这套手绘风的核心，而粉边压在 #718153 橄榄底上极其刺眼 ——
 * 远看像每个精灵都镶了一道荧光边。
 *
 * 正确做法是把抠像当成**线性混合的反解**：
 *   观察值 P = t·K + (1-t)·F      （K = 洋红，F = 前景真实色，t = 洋红占比）
 *   → alpha = 1 - t，且 F = (P - t·K) / (1-t)
 * 后半句就是「去色溢出（despill）」，没有它，半透明像素会残留粉色。
 *
 * ## 抠像轴
 * `d = (r+b)/2 - g`。对洋红 (255,0,255) 取极大值 255，对本套调色板取极小值 ——
 * 已逐色核对：8 个调色板色里没有任何一个 r 和 b **同时**大于 g
 * （#c98f5d 的 b<g，#f3ddb0 的 b<g），所以这个判据不会误伤正片。
 *
 * ## ⚠️ 只抠「连到画布边缘」的洋红
 * 直接按颜色抠会把主体内部一朵粉色小花也打成洞。
 * 从边缘泛洪，只有与边缘连通的洋红才是背景 —— 而 prompt 里要求
 * 「肢体缝隙内部也要洋红」正是为了让那些缝隙**与外界连通**。
 */

/** 抠像轴的下限：低于它完全不透明 */
const KEY_LO = 60
/** 抠像轴的上限：高于它完全透明 */
const KEY_HI = 200
/** 小于这个面积的 alpha 孤岛直接抹掉（去斑） */
const DESPECKLE_MIN = 24
/** RGB 向透明区扩散的轮数 */
const BLEED_ROUNDS = 4

/**
 * 就地把 RGBA 缓冲抠成透明。
 *
 * @param {Buffer} rgba  width*height*4
 */
export function chromaKey(rgba, width, height, opt = {}) {
  const keyLo = opt.keyLo ?? KEY_LO
  const keyHi = opt.keyHi ?? KEY_HI
  const n = width * height

  // ── 1. 抠像轴 + despill ──
  const t = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    const d = (r + b) / 2 - g
    const tt = Math.min(1, Math.max(0, (d - keyLo) / (keyHi - keyLo)))
    t[i] = tt
    if (tt > 0 && tt < 1) {
      // F = (P - t·K) / (1-t)，K = (255, 0, 255)
      const inv = 1 / (1 - tt)
      rgba[i * 4] = clamp8((r - tt * 255) * inv)
      rgba[i * 4 + 1] = clamp8(g * inv)
      rgba[i * 4 + 2] = clamp8((b - tt * 255) * inv)
    }
  }

  // ── 2. 边缘泛洪：只有连到画布边缘的洋红才算背景 ──
  const isBg = new Uint8Array(n)
  const queue = new Int32Array(n)
  let head = 0
  let tail = 0
  const push = (i) => {
    if (isBg[i] || t[i] < 0.5) return
    isBg[i] = 1
    queue[tail++] = i
  }
  for (let x = 0; x < width; x++) {
    push(x)
    push((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    push(y * width)
    push(y * width + width - 1)
  }
  while (head < tail) {
    const i = queue[head++]
    const x = i % width
    const y = (i - x) / width
    if (x > 0) push(i - 1)
    if (x < width - 1) push(i + 1)
    if (y > 0) push(i - width)
    if (y < height - 1) push(i + width)
  }

  // ── 3. 写 alpha ──
  // ⚠️ 只有 isBg 的像素才按 t 变透明；主体内部的粉色保持不透明
  for (let i = 0; i < n; i++) {
    rgba[i * 4 + 3] = isBg[i] ? clamp8((1 - t[i]) * 255) : 255
  }

  // 边界过渡带：紧挨背景的半透明像素也要按 t 处理，否则会留一圈硬边
  for (let i = 0; i < n; i++) {
    if (isBg[i] || t[i] <= 0) continue
    const x = i % width
    const y = (i - x) / width
    let nearBg = false
    if (x > 0 && isBg[i - 1]) nearBg = true
    else if (x < width - 1 && isBg[i + 1]) nearBg = true
    else if (y > 0 && isBg[i - width]) nearBg = true
    else if (y < height - 1 && isBg[i + width]) nearBg = true
    if (nearBg) rgba[i * 4 + 3] = clamp8((1 - t[i]) * 255)
  }

  despeckle(rgba, width, height)
  bleedColor(rgba, width, height, opt.bleedRounds ?? BLEED_ROUNDS)
  return rgba
}

/** 抹掉面积过小的不透明孤岛（模型偶尔会甩出几个像素的噪点） */
function despeckle(rgba, width, height, minArea = DESPECKLE_MIN) {
  const n = width * height
  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const comp = new Int32Array(n)
  for (let start = 0; start < n; start++) {
    if (seen[start] || rgba[start * 4 + 3] < 8) continue
    let sp = 0
    let cn = 0
    stack[sp++] = start
    seen[start] = 1
    while (sp > 0) {
      const i = stack[--sp]
      comp[cn++] = i
      const x = i % width
      const y = (i - x) / width
      const tryPush = (j) => {
        if (j < 0 || j >= n || seen[j] || rgba[j * 4 + 3] < 8) return
        seen[j] = 1
        stack[sp++] = j
      }
      if (x > 0) tryPush(i - 1)
      if (x < width - 1) tryPush(i + 1)
      if (y > 0) tryPush(i - width)
      if (y < height - 1) tryPush(i + width)
    }
    if (cn < minArea) for (let k = 0; k < cn; k++) rgba[comp[k] * 4 + 3] = 0
  }
}

/**
 * RGB 向透明区扩散。
 *
 * ⚠️ **必做，而且与 padding 是两件事**。
 * 透明像素的 RGB 通常是 0（黑）。双线性过滤与每一级 mipmap 都会把它混进来，
 * 结果每个精灵外面镶一圈暗边 —— 缩得越小越明显。
 * 把最近的不透明颜色向外推几圈，透明区就带着"正确的颜色"，混进来也无害。
 */
function bleedColor(rgba, width, height, rounds) {
  const n = width * height
  for (let r = 0; r < rounds; r++) {
    const src = Buffer.from(rgba)
    for (let i = 0; i < n; i++) {
      if (src[i * 4 + 3] >= 8) continue
      const x = i % width
      const y = (i - x) / width
      let cr = 0
      let cg = 0
      let cb = 0
      let cnt = 0
      const take = (j) => {
        if (j < 0 || j >= n || src[j * 4 + 3] < 8) return
        cr += src[j * 4]
        cg += src[j * 4 + 1]
        cb += src[j * 4 + 2]
        cnt++
      }
      if (x > 0) take(i - 1)
      if (x < width - 1) take(i + 1)
      if (y > 0) take(i - width)
      if (y < height - 1) take(i + width)
      if (cnt === 0) continue
      rgba[i * 4] = Math.round(cr / cnt)
      rgba[i * 4 + 1] = Math.round(cg / cnt)
      rgba[i * 4 + 2] = Math.round(cb / cnt)
      // alpha 保持 0 —— 只补颜色，不补不透明度
    }
  }
}

/**
 * 这张图自带有意义的 alpha 通道吗？
 *
 * ⚠️ **必须先问这个再决定要不要抠像**。
 *
 * 素材方案最初的结论是「输出是 colorType 2（RGB 无 alpha），洋红抠像是必须的」——
 * 那是基于**纯文生图**探测得出的。而走 `/v1/images/edits` 并要求「cut-out」时，
 * 这个模型会返回**真正的 RGBA**（实测 colorType 6，角落 [0,0,0,0]）。
 *
 * 不做这个判断就会出大事：抠像函数最后一步是
 * `alpha = isBg ? ... : 255`，在没有洋红可抠时它会把**每一个像素**写成
 * 不透明 —— 一条完好的 alpha 通道被就地摧毁，而表现只是
 * 「每个精灵都占满整格」，很容易误判成「模型没留白边」。
 *
 * 判据：有一定比例的像素处于半透明或全透明。
 */
export function hasRealAlpha(rgba, width, height) {
  const n = width * height
  let transparent = 0
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 250) transparent++
  // 抠像图的背景通常占三成以上；阈值取 5% 足够宽松，又不会被
  // 「几个抗锯齿边缘像素」这种噪声误判
  return transparent / n > 0.05
}

/** alpha 的包围盒。返回 null 表示这一格是空的 */
export function alphaBBox(rgba, width, height, threshold = 8) {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] < threshold) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/** 统计仍然偏洋红的像素比例，用来验收「有没有粉边」 */
export function magentaResidue(rgba, width, height) {
  const n = width * height
  let bad = 0
  let opaque = 0
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 128) continue
    opaque++
    const r = rgba[i * 4]
    const g = rgba[i * 4 + 1]
    const b = rgba[i * 4 + 2]
    if ((r + b) / 2 - g > 40) bad++
  }
  return opaque > 0 ? bad / opaque : 0
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}
