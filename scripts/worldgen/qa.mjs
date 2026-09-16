/**
 * G1 验收联络表。
 *
 * 两件事，都是「只能用眼睛确认」的：
 *   1. 可平铺材质 2×2 拼起来看接缝
 *   2. 精灵压在橄榄底上放大看边缘 —— 抠像留下的光晕/暗边只在这种对比下才现形
 */
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
const PUB = path.join(ROOT, 'public', 'world', 'v1')
const OUT = path.join(ROOT, 'output', 'imagegen', 'world-v2', 'qa')

async function main() {
  await mkdir(OUT, { recursive: true })
  const manifest = JSON.parse(await readFile(path.join(PUB, 'manifest.json'), 'utf8'))

  // ── 1. 平铺 2×2 ──
  for (const [name, f] of Object.entries(manifest.frames)) {
    if (f.kind !== 'tiling') continue
    const buf = await sharp(path.join(PUB, f.file)).resize(256, 256).toBuffer()
    await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
      .composite([
        { input: buf, left: 0, top: 0 }, { input: buf, left: 256, top: 0 },
        { input: buf, left: 0, top: 256 }, { input: buf, left: 256, top: 256 },
      ])
      .png().toFile(path.join(OUT, `tile-${name}.png`))
  }

  // ── 2. 精灵压橄榄底 ──
  const sprites = Object.entries(manifest.frames).filter(([, f]) => f.kind === 'sprite')
  if (sprites.length) {
    const W = 1200, H = 520
    const layers = []
    let x = 20
    for (const [, f] of sprites) {
      const h = 420
      const w = Math.round((f.w / f.h) * h)
      layers.push({ input: await sharp(path.join(PUB, f.file)).resize(w, h).toBuffer(), left: x, top: 40 })
      x += w + 20
    }
    await sharp({ create: { width: W, height: H, channels: 4, background: { r: 113, g: 129, b: 83, alpha: 1 } } })
      .composite(layers).png().toFile(path.join(OUT, 'sprites-on-olive.png'))

    // 400% 放大第一棵树的脚部 —— 光晕最容易出现在这里
    const [, first] = sprites[0]
    const crop = await sharp(path.join(PUB, first.file))
      .extract({ left: 0, top: Math.max(0, first.h - 120), width: Math.min(160, first.w), height: 120 })
      .resize(640, 480, { kernel: 'nearest' }).toBuffer()
    await sharp({ create: { width: 640, height: 480, channels: 4, background: { r: 113, g: 129, b: 83, alpha: 1 } } })
      .composite([{ input: crop, left: 0, top: 0 }]).png().toFile(path.join(OUT, 'sprite-edge-400.png'))
  }
  console.log('QA 图 →', path.relative(ROOT, OUT))
}
main().catch((e) => { console.error(e); process.exitCode = 1 })
