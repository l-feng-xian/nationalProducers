/**
 * 提示词组装：8 段固定前缀 + 每张图自己的 4 段。
 *
 * ## 为什么把前 8 段冻结成常量
 * 风格一致性靠两件事：① 参考图（/v1/images/edits 的 image[]）；② **逐字相同**的
 * 风格段。只要有一张图的 Style/Viewpoint/Palette 措辞漂了，它就会和别的素材对不上，
 * 而这种漂移在单张图上根本看不出来，要拼进游戏里才暴露。
 *
 * ## 迭代规则
 * ⚠️ 每次重试**只改一段**。一次改三段，你学不到是哪一段起了作用，
 * 而每张候选图要 $0.09。
 */

/** 版本号进缓存键：改了任何一段，所有图的缓存都应失效 */
export const PROMPT_VERSION = 2

/** 调色板 —— 所有素材共用，不许各自发挥 */
export const PALETTE = {
  olive: '#718153',
  moss: '#94a66d',
  blueGreen: '#5f8790',
  ochre: '#c98f5d',
  timber: '#a87545',
  water: '#799e9e',
  outline: '#3f5140',
  cream: '#f3ddb0',
}

const SEC_USE_CASE = `Use case: stylized-concept`

const SEC_INPUT_IMAGES = `Input images: Image 1 is the PRIMARY reference - match its linework, its architecture, its tree shapes, its palette and above all its camera treatment. Image 2 is the reference for grass strokes, flowers, wetland plants and water. Any further image is a previously approved sheet from this same collection. The supplied images are STYLE REFERENCES ONLY. Do not edit, extend, outpaint, crop or reproduce their compositions. Produce an entirely NEW original image.`

const SEC_STYLE = `Style/medium: organic charcoal-olive hand-drawn outlines of consistent weight, flat soft gouache shading with restrained brush texture, delicate individually drawn tapered grass strokes, lobed blue-green foliage, creamy birch bark with dark markings, honey-colored wood planks with visible joinery. Cute proportions with a large expressive head and a small body. Fully drawn raster illustration; never pixel art, never polygonal 3D, never glossy plastic, never flat vector clip art.`

/**
 * ⚠️ 这一段是 v2 的唯一改动，修的是 v1 的真实缺陷。
 *
 * v1 只禁了「等距菱形」与「透视收敛」，**没禁主体自身的偏航旋转**，
 * 结果四张候选里房子全是偏转的 3/4 视角（同时看得见正墙和侧墙）。
 * 参考图 sjt.png 里的木屋是**正面朝向、轴对齐**的：正墙平行于画面水平边、
 * 门居中、只看得到正面 + 上方屋顶，看不到侧墙。
 *
 * 这对瓦片游戏是硬伤：建筑带了偏航角就无法与世界网格对齐，占地也对不上。
 */
const SEC_VIEWPOINT = `Viewpoint: orthographic oblique overhead game camera, roughly 62 degrees above the ground plane, with ZERO yaw. This is the single most important constraint on this image.

Every upright object - every building, fence, sign, crate and character - is AXIS-ALIGNED and seen FRONT-ON. Its front face is exactly parallel to the horizontal edge of the image. You see that one front face straight on, plus its top surfaces from above. You must NOT be able to see two walls of a building at the same time. Roof ridges run exactly horizontally across the image; gables are symmetrical and point straight at the viewer.

All vertical edges of structures are exactly vertical in the image. All horizontal edges of front faces are exactly horizontal. Nothing is rotated, turned, tilted, skewed or angled away from the viewer.

FORBIDDEN: three-quarter views, corner-on views, two-point perspective, vanishing points, perspective convergence, diamond isometric grids, rotated footprints, buildings turned at an angle to the camera, a visible horizon line.`

const SEC_PALETTE = `Palette: ${PALETTE.olive} olive grass, ${PALETTE.moss} moss, ${PALETTE.blueGreen} blue-green leaves, ${PALETTE.ochre} ochre path, ${PALETTE.timber} honey timber, ${PALETTE.water} soft water, ${PALETTE.outline} outlines, ${PALETTE.cream} creamy light. Muted warm pastoral palette, never oversaturated. No color outside this family except where a keying background is explicitly requested.`

const SEC_CONSTRAINTS = `Constraints: no text, no labels, no lettering, no numbers, no UI, no logos, no watermarks, no borders, no frame lines, no grid lines. Consistent line weight and detail density across every element of the image.`

/** 场景图用：有投影 */
const SEC_LIGHTING_SCENE = `Lighting: gentle late-afternoon light from the upper left, soft long ground shadows toward the lower right; peaceful, tactile and inhabited.`

/**
 * 抠像精灵用：**绝不能有投影**。
 * 投影一旦画进抠像图，就会跟着主体一起被切下来，运行时再叠一层投影就是双影。
 */
const SEC_LIGHTING_KEYED = `Lighting: restrained upper-left highlights on the object surfaces only. Do NOT paint projected ground shadows, contact shadows, ambient occlusion pools, or any dark patch beneath the subjects - ground shadows are a separate runtime layer and would otherwise be baked into the cutout.`

/**
 * 组装完整提示词。
 *
 * @param {object} a
 * @param {string} a.assetType   第 2 段
 * @param {'scene'|'keyed'} a.lighting
 * @param {string} a.primary     主体描述
 * @param {string} [a.layout]    网格与背景要求
 * @param {string} [a.registration] 配准要求（脚线、占比）
 * @param {string} [a.reading]   读取顺序
 */
export function buildPrompt(a) {
  const parts = [
    SEC_USE_CASE,
    `Asset type: ${a.assetType}`,
    SEC_INPUT_IMAGES,
    SEC_STYLE,
    SEC_VIEWPOINT,
    a.lighting === 'keyed' ? SEC_LIGHTING_KEYED : SEC_LIGHTING_SCENE,
    SEC_PALETTE,
    SEC_CONSTRAINTS,
    `Primary request: ${a.primary}`,
  ]
  if (a.layout) parts.push(`Layout: ${a.layout}`)
  if (a.registration) parts.push(`Registration: ${a.registration}`)
  if (a.reading) parts.push(`Reading order: ${a.reading}`)
  return parts.join('\n\n')
}

/** 洋红抠像背景的标准措辞 —— 所有精灵图集共用，别各写各的 */
export function magentaBackground(extra = '') {
  return (
    `The background is a perfectly flat, solid chroma-key magenta #FF00FF - INCLUDING every ` +
    `interior gap: between branches, between leaf clusters, between the arms and the torso, ` +
    `between the legs, and inside every limb gap. NO gradients, NO vignette, NO shadow cast onto ` +
    `the magenta, NO checkerboard, NO frame lines, NO labels. No magenta, pink, violet or purple ` +
    `anywhere inside the subjects themselves.${extra ? ` ${extra}` : ''}`
  )
}
