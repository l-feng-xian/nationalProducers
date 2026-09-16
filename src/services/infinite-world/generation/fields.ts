/**
 * 世界的噪声场。
 *
 * ## ⚠️ 回绕纪律
 * **每个 Fields 方法的第一行都是回绕**。理由见 noise.ts 的文件头：
 * 偏移多圈会因三角函数大幅角约减掉精度（实测 40 圈后 1.7e-13），
 * 而域扭曲会把这个误差再放大一档。回绕成 [0,512) 之后残差回到 ulp 级。
 *
 * 唯一允许传非回绕坐标的地方是域扭曲本身（`moisture(x + wx, y + wy)`），
 * 但 `moisture` 自己第一行就回绕，所以它也是安全的。
 *
 * ## 为什么是八个独立的场
 * 每个场一条独立的种子流（见 rng.ts）。它们必须互不相关，否则会退化：
 * 比如湿度与高度共用一条流，森林就永远长在等高线上，看起来像画出来的梯田。
 *
 * 纯 service：不 import vue/pinia/three。
 */

import { WORLD_SIZE } from '../core/constants'
import { wrap } from '../core/torus'
import { createTorusFbm, makeNoise4D, type Field2D } from './noise'
import { seedOf, seededRandom, streamSeed } from './rng'

export interface FieldParams {
  seed: string
  /**
   * 湿度偏置。>0 更多森林，<0 更多荒原与沙。
   *
   * ⚠️ 必须加在 `moisture()` **内部**。湿度有三个消费方
   * （生态判定、装饰密度分档、地貌措辞），它们必须一起移动，
   * 否则会出现「明明判成森林，却按荒原的密度长树」这种自相矛盾的地。
   */
  moistureBias?: number
}

export interface Fields {
  /** 高度。海平面、坡度、流向都读它 */
  elevation: Field2D
  /** 干湿。已含 moistureBias */
  moisture: Field2D
  /** 宏生态省：大尺度的气候分区 */
  macro: Field2D
  /** 文明 / 蛮荒大区。城镇门控读它 */
  settlement: Field2D
  /** 湖场：辅助填洼阶段挑选终端盆地 */
  lake: Field2D
  /** 地表变体与地被密度抖动 */
  detail: Field2D
  /** 域扭曲位移（格）。让生态边界犬牙交错而不是圆滑等值线 */
  warp(x: number, y: number): readonly [number, number]
}

/** 域扭曲的最大位移（格）。太大生态会碎成噪点，太小边界会圆滑得像等高线 */
const WARP_AMPLITUDE = 7

