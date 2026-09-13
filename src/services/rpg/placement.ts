/**
 * 把创建向导里配好的 NPC 名册**落到地图上**。
 *
 * 需求 1：NPC 在地图生成之前就配置好，所以名册项没有坐标（用 x=-1 标记「未落位」，
 * 与 RpgWorld.playerX=-1 同一惯例）。世界生成后，第一次进游戏时按**角色**把每个人
 * 确定性地安顿到合适的地方：村民进村、农夫到田边、游荡者去野外。
 *
 * 确定性：同一个 NPC id + 同一个世界必然落到同一格，靠 id 哈希选村、选点。
 * 这样重进游戏不会有人瞬移，也不依赖运行顺序。
 *
 * 纯 service：不 import vue/pinia。
 */

import { fnv1a } from '@/services/hash'
import { findSpawn, findStandSpot, type World } from './world'
import type { RpgNpc } from '@/types/rpg'

/** 该 NPC 是否还没落到地图上 */
function unplaced(n: RpgNpc): boolean {
  return !(n.x >= 0 && n.y >= 0)
}

/**
 * 给所有「未落位」的名册 NPC 定坐标。就地改 `npc.x/y/homeX/homeY`。
 *
 * @returns 是否动过任何 NPC（调用方据此决定要不要落库）
 */
export function placeRoster(world: World, npcs: RpgNpc[]): boolean {
  const pending = npcs.filter(unplaced)
  if (!pending.length) return false

  const W = world.params.width
  const H = world.params.height
  const villages = world.listVillages()
  // 已经在图上的人也要避开，别叠在一起
  const avoid = npcs.filter((n) => !unplaced(n)).map((n) => ({ x: n.x + 0.5, y: n.y + 0.5 }))

  // 落位顺序按 id 排序，稳定且与数组顺序无关
  const order = [...pending].sort((a, b) => (a.id < b.id ? -1 : 1))

  for (const npc of order) {
    const h = fnv1a(npc.id)
    const role = npc.role ?? 'wanderer'

    // 选一个锚点，再从锚点螺旋找最近的可站格
    let ax: number
    let ay: number
    let maxR = 8
    if (villages.length && role !== 'wanderer') {
      const v = villages[h % villages.length]!
      if (role === 'farmer') {
        // 田在村心东南（Village.fx/fy 是田垄矩形左上角），农夫落田边
        ax = v.fx
        ay = v.fy
        maxR = 10
      } else {
        // 村民 / 守摊人落在村心附近
        ax = v.cx
        ay = v.cy
        maxR = Math.max(6, v.r)
      }
    } else {
      // 游荡者（或世界里根本没村庄）：野外一处哈希点
      ax = (h >>> 3) % W
      ay = (h >>> 15) % H
      maxR = 24
    }

    let spot = findStandSpot(world, ax, ay, { maxR, avoid, minDist: 1.5 })
    // 兜底：锚点周围找不到（比如全是水/道具），退回出生点一带
    if (!spot) {
      const s = findSpawn(world)
      spot = findStandSpot(world, s.x, s.y, { maxR: 40, avoid, minDist: 1 }) ?? s
    }

    npc.x = spot.x
    npc.y = spot.y
    npc.homeX = spot.x
    npc.homeY = spot.y
    avoid.push({ x: spot.x + 0.5, y: spot.y + 0.5 })
  }
  return true
}
