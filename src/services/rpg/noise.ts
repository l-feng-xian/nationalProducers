/**
 * 环面（torus）噪声 —— 「球型无缝」的实现。
 *
 * ## 为什么是环面而不是球
 * 正方格铺不满球面（球面无法用规则四方格无畸变地铺满，必然有极点奇异）。
 * 而玩家的实际需求是「朝任意方向一直走都能绕回原点、且看不出接缝」——
 * 这正是**环面拓扑**：平面的左右边相接、上下边相接。显示上仍是平面，
 * 走动上却是闭合的，四个方向各绕一圈。
 *
 * ## 接缝怎么消掉
 * 关键不在贴图，而在**噪声本身必须在两个方向都是周期的**。
 * 做法是把平面坐标映射到 4D 空间里一个环面的表面，再采 4D simplex 噪声：
 *
 *   u = x / W,  v = y / H
 *   P = (cos2πu·r1, sin2πu·r1, cos2πv·r2, sin2πv·r2)
 *
 * `u=0` 与 `u=1` 映射到**同一个 4D 点**，所以 `sample(0,y)` 与 `sample(W,y)`
 * 在数学上就是同一个值，不需要任何边界缝合、羽化或镜像。
 *
 * 实测残差 ~1e-15（双精度 ulp 级，`cos(0)` 与 `cos(2π)` 并非 bit-identical），
 * 而生态阈值的间距在 0.03 量级 —— 差了十几个数量级，不可能翻转任何一格。
 * ⚠️ 但**偏移多圈**（如 x+3W）会因为三角函数的大幅角约减掉精度，实测约 2.6e-5。
 * 所以所有对外查询都必须先 `wrapX/wrapY` 回绕成 [0,W) 的整数再取样 ——
 * world.ts 就是这么做的，于是这条精度损失在实际路径上根本不会发生。
 *
 * 纯 service：不 import vue/pinia。
 */

import { createNoise4D } from 'simplex-noise'
import { seededRandom } from '@/services/hash'

/** 生态分类。数值即图块 id，渲染端按它查图集 */
export const BIOME = {
  water: 0,
  shallow: 1,
  sand: 2,
  grass: 3,
} as const

export type Biome = (typeof BIOME)[keyof typeof BIOME]

/** 能不能走上去。水不能，其余都能 */
export function isWalkable(b: Biome): boolean {
  return b !== BIOME.water
}

export interface WorldParams {
  /** 世界宽高，单位是格。必须是整数 */
  width: number
  height: number
  seed: number
  /**
   * 环面的两个半径。比值决定「同一圈里能塞下多少特征」——
   * 半径越大，绕一圈经过的噪声越多，地貌越碎。
   */
  r1?: number
  r2?: number
  /** 海平面。height 噪声低于它就是水 */
  seaLevel?: number
  /**
   * 湿度偏置，直接加在湿度场上。>0 更多森林，<0 更多荒原与沙。
   *
   * ⚠️ 必须加在 `moisture()` **内部**：湿度有三个消费方（生态判定、道具密度
   * 分档、describeArea 的地貌措辞），它们必须一起移动，否则会出现
   * 「明明是森林却按荒原的密度长树」这种自相矛盾的地。
   */
  moistureBias?: number
  /** 聚落场门限。越低越多大区够格出村。村庄相关，噪声层不读它 */
  districtGate?: number
  /** 每个区域的落村概率。村庄相关，噪声层不读它 */
  villageChance?: number
  /**
   * 内陆湖。⚠️ 默认 **false** —— 老世界绝不能凭空长出湖来。
   *
   * 刻意**不新增生态枚举**：湖就是普通的 water/shallow。加一个 BIOME.lake 要改
   * 七处 `b === water || b === shallow`（可行走、挡路、高度、水面网格、泡沫、
   * 地貌措辞……），每一处都是一次「忘了改」的机会 —— 漏一处就是「湖能走上去」
   * 或者「湖没有泡沫」或者「湖壁渲染成土崖」。不加枚举则 scene / water.tsl /
   * walkableAt / BLOCKERS **零改动**，湖天生就有波纹、岸线泡沫与可蹚的浅边。
   */
  lakes?: boolean
}

