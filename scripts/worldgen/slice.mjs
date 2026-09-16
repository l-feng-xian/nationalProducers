/**
 * 切图后处理：抠像 → 逐格 QA → 裁切配准 → 平铺无缝化 → 写 manifest。
 *
 * 用法： npm run world:slice
 *
 * ## ⚠️ 永不信任网格
 * 模型给的「2×2 网格」经常有偏移、格子不等大、主体越界。
 * 所以每一格切出来都要过 QA：空主体 / 越界 / 过小，各自告警。
 * 不查的话，错位的图会一路进到引擎里，表现为「某棵树少了半边」。
 *
 * ## ⚠️ AI 产不出真正无缝的贴图
 * 无论 prompt 怎么写都不行 —— 它没有「左边缘要接上右边缘」这个概念。
 * 所以可平铺材质必须做**边缘镜像混合**：
 *   左带 x∈[0,B) 与右带按镜像加权混合，权重在 x=0 处为 0.5、x=B 处降到 0。
 *   于是 out(0) = out(w-1) = 0.5·img(0) + 0.5·img(w-1)，两端严格相等。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

import { Ledger } from './lib/ledger.mjs'
import { alphaBBox, chromaKey, hasRealAlpha, magentaResidue } from './lib/chroma.mjs'
import { SHEETS, sheetsInGroup } from './plan.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const OUT_DIR = path.join(ROOT, 'output', 'imagegen', 'world-v2')
const PUBLIC_DIR = path.join(ROOT, 'public', 'world', 'v1')
const QA_DIR = path.join(OUT_DIR, 'qa')

/** 精灵四周留的透明边（像素）。防双线性采样串到隔壁帧 */
const SPRITE_PADDING = 8
/** 平铺材质边缘混合带宽度占边长的比例 */
const TILE_BLEND = 0.125

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    const v = argv[i + 1]
    if (v && !v.startsWith('--')) { out[k] = v; i++ } else out[k] = true
  }
  return out
}

/** 取出一格的 RGBA */
function cutCell(src, srcW, cellW, cellH, col, row, offX, offY) {
  const out = Buffer.alloc(cellW * cellH * 4)
  for (let y = 0; y < cellH; y++) {
    const sy = offY + row * cellH + y
    for (let x = 0; x < cellW; x++) {
      const sx = offX + col * cellW + x
      const s = (sy * srcW + sx) * 4
      const d = (y * cellW + x) * 4
      out[d] = src[s]
      out[d + 1] = src[s + 1]
      out[d + 2] = src[s + 2]
      out[d + 3] = src[s + 3]
    }
  }
  return out
}

/**
 * 边缘镜像混合，让贴图可无缝平铺。
 *
 * 见文件头的推导：两端混合后严格相等。
 */
function makeSeamless(rgba, w, h) {
  const bw = Math.max(2, Math.round(w * TILE_BLEND))
  const bh = Math.max(2, Math.round(h * TILE_BLEND))
  const src = Buffer.from(rgba)
  const at = (x, y, c) => src[(y * w + x) * 4 + c]

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 水平权重：x=0 时 0.5，x=bw 时 0；右侧镜像同理
      let wx = 0
      let mx = x
      if (x < bw) { wx = 0.5 * (1 - x / bw); mx = w - 1 - x }
      else if (x >= w - bw) { const d = w - 1 - x; wx = 0.5 * (1 - d / bw); mx = w - 1 - x }
      let wy = 0
      let my = y
      if (y < bh) { wy = 0.5 * (1 - y / bh); my = h - 1 - y }
      else if (y >= h - bh) { const d = h - 1 - y; wy = 0.5 * (1 - d / bh); my = h - 1 - y }

      if (wx === 0 && wy === 0) continue
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const base = at(x, y, c)
        let v = base * (1 - wx - wy)
        v += at(mx, y, c) * wx
        v += at(x, my, c) * wy
        rgba[i + c] = Math.max(0, Math.min(255, Math.round(v)))
      }
    }
  }
  return rgba
}

