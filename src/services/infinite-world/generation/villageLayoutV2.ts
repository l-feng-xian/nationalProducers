import { WORLD_SIZE } from '../core/constants'
import { torusDist2, wrapTile } from '../core/torus'
import { hash01, hashInt, hashTile01 } from './rng'
import type { BuildingKind, SettlementParams, Town, TownBuilding } from './settlement'

/** Farm-life village: curved lanes, separated garden plots, visible south-facing entrances. */
export function buildVillage(
  base: number,
  rx: number,
  ry: number,
  cx: number,
  cy: number,
  radius: number,
  p: SettlementParams,
  isDry: (x: number, y: number) => boolean,
  canBuild: (x: number, y: number) => boolean,
): Omit<Town, 'id' | 'name'> {
  const idx = (x: number, y: number) => wrapTile(y) * WORLD_SIZE + wrapTile(x)
  const streets = new Set<number>()
  const occupied = new Set<number>()
  const yards = new Set<number>()
  const plaza: number[] = []
  const paths: number[] = []
  const gates: number[] = []
  const buildings: TownBuilding[] = []
  const fieldCells: number[] = []
  const addPath = (x: number, y: number) => {
    const i = idx(x, y)
    if (!streets.has(i)) {
      streets.add(i)
      paths.push(wrapTile(x), wrapTile(y))
    }
  }
  const halfW = 3.6 + hash01(base, 'green-w', rx, ry) * 0.7
  const halfH = 2.7 + hash01(base, 'green-h', rx, ry) * 0.45
  for (let dy = -4; dy <= 4; dy++)
    for (let dx = -5; dx <= 5; dx++) {
      if ((dx / halfW) ** 2 + (dy / halfH) ** 2 > 1 || !isDry(cx + dx, cy + dy)) continue
      plaza.push(wrapTile(cx + dx), wrapTile(cy + dy))
      streets.add(idx(cx + dx, cy + dy))
    }
  buildings.push({ x: cx, y: cy, w: 1, h: 1, facing: 1, storeys: 1, kind: 'well' })
  occupied.add(idx(cx, cy))

  // Smooth centerlines are rasterized only for navigation; rendering reconstructs curves.
  const tilt = (hash01(base, 'village-angle', rx, ry) - 0.5) * 0.7
  const directions = [tilt, tilt + Math.PI, Math.PI / 2 + tilt * 0.5]
  if (hash01(base, 'fourth-lane', rx, ry) > 0.5) directions.push(-Math.PI / 2 + tilt)
  for (let lane = 0; lane < directions.length; lane++) {
    const angle = directions[lane]!
    const bend = (hash01(base, 'lane-bend', rx, ry, lane) - 0.5) * 4
    let lastX = cx,
      lastY = cy,
      reach = 0
    for (let t = 0; t <= radius + 1; t += 0.25) {
      const drift = Math.sin((t / (radius + 1)) * Math.PI) * bend
      const x = Math.round(cx + Math.cos(angle) * t - Math.sin(angle) * drift)
      const y = Math.round(cy + Math.sin(angle) * t + Math.cos(angle) * drift)
      if (!isDry(x, y)) break
      if (x !== lastX && y !== lastY) {
        if (isDry(x, lastY)) addPath(x, lastY)
        else if (isDry(lastX, y)) addPath(lastX, y)
        else break
      }
      addPath(x, y)
      if (lane < 2 && t > 3 && isDry(x, y + 1)) addPath(x, y + 1)
      lastX = x
      lastY = y
      reach = t
    }
    if (reach >= 5) gates.push(wrapTile(lastX), wrapTile(lastY))
  }

  const connectDoor = (sx: number, sy: number): number[] | null => {
    const start = idx(sx, sy)
    const queue = [start]
    const parent = new Map<number, number>([[start, -1]])
    let head = 0
    while (head < queue.length && head < 400) {
      const i = queue[head++]!,
        x = i % WORLD_SIZE,
        y = Math.floor(i / WORLD_SIZE)
      if (streets.has(i)) {
        const route: number[] = []
        for (let cur = i; cur !== -1; cur = parent.get(cur)!) route.push(cur)
        return route.reverse()
      }
      for (const [dx, dy] of [
        [0, 1],
        [1, 0],
        [-1, 0],
        [0, -1],
      ] as const) {
        const nx = wrapTile(x + dx),
          ny = wrapTile(y + dy),
          ni = idx(nx, ny)
        if (parent.has(ni) || occupied.has(ni) || !isDry(nx, ny) || torusDist2(sx, sy, nx, ny) > 64)
          continue
        parent.set(ni, i)
        queue.push(ni)
      }
    }
    return null
  }
  const candidates: { x: number; y: number; rank: number }[] = []
  for (let dy = -radius + 1; dy < radius; dy += 2)
    for (let dx = -radius + 1; dx < radius; dx += 2) {
      if (dx * dx + dy * dy > (radius - 1) ** 2) continue
      const x = cx + dx,
        y = cy + dy
      candidates.push({ x, y, rank: hashTile01(base ^ 0x713b, x, y) })
    }
  candidates.sort((a, b) => a.rank - b.rank || a.y - b.y || a.x - b.x)
  const target = 6 + hashInt(base, 5, 'home-count', rx, ry)
  for (const candidate of candidates) {
    if (buildings.length - 1 >= target) break
    const { x: x0, y: y0 } = candidate
    // Larger community buildings alternate with compact homes; small plots cannot consume
    // every viable lot before a larger building gets a chance to fit.
    const large = (buildings.length - 1) % 3 === 0
    const w = large ? 4 : 3,
      h = large ? 3 : 2
    let valid = true
    // A garden buffer prevents shared walls and identical rows of roofs.
    for (let yy = -1; yy < h + 2 && valid; yy++)
      for (let xx = -1; xx < w + 1; xx++) {
        const i = idx(x0 + xx, y0 + yy)
        if (occupied.has(i) || yards.has(i)) {
          valid = false
          break
        }
        if (
          xx >= 0 &&
          xx < w &&
          yy >= 0 &&
          yy < h &&
          (streets.has(i) || !isDry(x0 + xx, y0 + yy) || !canBuild(x0 + xx, y0 + yy))
        ) {
          valid = false
          break
        }
      }
    if (!valid) continue
    const doorX = wrapTile(x0 + Math.floor(w / 2)),
      doorY = wrapTile(y0 + h)
    if (!isDry(doorX, doorY) || streets.has(idx(doorX, doorY))) continue
    const footprint: number[] = []
    for (let yy = 0; yy < h; yy++)
      for (let xx = 0; xx < w; xx++) {
        const i = idx(x0 + xx, y0 + yy)
        occupied.add(i)
        footprint.push(i)
      }
    const route = connectDoor(doorX, doorY)
    if (!route) {
      for (const i of footprint) occupied.delete(i)
      continue
    }
    for (let yy = -1; yy < h + 2; yy++)
      for (let xx = -1; xx < w + 1; xx++) yards.add(idx(x0 + xx, y0 + yy))
    for (const i of route) addPath(i % WORLD_SIZE, Math.floor(i / WORLD_SIZE))
    const ordinal = buildings.length - 1
    const kind: BuildingKind =
      ordinal === 0 ? 'shop' : ordinal === 1 ? 'barn' : ordinal === 2 ? 'inn' : 'house'
    const storeys: 1 | 2 = kind === 'shop' || kind === 'inn' ? 2 : 1
    buildings.push({
      x: wrapTile(x0),
      y: wrapTile(y0),
      w,
      h,
      facing: 1,
      storeys,
      kind,
      door: [doorX, doorY],
    })
  }
  // Vegetable gardens live beside homes, with a lawn gap and no overlap with paths.
  for (const b of buildings) {
    if (b.kind === 'well' || fieldCells.length / 2 >= 24 + p.fieldDensity * 32) continue
    const fw = 3,
      fh = 2 + hashInt(base, 2, 'garden', b.x, b.y)
    const x0 = b.x + b.w + 2,
      y0 = b.y + 1
    let valid = true
    for (let yy = 0; yy < fh; yy++)
      for (let xx = 0; xx < fw; xx++) {
        const x = x0 + xx,
          y = y0 + yy,
          i = idx(x, y)
        if (occupied.has(i) || yards.has(i) || streets.has(i) || !isDry(x, y) || !canBuild(x, y))
          valid = false
      }
    if (!valid) continue
    for (let yy = 0; yy < fh; yy++)
      for (let xx = 0; xx < fw; xx++) {
        fieldCells.push(wrapTile(x0 + xx), wrapTile(y0 + yy))
        yards.add(idx(x0 + xx, y0 + yy))
      }
  }
  return {
    cx,
    cy,
    radius,
    plaza: Int32Array.from(plaza),
    paths: Int32Array.from(paths),
    buildings,
    fields: Int32Array.from(fieldCells),
    gates: Int32Array.from(gates),
  }
}