/**
 * ⚠️ 每个默认值就是引入参数化之前代码里写死的那个常量。
 *
 * 这不是随便挑的「合理默认」：存档里只存种子，地形是每次进游戏现算的。
 * 默认值一变，玩家回到自己那个世界会发现海岸线和村子全挪了位置。
 * 于是「老世界地形不变」成了**类型签名的性质** —— 调用方不传就等于老行为，
 * 而不是「记得去回填」的纪律。
 */
const DEFAULTS = {
  r1: 1.6,
  r2: 1.6,
  seaLevel: -0.08,
  moistureBias: 0,
}

/** 分形叠加的层数与衰减。三层足够出「大陆 + 海湾 + 碎岛」的层次，再多只是白烧 CPU */
const OCTAVES = 3
const LACUNARITY = 2
const GAIN = 0.5

// ── 立体方块地形的量化参数 ──
/** 一级台阶的世界高度（格）。参考图里悬崖的「一格」就是这个厚度 */
export const BLOCK_H = 0.3
/** 高度噪声每升多少幅度抬一级台阶。0.09 × 上限 ~0.8 ≈ 最多 9 级梯田 */
const LEVEL_STEP = 0.09
/** 台阶等级上限。fBm 归一化后动态范围有限，封顶防止极个别尖塔 */
const MAX_LEVEL = 9
/** 湖场阈值。0.22 在 256² 上出个位数的几片湖；调低会变成满地水洼 */
const LAKE_T = 0.22
/** 深水海床的顶面高度。隔着半透明水面看到的就是它 */
export const WATER_BED_Y = -0.72
/** 浅滩海床：比水面略低，角色走上去是「蹚水」的效果 */
export const SHALLOW_BED_Y = -0.26
/** 水面高度。贴在沙滩顶（y=0）稍下方 */
export const WATER_SURFACE_Y = -0.08

export interface WorldSampler {
  readonly width: number
  readonly height: number
  /** 高度场，约 -1..1。> seaLevel 为陆地 */
  height01(x: number, y: number): number
  /** 湿度场，约 -1..1。决定陆地上是沙还是草 */
  moisture(x: number, y: number): number
  /**
   * 聚落场，约 -1..1。低频（环面半径缩到 0.28），出「文明大区 / 蛮荒大区」：
   * 村庄只会在聚落场高的大区里出现，于是世界天然分成有村镇的腹地与大片荒野。
   */
  district(x: number, y: number): number
  /**
   * 宏生态场，约 -1..1。比湿度低得多的频率（环面半径缩到 0.22），划出「大片
   * 森林省 / 大片荒野省」。regionAt 把它叠在湿度上：于是生态不再是「湿度过某线
   * 就变森林」的一刀切，而是「本就偏林的大区里、又够湿的地方」才成林 —— 分区
   * 成片，边界更像自然的省界而非等高线。
   */
  macro(x: number, y: number): number
  /**
   * 域扭曲（domain warp）偏移，单位是格。把生态的采样点整体错开一段，
   * 让森林/草甸/荒野的分界从光滑大团 blob 变成有机、交错的犬牙状。
   *
   * ⚠️ 两个分量本身也是环面周期场，所以「采样点 = 原点 + 偏移」在接缝两侧
   * 仍然连续 —— 域扭曲不会把无缝拓扑破坏掉。
   */
  warpX(x: number, y: number): number
  warpY(x: number, y: number): number
  /**
   * 地表台阶等级（整数）：陆地 0..MAX_LEVEL，浅滩 -2、深水 -3。
   * 数值翻成世界高度是渲染层的事（见 world.heightAt）。
   */
  levelAt(x: number, y: number): number
  biomeAt(x: number, y: number): Biome
  /**
   * 该格的水是不是**内陆湖**（而不是海）。
   * 只给地貌措辞用 —— 渲染层不需要区分，湖与海走的是同一套水面材质。
   */
  isLakeAt(x: number, y: number): boolean
  /** 把任意整数格坐标回绕进 [0,width) × [0,height) */
  wrapX(x: number): number
  wrapY(y: number): number
}

/**
 * 建一个世界取样器。
 *
 * 两个噪声场用**不同的种子偏移**，否则高度与湿度完全相关，
 * 沙地只会出现在固定海拔上，看着像等高线而不是生态。
 */
