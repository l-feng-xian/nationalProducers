/**
 * 素材清单 —— **写成代码而不是 JSON**。
 *
 * 网格尺寸、格子像素、帧名都是算出来的，不是手抄的。
 * 手抄 JSON 的老毛病是「cols×rows 与 names.length 对不上」，
 * 而这种错要等切完图才发现，那时钱已经花了。
 *
 * ## 分组与验收节奏
 * G1（本文件的 `g1` 组）只出两张：一张可平铺地表材质 + 一张抠像精灵。
 * 它们要走完 生成 → 抠像 → 切图 → 入引擎 的**完整链路**，
 * 确认管线没问题之后才批量出剩下的。
 */

import { buildPrompt, magentaBackground } from './lib/prompt.mjs'

/** flare 约 1MP，1024×1024 是最稳的档位 */
export const DEFAULT_SIZE = '1024x1024'

/**
 * 参考图。前两张是用户给的原始参考，第三张是已定稿的风格母版。
 *
 * ⚠️ 母版必须排在最后 —— prompt 里 "Image 3 是已批准的母版" 这句
 * 依赖的是顺序，不是文件名。
 */
export const REFERENCE_FILES = [
  'C:/Users/25925/Downloads/sjt.png',
  'C:/Users/25925/Downloads/ScreenShot_2026-09-15_092055_282.png',
  'output/imagegen/world-v2/raw/00-style-master.approved.png',
]

/**
 * @typedef {object} Sheet
 * @property {string} id
 * @property {string} group
 * @property {number} cols
 * @property {number} rows
 * @property {string} size
 * @property {'tiling'|'keyed'} kind  tiling = 满幅无留白；keyed = 洋红抠像
 * @property {string[]} names          按阅读顺序，长度必须等于 cols*rows
 * @property {string} prompt
 */