/** 量化平铺接缝：左右两列与上下两行的平均差异 */
function seamError(rgba, w, h) {
  let sum = 0
  let n = 0
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(rgba[(y * w) * 4 + c] - rgba[(y * w + w - 1) * 4 + c])
      n++
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      sum += Math.abs(rgba[x * 4 + c] - rgba[((h - 1) * w + x) * 4 + c])
      n++
    }
  }
  return sum / n
}

async function main() {
  const argv = parseArgs(process.argv)
  const ledger = await new Ledger(path.join(OUT_DIR, 'ledger.json')).load()
  let sheets = argv.group ? sheetsInGroup(String(argv.group)) : SHEETS
  if (argv.only) sheets = sheets.filter((s) => String(argv.only).split(',').includes(s.id))

  await mkdir(PUBLIC_DIR, { recursive: true })
  await mkdir(QA_DIR, { recursive: true })

  const manifest = { schema: 1, assetVersion: 'world-1', generatedAt: new Date().toISOString(), frames: {} }
  const warnings = []

  for (const sheet of sheets) {
    const job = ledger.get(sheet.id)
    const picked = job?.candidates?.[job?.picked ?? 0]
    if (!picked) { warnings.push(`${sheet.id}: 账本里没有已生成的候选，先跑 world:gen`); continue }
    const rawFile = path.resolve(ROOT, picked.file)
    if (!existsSync(rawFile)) { warnings.push(`${sheet.id}: 原图不存在 ${picked.file}`); continue }

    const img = sharp(rawFile)
    const meta = await img.metadata()
    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const srcW = info.width
    const srcH = info.height

    // ⚠️ 用 floor 算格，余数居中 —— 服务端会把尺寸吸附到 32 的倍数，
    // 直接除可能除不尽，硬切会让最后一列/行少几像素
    const cellW = Math.floor(srcW / sheet.cols)
    const cellH = Math.floor(srcH / sheet.rows)
    const offX = Math.floor((srcW - cellW * sheet.cols) / 2)
    const offY = Math.floor((srcH - cellH * sheet.rows) / 2)

    console.log(`\n${sheet.id}  ${srcW}×${srcH} → ${sheet.cols}×${sheet.rows} 格，每格 ${cellW}×${cellH}（余 ${srcW - cellW * sheet.cols}×${srcH - cellH * sheet.rows}）`)

    for (let row = 0; row < sheet.rows; row++) {
      for (let col = 0; col < sheet.cols; col++) {
        const name = sheet.names[row * sheet.cols + col]
        const cell = cutCell(data, srcW, cellW, cellH, col, row, offX, offY)

        if (sheet.kind === 'tiling') {
          const before = seamError(cell, cellW, cellH)
          makeSeamless(cell, cellW, cellH)
          const after = seamError(cell, cellW, cellH)
          const file = path.join(PUBLIC_DIR, `${name}.png`)
          await sharp(cell, { raw: { width: cellW, height: cellH, channels: 4 } }).png().toFile(file)
          manifest.frames[name] = { file: `${name}.png`, kind: 'tiling', w: cellW, h: cellH }
          console.log(`  ${name.padEnd(16)} 平铺  接缝 ${before.toFixed(1)} → ${after.toFixed(1)}`)
          if (after > 3) warnings.push(`${sheet.id}/${name}: 平铺接缝仍有 ${after.toFixed(1)}`)
          continue
        }

        // ── 抠像（仅在模型没给 alpha 时才做）──
        //
        // ⚠️ 先判断再抠。见 chroma.mjs 的 hasRealAlpha：
        // 这个模型走 edits 端点时会直接返回带 alpha 的 RGBA，
        // 无脑抠像会把那条通道覆写成全不透明。
        const native = hasRealAlpha(cell, cellW, cellH)
        if (!native) chromaKey(cell, cellW, cellH)
        const residue = magentaResidue(cell, cellW, cellH)
        const bbox = alphaBBox(cell, cellW, cellH)

        if (!bbox) { warnings.push(`${sheet.id}/${name}: 这一格是空的（抠完什么都不剩）`); continue }
        const touchesEdge = bbox.x <= 1 || bbox.y <= 1 || bbox.x + bbox.w >= cellW - 1 || bbox.y + bbox.h >= cellH - 1
        const areaRatio = (bbox.w * bbox.h) / (cellW * cellH)
        if (touchesEdge) warnings.push(`${sheet.id}/${name}: 主体贴到了格边（可能被裁掉）`)
        if (areaRatio < 0.08) warnings.push(`${sheet.id}/${name}: 主体太小（只占 ${(areaRatio * 100).toFixed(1)}%）`)
        if (residue > 0.01) warnings.push(`${sheet.id}/${name}: 抠完仍有 ${(residue * 100).toFixed(2)}% 像素偏洋红`)

        // ── 裁切 + 加 padding ──
        const outW = bbox.w + SPRITE_PADDING * 2
        const outH = bbox.h + SPRITE_PADDING * 2
        const out = Buffer.alloc(outW * outH * 4)
        for (let y = 0; y < bbox.h; y++) {
          for (let x = 0; x < bbox.w; x++) {
            const s = ((bbox.y + y) * cellW + bbox.x + x) * 4
            const d = ((y + SPRITE_PADDING) * outW + x + SPRITE_PADDING) * 4
            out[d] = cell[s]; out[d + 1] = cell[s + 1]; out[d + 2] = cell[s + 2]; out[d + 3] = cell[s + 3]
          }
        }
        const file = path.join(PUBLIC_DIR, `${name}.png`)
        await sharp(out, { raw: { width: outW, height: outH, channels: 4 } }).png().toFile(file)
        manifest.frames[name] = {
          file: `${name}.png`,
          kind: 'sprite',
          w: outW,
          h: outH,
          // 脚底锚点：bbox 底边中心（含 padding 偏移）
          pivot: [0.5, (SPRITE_PADDING + bbox.h) / outH],
          trim: { x: SPRITE_PADDING, y: SPRITE_PADDING, w: bbox.w, h: bbox.h },
        }
        console.log(
          `  ${name.padEnd(16)} 精灵  ${bbox.w}×${bbox.h}（占 ${(areaRatio * 100).toFixed(0)}%）` +
            `  ${native ? '模型自带 alpha' : '洋红抠像'}` +
            `  残留 ${(residue * 100).toFixed(2)}%${touchesEdge ? '  ⚠️贴边' : ''}`,
        )
      }
    }

    // QA 联络表：棋盘底 + 切格线，供肉眼验收
    await writeQaSheet(sheet, rawFile, cellW, cellH, offX, offY)
    void meta
  }

  await writeFile(path.join(PUBLIC_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`\nmanifest → ${path.relative(ROOT, path.join(PUBLIC_DIR, 'manifest.json'))}（${Object.keys(manifest.frames).length} 帧）`)
  if (warnings.length) {
    console.log('\n⚠️  告警：')
    for (const w of warnings) console.log('  ' + w)
  } else {
    console.log('\n✓ 无告警')
  }
}

/** 把原图叠上切格线，方便一眼看出网格对没对准 */
async function writeQaSheet(sheet, rawFile, cellW, cellH, offX, offY) {
  const { data, info } = await sharp(rawFile).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width
  const h = info.height
  for (let c = 1; c < sheet.cols; c++) {
    const x = offX + c * cellW
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4
      data[i] = 255; data[i + 1] = 0; data[i + 2] = 0
    }
  }
  for (let r = 1; r < sheet.rows; r++) {
    const y = offY + r * cellH
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      data[i] = 255; data[i + 1] = 0; data[i + 2] = 0
    }
  }
  await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(path.join(QA_DIR, `${sheet.id}.grid.png`))
}

main().catch((e) => {
  console.error(`\n❌ ${e?.message ?? e}`)
  process.exitCode = 1
})