export function createSampler(p: WorldParams): WorldSampler {
  const width = Math.max(1, Math.floor(p.width))
  const height = Math.max(1, Math.floor(p.height))
  const r1 = p.r1 ?? DEFAULTS.r1
  const r2 = p.r2 ?? DEFAULTS.r2
  const seaLevel = p.seaLevel ?? DEFAULTS.seaLevel
  const moistureBias = p.moistureBias ?? DEFAULTS.moistureBias

  const noiseH = createNoise4D(seededRandom(p.seed))
  // ^ 与 v 两个场必须用不同种子，见上面的说明
  const noiseM = createNoise4D(seededRandom(p.seed ^ 0x9e3779b9))
  // 聚落场：又一个独立种子。它只出「文明 / 蛮荒」的大区划分，别与湿度相关，
  // 否则村庄永远长在森林里（或永远长在沙漠边）
  const noiseD = createNoise4D(seededRandom(p.seed ^ 0x51ab3f1))
  // 湖场：第四个独立种子。与前三个都不相关，否则湖会永远长在森林里（或永远
  // 贴着海岸）—— 那样它就不像湖，像高度场的某种副产品
  const noiseL = createNoise4D(seededRandom(p.seed ^ 0x2e7d1a55))
  // 宏生态省 + 两个域扭曲分量：各自独立种子，互不相关，否则「省界」会与湿度或
  // 高度锁死，退化成又一条等高线
  const noiseMacro = createNoise4D(seededRandom(p.seed ^ 0x1b873593))
  const noiseWx = createNoise4D(seededRandom(p.seed ^ 0x85ebca6b))
  const noiseWy = createNoise4D(seededRandom(p.seed ^ 0xc2b2ae35))
  const lakes = p.lakes === true

  const TAU = Math.PI * 2

  /**
   * 分形布朗运动，采样点落在 4D 环面上。
   *
   * ⚠️ 每一倍频都必须**整体缩放环面半径**，而不是缩放 u/v。
   * 缩放 u/v 会让高倍频的周期不再是 1，接缝立刻回来 —— 这是这套做法里
   * 最容易写错、而且只在世界边界处才看得出来的一点。
   *
   * `radiusScale` 整体缩放基础环面半径：<1 即降低频率（更大的地貌区块）。
   */
  const fbm = (
    noise: ReturnType<typeof createNoise4D>,
    x: number,
    y: number,
    radiusScale = 1,
    octaves = OCTAVES,
  ): number => {
    const u = (x / width) * TAU
    const v = (y / height) * TAU
    const cu = Math.cos(u)
    const su = Math.sin(u)
    const cv = Math.cos(v)
    const sv = Math.sin(v)
    const r1s = r1 * radiusScale
    const r2s = r2 * radiusScale

    let amp = 1
    let freq = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise(cu * r1s * freq, su * r1s * freq, cv * r2s * freq, sv * r2s * freq)
      norm += amp
      amp *= GAIN
      freq *= LACUNARITY
    }
    return norm > 0 ? sum / norm : 0
  }

  const wrapX = (x: number): number => ((x % width) + width) % width
  const wrapY = (y: number): number => ((y % height) + height) % height

  const height01 = (x: number, y: number): number => fbm(noiseH, x, y)
  // 偏置加在这里而不是各调用处：湿度的三个消费方（生态、道具密度、地貌措辞）
  // 必须一起移动，否则会长出「按荒原密度长树的森林」
  const moisture = (x: number, y: number): number => fbm(noiseM, x, y) + moistureBias
  const district = (x: number, y: number): number => fbm(noiseD, x, y, 0.28, 2)

  // 宏生态省：比湿度低得多的频率，出大片成省的生态倾向
  const macro = (x: number, y: number): number => fbm(noiseMacro, x, y, 0.22, 2)

  /**
   * 域扭曲偏移。振幅约 ±WARP_CELLS 格，频率介于湿度与宏场之间 —— 太高会把
   * 分界搅成噪点，太低则整片一起平移、看不出交错。
   */
  const WARP_CELLS = 7
  const warpX = (x: number, y: number): number => fbm(noiseWx, x, y, 0.6, 2) * WARP_CELLS
  const warpY = (x: number, y: number): number => fbm(noiseWy, x, y, 0.6, 2) * WARP_CELLS

  /** 湖场：低频两倍频 —— 出「几片大湖」而不是满地水洼 */
  const lakeField = (x: number, y: number): number => fbm(noiseL, x, y, 0.55, 2)

  /**
   * 该格是不是湖。0=不是，1=湖滩，2=深湖。
   *
   * ⚠️ 高度带门控是这套做法的**全部关键**，不是优化：
   *  - 下界 seaLevel+0.05 在浅滩带**之上**，所以湖与海之间必然隔着一圈浅滩或沙，
   *    「内陆」这个性质是结构上保证的，不是靠调参碰运气；
   *  - 上界 seaLevel+0.30 挡住山顶大湖，顺带避免湖挂在悬崖上（台阶落差会穿帮）。
   * 而且这个门是一次浮点比较，h 在调用处早就算出来了 —— 绝大多数格（海、高地）
   * 为湖多付的代价就是这一次比较，湖噪声根本不会被求值。
   */
  const lakeKind = (x: number, y: number, h: number): 0 | 1 | 2 => {
    if (!lakes) return 0
    if (h < seaLevel + 0.05 || h > seaLevel + 0.3) return 0
    const l = lakeField(x, y)
    if (l <= LAKE_T) return 0
    // ⚠️ 光靠高度带**挡不住**湖与海连上。带宽只有 0.02，在坡陡的地方不足一格宽，
    // 于是 h=0.051 的湖格会紧挨着 h=0.029 的浅滩 —— 实测 1383 个湖格里有 201 个
    // 贴着海。这里补一道邻格检查：八邻中只要有一格低于浅滩线就不算湖。
    // 于是「湖离海至少隔一格」成了**结构保证**而不是调参碰运气。
    // 判据用的是**原始高度**而不是 biomeAt，所以不会递归回 lakeKind。
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue
        if (height01(x + dx, y + dy) < seaLevel + 0.03) return 0
      }
    }
    return l > LAKE_T + 0.05 ? 2 : 1
  }

  const biomeAt = (x: number, y: number): Biome => {
    const h = height01(x, y)
    if (h < seaLevel - 0.06) return BIOME.water
    // 浅滩：紧贴海平面的一条带，是水陆之间的过渡，可以蹚水走过去
    if (h < seaLevel + 0.03) return BIOME.shallow
    // 湖：只在「已经是陆地、但还没爬高」的那一段里问湖场。
    // lakes 关掉时这里只是一次布尔判断，老世界逐格结果与从前完全相同
    const lk = lakeKind(x, y, h)
    if (lk === 2) return BIOME.water
    if (lk === 1) return BIOME.shallow
    // 离岸不远且干燥 → 沙；其余是草
    const m = moisture(x, y)
    if (h < seaLevel + 0.14 && m < 0.12) return BIOME.sand
    return m < -0.42 ? BIOME.sand : BIOME.grass
  }

  /** 高度 → 台阶等级。浅滩 / 深水用负数标记，海床高度是常量而不是台阶 */
  const levelAt = (x: number, y: number): number => {
    const h = height01(x, y)
    if (h < seaLevel - 0.06) return -3
    if (h < seaLevel + 0.03) return -2
    // ⚠️ **必须与 biomeAt 同步**。biomeAt 与 levelAt 是两个各自读同一个高度场的
    // 函数；这里漏掉湖判定的话，湖床会按陆地高度渲染，而水面钉在 WATER_SURFACE_Y
    // 这个常量上 —— 水面跑到地形**下面**，湖要么看不见要么里外翻转。
    // 光看任一个函数都发现不了，这是整件事最容易翻车的一处。
    const lk = lakeKind(x, y, h)
    if (lk === 2) return -3
    if (lk === 1) return -2
    return Math.min(MAX_LEVEL, Math.floor((h - seaLevel) / LEVEL_STEP))
  }

  /** 该格是不是湖（而不是海）。只给地貌措辞用：「湖畔」与「海边」不是一回事 */
  const isLakeAt = (x: number, y: number): boolean => lakeKind(x, y, height01(x, y)) !== 0

  return {
    width,
    height,
    height01,
    moisture,
    district,
    macro,
    warpX,
    warpY,
    levelAt,
    biomeAt,
    isLakeAt,
    wrapX,
    wrapY,
  }
}