export function createFields(p: FieldParams): Fields {
  const base = seedOf(p.seed)
  const bias = p.moistureBias ?? 0
  const n = (label: string) => makeNoise4D(seededRandom(streamSeed(base, label)))

  /**
   * ⚠️ 高度场必须是**三个尺度的加权和**，不能只用一层。
   *
   * 最初写成 `{ octaves: 3, radiusScale: 1 }`，全部断言都过，但渲染出来是
   * 「均匀绿底 + 满屏圆形池塘」—— 没有海岸线、没有陆块，因为那个配置的特征
   * 尺度只有约 57 格，整张图就是均匀噪点。海平面按分位数一切，切出来自然是
   * 散落的水洼而不是海。
   *
   * 大陆层（radiusScale 0.35，约 2-3 个陆块）负责「哪里是海哪里是陆」，
   * 区域层负责丘陵起伏，细节层只做表面粗糙度。权重必须让大陆层主导。
   */
  const fContinent = createTorusFbm(n('continent'), { octaves: 2, radiusScale: 0.35 })
  const fRegional = createTorusFbm(n('elevation'), { octaves: 3, radiusScale: 1.2 })
  const fRough = createTorusFbm(n('rough'), { octaves: 2, radiusScale: 3 })
  const fElevation: Field2D = (x, y) =>
    clamp1(fContinent(x, y) * 1.0 + fRegional(x, y) * 0.32 + fRough(x, y) * 0.1)
  const fMoisture = createTorusFbm(n('moisture'), { octaves: 3, radiusScale: 1 })
  // ⚠️ macro / settlement 的 radiusScale 不能再小了。实测（8 种子）：
  //
  //   radiusScale | 全世界的特征数 | 场间最大相关
  //   -----------|---------------|-------------
  //      0.22    |    1 个       |    0.516     ← 一道斜坡，不是「省」
  //      0.50    |    5 个       |    0.211
  //      0.70    |    7 个       |    0.170
  //
  // 0.22 在 512 格世界上只产出**一个**特征 —— 那是一道线性斜坡，
  // 而两道独立的斜坡在小定义域上自然高度相关。后果就是
  // 「村子永远长在同一种生态里」，看起来像是规则写死的。
  // （这个数原本是从旧模块 256 格世界等比搬来的，没跟着世界变大调整。）
  //
  // 两者取不同的 radiusScale，特征尺度错开，也帮助去相关。
  const fMacro = createTorusFbm(n('macro'), { octaves: 2, radiusScale: 0.7 })
  const fSettlement = createTorusFbm(n('settlement'), { octaves: 2, radiusScale: 0.5 })
  const fLake = createTorusFbm(n('lake'), { octaves: 2, radiusScale: 0.6 })
  const fWarpX = createTorusFbm(n('warpX'), { octaves: 2, radiusScale: 0.6 })
  const fWarpY = createTorusFbm(n('warpY'), { octaves: 2, radiusScale: 0.6 })
  const fDetail = createTorusFbm(n('detail'), { octaves: 1, radiusScale: 2.5 })

  return {
    elevation: (x, y) => fElevation(wrap(x), wrap(y)),
    // bias 加在这里 —— 三个消费方读的是同一个函数，天然一起移动
    moisture: (x, y) => clamp1(fMoisture(wrap(x), wrap(y)) + bias),
    macro: (x, y) => fMacro(wrap(x), wrap(y)),
    settlement: (x, y) => fSettlement(wrap(x), wrap(y)),
    lake: (x, y) => fLake(wrap(x), wrap(y)),
    detail: (x, y) => fDetail(wrap(x), wrap(y)),
    warp: (x, y) => {
      const wx = wrap(x)
      const wy = wrap(y)
      // 扭曲场本身也是环面周期的，所以扭曲后的采样仍然无缝
      return [fWarpX(wx, wy) * WARP_AMPLITUDE, fWarpY(wx, wy) * WARP_AMPLITUDE] as const
    },
  }
}

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

export interface BakedElevation {
  /** 512×512 行主序 */
  elevation: Float32Array
  /** 低于它即为水。由 waterRatio 分位数解出 */
  seaLevel: number
  min: number
  max: number
}

/** 直方图桶数。4096 桶覆盖 [-1,1]，分辨率 4.9e-4，远细于生态阈值间距 0.03 */
const HIST_BUCKETS = 4096

/**
 * 把高度场铺进数组，并按 `waterRatio` **分位数**解出海平面。
 *
 * ## 为什么用分位数而不是常数阈值
 * 常数阈值下，`waterRatio` 只是个乘在某处的魔法系数 —— 换个种子水面占比就变了，
 * 用户拖到 0.2 可能得到 5% 也可能得到 40% 的水。
 *
 * 分位数让这个旋钮第一次有了**精确语义**：水面占比就是这个数，与种子无关。
 * 代价只是一次 O(N) 直方图。
 */
export function bakeElevation(fields: Fields, waterRatio: number): BakedElevation {
  const n = WORLD_SIZE * WORLD_SIZE
  const elevation = new Float32Array(n)
  const hist = new Int32Array(HIST_BUCKETS)
  let min = Infinity
  let max = -Infinity

  for (let y = 0; y < WORLD_SIZE; y++) {
    const row = y * WORLD_SIZE
    for (let x = 0; x < WORLD_SIZE; x++) {
      const v = fields.elevation(x, y)
      elevation[row + x] = v
      if (v < min) min = v
      if (v > max) max = v
      // [-1,1] → [0, HIST_BUCKETS)
      let b = Math.floor(((v + 1) / 2) * HIST_BUCKETS)
      if (b < 0) b = 0
      else if (b >= HIST_BUCKETS) b = HIST_BUCKETS - 1
      hist[b]!++
    }
  }

  const target = Math.round(clamp01(waterRatio) * n)
  let acc = 0
  let bucket = 0
  for (; bucket < HIST_BUCKETS; bucket++) {
    const c = hist[bucket]!
    if (acc + c >= target) break
    acc += c
  }

  // 桶内线性插值，把量化误差再压一档
  const inBucket = hist[Math.min(bucket, HIST_BUCKETS - 1)]! || 1
  const frac = Math.min(1, Math.max(0, (target - acc) / inBucket))
  const seaLevel = ((bucket + frac) / HIST_BUCKETS) * 2 - 1

  return { elevation, seaLevel, min, max }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
