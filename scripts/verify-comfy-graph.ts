/**
 * ComfyUI 后端的纯函数断言：参考图标签、横版比例换算。
 *
 * 跑法： npm run verify:comfy-graph
 */
import { encoderResolution, labelReferences, targetSize } from '@/services/image/comfyui'

let passed = 0
let failed = 0
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) passed++
  else failed++
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const p = '参考图 1 中的她与参考图2中的他，参考图 3 只看画风。'
const out = labelReferences(p, 2)
check('标注已上传的编号', out.includes('参考图 1（<image1>）') && out.includes('参考图2（<image2>）'), out)
check('超出上传数量的不标', out.includes('参考图 3 只看') && !out.includes('<image3>'))
check('不重复标注', labelReferences(out, 2) === out)
check('两位数不被截成一位', labelReferences('参考图 12', 3) === '参考图 12')
check('没有参考图原样返回', labelReferences(p, 0) === p)

const t = targetSize('1536x1024', 1024)!
check('横版 3:2', t.width === 1248 && t.height === 832, JSON.stringify(t))
check('边长是 32 的倍数', t.width % 32 === 0 && t.height % 32 === 0)
check('LatentUpscale 参数（像素/2）是 8 的倍数', (t.width / 2) % 8 === 0 && (t.height / 2) % 8 === 0)
check('面积约等于 resolution²', Math.abs(t.width * t.height - 1024 * 1024) / (1024 * 1024) < 0.02)
check('无效尺寸返回 null', targetSize('auto', 1024) === null && targetSize(undefined, 1024) === null)

// 本机实测：3 张参考图在 1024 下出图会碎，768 正常
check('1~2 张参考图不降分辨率', encoderResolution(1024, 1) === 1024 && encoderResolution(1024, 2) === 1024)
check('3 张及以上降到 768', encoderResolution(1024, 3) === 768 && encoderResolution(1024, 6) === 768)
check('本来就低于 768 的不抬高', encoderResolution(512, 3) === 512)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