/** @type {Sheet[]} */
export const SHEETS = [
  {
    id: 't01-ground-core',
    group: 'g1',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'tiling',
    names: ['grass-meadow', 'dirt-path', 'soil-tilled', 'water-shallow'],
    prompt: buildPrompt({
      assetType:
        'seamlessly tileable ground texture swatches for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed', // 地表也不要投影：光照是运行时的事
      primary: `Four completely filled square ground-texture swatches, reading left to right, top to bottom:
(1) olive meadow grass: a dense, even mat of fine short grass strokes pointing in many different directions;
(2) compacted dirt path in MUTED, DESATURATED, greyed warm ochre - dusty and earthy, closer to a soft tan-brown than to orange - with fine grain and a few tiny scattered pebbles;
(3) dry cultivated brown soil with narrow parallel furrows running exactly horizontally;
(4) clear muted teal shallow water with small ripple marks pointing in many different directions.

Continuous flat surface only - no raised objects, no trees, no flowers, no blossoms, no shorelines, no edges, no transitions between materials, no perspective, no labels, no shadows. Viewed straight down from directly overhead.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Every cell is FULL BLEED - its texture runs right up to all four cell edges. NO gutters, NO margins, NO magenta, NO background colour anywhere on this sheet, NO visible lines between the four cells.`,
      // ⚠️ 这一段修的是 G1 在引擎里暴露出来的两个真实缺陷，不是措辞润色：
      //
      // ① **可辨认的小特征 = 可见的重复点阵**。上一版只禁了「焦点 / 大单体特征」，
      //    模型于是撒了一片白色小花簇 —— 单张图上好看，贴进游戏里
      //    每隔 8 格重复一次，白花排成规则格点，整片草地像壁纸。
      //    判据不是「均匀」而是「重复之后认不出是同一块」。
      //
      // ② **条纹是有方向的，而道路不是**。上一版 primary 亲口要了
      //    "faint wheel ruts"，模型照做，给了满幅竖直车辙。
      //    游戏里东西走向的路上出现南北向车辙，一眼假。
      //    只有第 3 格（耕地垄沟）该有方向 —— 那是农事的真实方向。
      registration: `Every swatch must survive being tiled: when the same swatch is repeated edge to edge across a large area, a viewer must NOT be able to pick out any feature and see it recurring on a regular lattice. Therefore each swatch carries NO recognisable individual feature of any kind - no flowers, no blossoms, no distinctive clumps, no bright specks, no large or high-contrast marks, no focal point, no brightness falloff toward the edges. Variation is fine-grained and evenly distributed; the largest single element is smaller than one twentieth of the cell.

Swatches 1, 2 and 4 are NON-DIRECTIONAL: no streaks, no ruts, no grooves, no combed or brushed look, no linear features sharing a common direction, nothing that would look wrong if the swatch were rotated 90 degrees. ONLY swatch 3 (cultivated soil) is directional, and its furrows run exactly horizontally.

Feature scale is consistent between all four cells.`,
      reading: 'grass-meadow; dirt-path; soil-tilled; water-shallow.',
    }),
  },
  {
    id: 'v01-trees-broad',
    group: 'g1',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: ['birch-tall', 'birch-young', 'oak-round', 'oak-spreading'],
    prompt: buildPrompt({
      assetType:
        'production raster sprite sheet of isolated trees for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `Four isolated broadleaf trees, reading left to right, top to bottom:
(1) a tall cream-barked birch with blue-green scalloped leaf clusters and visible hand-drawn branch structure;
(2) a younger birch with a thinner trunk and a sparser crown;
(3) a round, full oak with a dense lobed canopy;
(4) a broader, irregular, wind-leaned oak.

Complete silhouettes; the base of every trunk is fully visible and unobstructed. No ground, no grass, no rocks, no props, no other trees.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Each tree stays entirely inside its own cell with a generous empty margin on all four sides, horizontally centred. ${magentaBackground()}`,
      registration: `Within each cell, the subject occupies about 82% of the cell height, and the lowest point of the trunk sits on a common baseline at 92% of the cell height in EVERY cell. Subjects are vertically upright - no tilt, no rotation.`,
      reading: 'birch-tall; birch-young; oak-round; oak-spreading.',
    }),
  },
  {
    // R-D：给底色软混合的林地/湿地、以及城镇地基石板补上专属贴图。
    // 之前它们借草地/土路顶着，读起来是「暗草地」和「土色广场」。
    id: 't02-ground-natural',
    group: 'g2',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'tiling',
    names: ['forest-floor', 'marsh', 'cobble', 'sand'],
    prompt: buildPrompt({
      assetType:
        'seamlessly tileable ground texture swatches for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `Four completely filled square ground-texture swatches, reading left to right, top to bottom:
(1) shaded woodland forest floor: muted dark olive-brown earth, distinctly darker and cooler than open meadow grass, with a FINE, EVEN, all-over speckle of tiny leaf-litter flecks and faint mottling - NO whole leaves, NO leaf clusters, NO plants, NO green sprouts, NO twigs, NO moss patches, nothing you could pick out as a single object;
(2) boggy wetland ground: dark desaturated grey-green damp mud with a FINE, EVEN, all-over mottling - uniformly wet-looking - NO reeds, NO reed stubs, NO plants, NO distinct puddles or water-sheen patches, nothing you could pick out as a single object;
(3) hand-laid rounded cobblestone paving: many small close-packed weathered grey-tan stones of slightly varied size with darker earthy gaps between them;
(4) pale warm fine sand: soft desaturated sandy ground with fine even grain and a few tiny scattered pebbles.

Continuous flat surface only - no raised objects, no shorelines, no edges, no transitions between materials, no perspective, no labels, no shadows. Viewed straight down from directly overhead.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Every cell is FULL BLEED - its texture runs right up to all four cell edges. NO gutters, NO margins, NO magenta, NO background colour anywhere on this sheet, NO visible lines between the four cells.`,
      // 沿用 G1 的两条硬教训：可辨认的小特征会变成可见的重复点阵；条纹有方向而地面不该有。
      registration: `Every swatch must survive being tiled: when the same swatch is repeated edge to edge across a large area, a viewer must NOT be able to pick out any feature and see it recurring on a regular lattice. This is the single most important requirement. Therefore each swatch carries NO single recognisable feature - no focal point, no large or high-contrast marks, no bright specks, no distinct clumps, no brightness falloff toward the edges. Especially swatches 1 (forest floor) and 2 (marsh): their variation is a very fine, dense, statistically uniform grain with NO element larger than one twenty-fifth of the cell - think fine noise, not scattered objects. For the cobblestone swatch the stones are many, small and uniform, with no one distinctive stone standing out.

All four swatches are NON-DIRECTIONAL: no streaks, no grooves, no rows, no combed or brushed look, no linear features sharing a common direction, nothing that would look wrong if the swatch were rotated 90 degrees.

Feature scale is consistent between all four cells.`,
      reading: 'forest-floor; marsh; cobble; sand.',
    }),
  },
  {
    // P3 地被：草丛/野花/灌木/石头是「让地图丰富起来」的主力
    // （实测占比：草 10% + 花 2% + 灌木 1.8% + 石 1.8% ≈ 15% 的格子）
    id: 'd01-groundcover',
    group: 'g2',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: ['grass-tuft', 'wildflower', 'leafy-bush', 'mossy-rock'],
    prompt: buildPrompt({
      assetType:
        'production raster sprite sheet of isolated small ground props for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `Four isolated small ground props, reading left to right, top to bottom:
(1) a small clump of tall meadow grass: fine hand-drawn olive-green blades fanning upward and outward from a single base;
(2) a low wildflower cluster: a few small white and pale-yellow blossoms on slender stems mixed with a little grass;
(3) a small rounded leafy bush with dense blue-green lobed foliage and a short visible base;
(4) a weathered grey boulder with a little soft moss on its top.

Each subject is a complete isolated silhouette with its base fully visible and unobstructed. No ground, no grass beyond the noted clump, no other props, no cast shadow.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Each subject stays entirely inside its own cell with a generous empty margin on all four sides, horizontally centred. ${magentaBackground()}`,
      registration: `Within each cell the subject occupies about 55% of the cell height, and the lowest point of the subject sits on a common baseline at 90% of the cell height in EVERY cell. Subjects are upright - no tilt, no rotation.`,
      reading: 'grass-tuft; wildflower; leafy-bush; mossy-rock.',
    }),
  },
  {
    // P3 地被：水生与林间点缀
    id: 'd02-accents',
    group: 'g2',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: ['cattail-reed', 'lily-pad', 'mushroom', 'tree-stump'],
    prompt: buildPrompt({
      assetType:
        'production raster sprite sheet of isolated small natural props for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `Four isolated small natural props, reading left to right, top to bottom:
(1) a cluster of slender upright wetland cattail reeds, a couple topped with a slim brown seed-head;
(2) a single flat round green lily-pad leaf with a small V notch, lying low as if floating;
(3) a small cluster of two or three rounded mushrooms with pale caps on short stems;
(4) a low weathered tree stump with visible cut rings on its top and a little bark texture.

Each subject is a complete isolated silhouette with its base fully visible and unobstructed. No ground, no water, no other props, no cast shadow.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Each subject stays entirely inside its own cell with a generous empty margin on all four sides, horizontally centred. ${magentaBackground()}`,
      registration: `The reeds, mushrooms and stump are upright with their lowest point on a common baseline at 90% of the cell height; the lily-pad sits low and flat, horizontally centred. Subjects occupy about 50% of the cell height. No tilt on the upright subjects.`,
      reading: 'cattail-reed; lily-pad; mushroom; tree-stump.',
    }),
  },
  {
    // P5 居民：Q 版村民公告牌，正面站立。NPC 按 hash 各挑一个。
    id: 'c01-villagers',
    group: 'g3',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: ['villager-young-woman', 'villager-farmer-man', 'villager-elder', 'villager-child'],
    prompt: buildPrompt({
      assetType:
        'production raster sprite sheet of isolated cute villager characters for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `Four isolated cute chibi villager characters, reading left to right, top to bottom, each STANDING STILL and facing the viewer straight on:
(1) a young woman with a short brown bob, a cream blouse and an olive pinafore skirt, arms relaxed at her sides;
(2) a stocky farmer man in a straw hat, a rust-brown work shirt and rolled trousers;
(3) a gentle white-haired elder in a long muted teal robe, hands clasped in front;
(4) a small child in a simple mossy-green tunic.

Cute proportions with a large round expressive head and a small body. Complete figure from head to feet; both feet fully visible on the ground line. Calm neutral standing pose, no props held, no weapons, no pets.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Each character stays entirely inside its own cell with a generous empty margin on all four sides, horizontally centred. ${magentaBackground()}`,
      registration: `Within each cell the character occupies about 70% of the cell height, and the lowest point of the feet sits on a common baseline at 92% of the cell height in EVERY cell. Characters stand upright and symmetric, facing straight forward - no tilt, no rotation, no three-quarter turn.`,
      reading: 'villager-young-woman; villager-farmer-man; villager-elder; villager-child.',
    }),
  },
  {
    // P3+ 主角四朝向：down/up/left/right 四个站姿。行走靠引擎里叠一个程序化上下颠簸，
    // 不再让模型画 16 帧走循环（那次尝试整个崩了：变成写实人脸、风格全失）。
    id: 'h01-hero-dirs',
    group: 'g4',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: ['hero-down', 'hero-up', 'hero-left', 'hero-right'],
    prompt: buildPrompt({
      assetType:
        'production raster sprite sheet of one cute villager character seen from four directions for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `The SAME single cute chibi young woman in all four cells, absolutely identical in face, hair, outfit and colours: a short brown bob, a cream long-sleeve blouse, an olive pinafore skirt and small brown shoes. Large round expressive head, small body, standing still with both feet on the ground. Reading left to right, top to bottom, she is shown facing four different directions:
(1) facing the viewer, seen from the FRONT (you see her face);
(2) facing away, seen from the BACK (you see the back of her head and hair, no face);
(3) facing to the LEFT, seen in clean left-side profile;
(4) facing to the RIGHT, seen in clean right-side profile.

Cute proportions, calm neutral standing pose, no props held, no weapons, no pets. Complete figure from head to feet in every cell.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. The character stays entirely inside its own cell with a generous empty margin on all sides, horizontally centred. ${magentaBackground()}`,
      registration: `In every cell the character occupies about 70% of the cell height and the lowest point of the feet sits on a common baseline at 92% of the cell height. She is upright, never tilted. The four cells are the SAME character from four directions - identical size, outfit and colours; only the facing direction differs.`,
      reading: 'hero-down (front); hero-up (back); hero-left; hero-right.',
    }),
  },
  ...['down', 'up', 'left', 'right'].map((dir) => ({
    // 主角逐帧走循环：四方向各一张 4×4 = **16 帧**（每帧 256px @ 1024）。
    // ⚠️ 单视角 16 帧模型稳得住（试水 down 那张实测身份一致、抠像干净）；而 4 方向混排一张
    // 4×4 会崩（写实人脸、风格全失，见 h01 注释）。所以四方向各出一张、每张都是单视角。
    id: 'h03-walk16-' + dir,
    group: 'g5',
    cols: 4,
    rows: 4,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: Array.from({ length: 16 }, (_, f) => 'walk-' + dir + '-' + f),
    prompt: buildPrompt({
      assetType:
        'production 4x4 sixteen-frame WALK-CYCLE sprite sheet of one cute villager character for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `The SAME single cute chibi young woman in all 16 cells, absolutely identical in face, hair, outfit, colours and size: a short brown bob, a cream long-sleeve blouse, an olive pinafore skirt and small brown shoes. Large round expressive head, small body, complete figure from head to feet, ${
        dir === 'down'
          ? 'seen from the FRONT, facing straight toward the viewer (you see her face)'
          : dir === 'up'
            ? 'seen from the BACK, facing straight away from the viewer (you see the back of her head, no face)'
            : dir === 'left'
              ? 'seen in clean LEFT-side profile, facing and walking to the left'
              : 'seen in clean RIGHT-side profile, facing and walking to the right'
      } in EVERY cell.

Reading left to right then top to bottom, the 16 cells are the 16 successive frames of ONE smooth, slow, looping walk cycle (frame 16 leads back into frame 1). Across the sequence her legs step forward and back in a full stride, her arms swing gently in counter-motion, and her body bobs slightly up and down - the change from each frame to the very next one is SMALL and gradual. Her identity, outfit, colours and overall size are exactly the same in every single cell; ONLY the walk pose (legs, arms, small bob) advances.`,
      layout: `Render an EXACT 4-column by 4-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 256 by 256 pixels. The character stays entirely inside its own cell with a small even margin, horizontally centred. ${magentaBackground()}`,
      registration: `In EVERY one of the 16 cells the character occupies about 84% of the cell height and the lowest planted foot sits on a common baseline at 90% of the cell height, so she does not jump around when the frames play in sequence. She stays upright in all 16 cells, always facing the SAME direction. Character identity, outfit and scale are IDENTICAL across all 16 cells - the single most important requirement; only the walk pose advances smoothly frame by frame.`,
      reading: '16 frames of one smooth ' + dir + '-facing walk cycle, in order.',
    }),
  })),
  ...['down', 'up', 'left', 'right'].map((dir) => ({
    // 主角待机循环：四方向各一张 4×4 = **16 帧**（每帧 256px @ 1024），与 walk16 同格式。
    // ⚠️ 单视角 16 帧稳（同 walk16 的经验）；待机动作更小——只呼吸/眨眼/极轻摆动，双脚钉在原地。
    id: 'h04-idle16-' + dir,
    group: 'g5',
    cols: 4,
    rows: 4,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: Array.from({ length: 16 }, (_, f) => 'idle-' + dir + '-' + f),
    prompt: buildPrompt({
      assetType:
        'production 4x4 sixteen-frame IDLE / breathing sprite sheet of one cute villager character standing still, for a hand-painted 2D pastoral life-simulation game.',
      lighting: 'keyed',
      primary: `The SAME single cute chibi young woman in all 16 cells, absolutely identical in face, hair, outfit, colours and size: a short brown bob, a cream long-sleeve blouse, an olive pinafore skirt and small brown shoes. Large round expressive head, small body, complete figure from head to feet, ${
        dir === 'down'
          ? 'seen from the FRONT, facing straight toward the viewer (you see her face)'
          : dir === 'up'
            ? 'seen from the BACK, facing straight away from the viewer so you ONLY ever see the back of her head and hair - NO face and NO eyes in ANY of the 16 cells; she never turns around, not even for a moment'
            : dir === 'left'
              ? 'seen in clean LEFT-side profile, facing to the left'
              : 'seen in clean RIGHT-side profile, facing to the right'
      } in EVERY cell.

She is STANDING STILL, not walking - both feet stay planted in the exact same spot in every cell, arms resting at her sides. Reading left to right then top to bottom, the 16 cells are the 16 successive frames of ONE calm, slow, looping IDLE breathing cycle (frame 16 leads back into frame 1). Across the sequence her chest and shoulders rise and fall in a gentle slow breath, ${
        dir === 'up'
          ? 'she keeps facing directly away the entire time (no blink is visible from behind and she does NOT turn her head)'
          : 'she blinks once softly near the middle of the loop'
      }, and her whole body sways only a hair for balance - the change from each frame to the very next one is TINY and gradual. Her identity, outfit, colours, pose and overall size are the same in every single cell; ONLY the subtle breathing${
        dir === 'up' ? '' : ', one blink'
      } and the faint sway advance.`,
      layout: `Render an EXACT 4-column by 4-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 256 by 256 pixels. The character stays entirely inside its own cell with a small even margin, horizontally centred. ${magentaBackground()}`,
      registration: `In EVERY one of the 16 cells the character occupies about 84% of the cell height and both planted feet sit on a common baseline at 90% of the cell height, in the same horizontal position, so she does not drift when the frames play in sequence. She stays upright and standing in all 16 cells, always facing the SAME direction. Character identity, outfit, pose and scale are IDENTICAL across all 16 cells - the single most important requirement; only the subtle breathing, blink and faint sway advance frame by frame.`,
      reading: '16 frames of one calm ' + dir + '-facing idle breathing cycle, in order.',
    }),
  })),
  {
    // 城镇建筑（沿广场/街巷而立）。SEC_VIEWPOINT 本就是照建筑写的：正面朝向、轴对齐、
    // 62° 俯视看得到正墙 + 上方屋顶、对称山墙冲着观者 —— 正好是公告牌要的样子。
    id: 'e01-town-buildings',
    group: 'g6',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: ['cottage', 'two-storey-house', 'shop', 'inn'],
    prompt: buildPrompt({
      assetType:
        'production raster sprite sheet of isolated hand-painted village buildings for a 2D pastoral life-simulation game, each seen front-on from the oblique overhead game camera.',
      lighting: 'keyed',
      primary: `Four separate, isolated storybook buildings, reading left to right, top to bottom, each drawn FRONT-ON and axis-aligned (front wall parallel to the image edge, symmetrical gable pointing straight at the viewer, roof seen from slightly above, only the one front wall visible - never a corner or side wall):
(1) a cosy single-storey cottage: honey-timber plank walls with visible joinery, a low fieldstone foundation, a centred wooden plank door, two small square windows glowing warm cream, a steep pitched roof of muted blue-green shingles, a tiny flower box of little blossoms under one window;
(2) a taller two-storey timber house in the same style: door and two windows on the ground floor, two shuttered windows on the upper floor, a steep pitched blue-green roof and a small brick chimney at the ridge;
(3) a two-storey shop: a wide ground-floor timber counter opening under a scalloped cloth awning in muted olive-and-cream stripes, warm windows above, and a small solid wooden hanging sign board (completely blank, no lettering) mounted flat against the wall beside the door - no thin protruding brackets or ironwork sticking out into the background;
(4) a larger three-storey inn: sturdy timber framing, a broad pitched roof, several warm-lit windows stacked up the front, a covered doorway with a plain hanging lantern.

Each building is a COMPLETE structure with the full width of its front wall and its foundation clearly visible and unobstructed at the bottom. No ground, no grass, no path, no fence, no people, no other buildings, no cast shadow.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Each building stays entirely inside its own cell with an even margin on all four sides, horizontally centred. ${magentaBackground()}`,
      registration: `Within each cell the building is horizontally centred and the bottom of its foundation sits on a common baseline at about 90% of the cell height in EVERY cell. Buildings are upright and axis-aligned - no tilt, no rotation, no three-quarter turn. Wider buildings may fill more of the cell width; taller buildings more of the height.`,
      reading: 'cottage; two-storey-house; shop; inn.',
    }),
  },
  {
    id: 'e02-rural-structures',
    group: 'g6',
    cols: 2,
    rows: 2,
    size: DEFAULT_SIZE,
    kind: 'keyed',
    names: ['barn', 'workshop', 'well', 'cottage-stone'],
    prompt: buildPrompt({
      assetType:
        'production raster sprite sheet of isolated hand-painted rural structures for a 2D pastoral life-simulation game, each seen front-on from the oblique overhead game camera.',
      lighting: 'keyed',
      primary: `Four separate, isolated structures, reading left to right, top to bottom, each drawn FRONT-ON and axis-aligned (front wall parallel to the image edge, symmetrical gable straight at the viewer, only the one front wall visible - never a corner or side wall):
(1) a broad weathered timber barn, wider than it is tall: tall double plank doors in the centre, a small hay-loft opening in the gable above, a steep pitched roof of muted blue-green;
(2) a modest workshop shed: honey-timber walls, a single wide work window showing tools inside, a lean-to slanted roof, a neat stack of sawn logs against the wall;
(3) a small village well: a round fieldstone rim, two timber posts holding a little peaked wooden shelter roof over it, a wooden bucket on a rope - a small structure, clearly shorter and narrower than the others;
(4) a cottage with stone lower walls and honey-timber upper walls, a centred door, two warm windows, a steep pitched blue-green roof.

Each structure is COMPLETE with its base clearly visible and unobstructed at the bottom. No ground, no grass, no path, no fence, no people, no other structures, no cast shadow.`,
      layout: `Render an EXACT 2-column by 2-row grid. Output size is 1024 by 1024 pixels; each cell is exactly 512 by 512 pixels. Each structure stays entirely inside its own cell with an even margin on all four sides, horizontally centred. ${magentaBackground()}`,
      registration: `Within each cell the structure is horizontally centred and the bottom of its base sits on a common baseline at about 90% of the cell height in EVERY cell. Structures are upright and axis-aligned - no tilt, no rotation, no three-quarter turn. The well (cell 3) is deliberately small; the barn (cell 1) is wide.`,
      reading: 'barn; workshop; well; cottage-stone.',
    }),
  },
]

export function sheetById(id) {
  return SHEETS.find((s) => s.id === id)
}

export function sheetsInGroup(group) {
  return SHEETS.filter((s) => s.group === group)
}

/** 出图前的自检：名称数量必须与网格格数一致 */
export function validateSheets() {
  const problems = []
  for (const s of SHEETS) {
    const cells = s.cols * s.rows
    if (s.names.length !== cells) {
      problems.push(`${s.id}: ${s.cols}×${s.rows}=${cells} 格，但给了 ${s.names.length} 个名字`)
    }
    const [w, h] = s.size.split('x').map(Number)
    if (w % s.cols !== 0 || h % s.rows !== 0) {
      problems.push(`${s.id}: ${s.size} 不能被 ${s.cols}×${s.rows} 整除`)
    }
    if (s.kind === 'keyed' && !s.prompt.includes('#FF00FF')) {
      problems.push(`${s.id}: 声明为抠像图，但 prompt 里没有洋红背景的要求`)
    }
    if (s.kind === 'tiling' && s.prompt.includes('#FF00FF')) {
      problems.push(`${s.id}: 声明为平铺图，但 prompt 里要了洋红背景`)
    }
  }
  return problems
}
