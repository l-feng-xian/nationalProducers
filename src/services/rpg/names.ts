/**
 * 地名。
 *
 * 纯函数：只吃「世界种子 + 区域键」两个整数，**不落库** —— 同一个世界在任何设备、
 * 任何时候算出的名字都一样，存下来反而变成第二个真相源，迟早与地形对不上。
 *
 * ⚠️ 中间那个字按**当地地貌**选表，不是纯哈希：湖边的村子叫「塘/湾」、林子里叫
 * 「松/林」，名字才像是长在那儿的，而不是随机贴上去的标签。这两个采样（湿度、
 * 台阶）在定村心时本来就算过了，等于白捡。
 *
 * 纯 service：不 import three / vue / pinia。
 */

import { hashTile } from '@/services/hash'

/** 姓氏/前缀字。20 个 */
const SURNAME = [
  '青',
  '白',
  '柳',
  '石',
  '杏',
  '梅',
  '桑',
  '溪',
  '枫',
  '松',
  '竹',
  '芦',
  '麦',
  '稻',
  '桃',
  '李',
  '榆',
  '槐',
  '荷',
  '苇',
]

/** 村落后缀。7 个 */
const VILLAGE_SUFFIX = ['村', '庄', '屯', '寨', '坞', '铺', '集']

/**
 * 野地后缀，**按地貌分表**。
 *
 * ⚠️ 不能只用一张通用表：那样会随机生成「枫原林」这种自相矛盾的名字 ——
 * 中间的「原」说是平地、结尾的「林」又说是树林。后缀必须跟着地貌走。
 */
const WILD_SUFFIX: Record<TerrainClass, readonly string[]> = {
  water: ['泽', '泊', '渚', '汀'],
  forest: ['林', '樾', '木', '丛'],
  hill: ['岭', '岗', '峦', '坂'],
  plain: ['原', '野', '甸', '畈'],
}

/** 地貌特征字，按当地环境选表 */
const FEATURE_WATER = ['塘', '湾', '渡', '浦', '溪', '荷']
const FEATURE_FOREST = ['林', '松', '竹', '樾', '荫', '木']
const FEATURE_HILL = ['岗', '坡', '岭', '台', '垣', '石']
const FEATURE_PLAIN = ['田', '原', '川', '垄', '禾', '阡']

/** 当地地貌分类，决定用哪张特征字表 */
export type TerrainClass = 'water' | 'forest' | 'hill' | 'plain'

const FEATURES: Record<TerrainClass, readonly string[]> = {
  water: FEATURE_WATER,
  forest: FEATURE_FOREST,
  hill: FEATURE_HILL,
  plain: FEATURE_PLAIN,
}

/** 命名用的哈希盐。与地形用的盐分开，免得改名字顺带动了地形 */
const NAME_SALT = 0x5eed0a11

const pick = <T>(arr: readonly T[], n: number): T => arr[n % arr.length] as T

/**
 * 一个村子的名字，如「青柳村」。
 *
 * 取哈希的三段互不重叠的位切片当索引 —— 20 × 6 × 7 = 840 种组合，
 * 而 256² 的世界最多 121 个区域，绰绰有余。跨区域重名无害，
 * 现实里同名的村子本来就到处都是。
 */
export function villageName(seed: number, rx: number, ry: number, cls: TerrainClass): string {
  const h = hashTile(seed ^ NAME_SALT, rx, ry)
  return (
    pick(SURNAME, h & 0x1f) +
    pick(FEATURES[cls], (h >>> 8) & 0x7) +
    pick(VILLAGE_SUFFIX, (h >>> 16) & 0x7)
  )
}

/**
 * 一片野地的名字，如「苍梧林」。
 *
 * 用比村庄粗得多的网格（见 WILD_REGION）：荒野的「一片」本来就该比村子的辖区大，
 * 每走两步就换个地名反而出戏。
 */
export function wildName(seed: number, gx: number, gy: number, cls: TerrainClass): string {
  const h = hashTile(seed ^ (NAME_SALT + 1), gx, gy)
  const feature = pick(FEATURES[cls], (h >>> 11) & 0x7)
  const bank = WILD_SUFFIX[cls]
  let si = (h >>> 19) & 0x7
  // ⚠️ 特征字与后缀表在几处是重叠的（林/樾/木、岭/岗、原），撞上就会生成
  // 「枫原原」「梅林林」这种叠字。顺延一位即可 —— 比手工去重两张表更稳，
  // 以后往表里加字也不会悄悄把这个坑埋回来
  if (pick(bank, si) === feature) si += 1
  return pick(SURNAME, (h >>> 3) & 0x1f) + feature + pick(bank, si)
}

/** 野地命名的网格边长（格）。比村庄的区域(24)粗一倍多 */
export const WILD_REGION = 56
