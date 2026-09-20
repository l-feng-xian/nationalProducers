import { WORLD_SIZE } from '../core/constants'
import { wrapTile } from '../core/torus'
import { hashInt } from './rng'
import type {
  BuildingKind,
  FarmBed,
  SettlementParams,
  Town,
  TownBoundary,
  TownBuilding,
  TownLot,
} from './settlement'

/** Street-first JRPG blocks. Work in local coordinates until committing to the torus. */
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
  const idx = (x: number, y: number) => wrapTile(cy + y) * WORLD_SIZE + wrapTile(cx + x)
  const streets = new Set<number>(),
    occupied = new Set<number>()
  const paths: number[] = [],
    plaza: number[] = [],
    gates: number[] = [],
    fields: number[] = []
  const lots: TownLot[] = [],
    beds: FarmBed[] = [],
    boundaries: TownBoundary[] = []
  const buildings: TownBuilding[] = [
    { x: cx, y: cy, w: 1, h: 1, facing: 1, storeys: 1, kind: 'well' },
  ]
  const dry = (x: number, y: number) => isDry(cx + x, cy + y)
  const addPath = (x: number, y: number) => {
    const i = idx(x, y)
    if (streets.has(i)) return
    streets.add(i)
    paths.push(wrapTile(cx + x), wrapTile(cy + y))
  }
  for (let y = -2; y <= 2; y++)
    for (let x = -3; x <= 3; x++) {
      if ((Math.abs(x) === 3 && Math.abs(y) === 2) || !dry(x, y)) continue
      plaza.push(wrapTile(cx + x), wrapTile(cy + y))
      streets.add(idx(x, y))
    }
  occupied.add(idx(0, 0))
  // Segments grow from an existing street; wet ground terminates a segment.
  const lane = (x: number, y: number, dx: number, dy: number, length: number, wide = false) => {
    if (!streets.has(idx(x, y))) return
    let reach = 0
    for (let step = 0; step <= length; step++) {
      const xx = x + dx * step,
        yy = y + dy * step
      if (!dry(xx, yy)) break
      addPath(xx, yy)
      if (wide && dry(xx, yy + 1)) addPath(xx, yy + 1)
      reach = step
    }
    if (reach >= 8) gates.push(wrapTile(cx + x + dx * reach), wrapTile(cy + y + dy * reach))
  }
  lane(0, 1, 0, 1, 2)
  lane(0, 3, -1, 0, radius - 1, true)
  lane(0, 3, 1, 0, radius - 1, true)
  lane(-6, 3, 0, -1, radius + 2)
  lane(-6, -5, 1, 0, 15, true)
  lane(-6, -5, -1, 0, 9, true)
  lane(2, 3, 0, -1, 8)
  lane(2, 3, 0, 1, radius - 4)
  lane(2, 12, -1, 0, 17, true)
  lane(2, 12, 1, 0, 11, true)
  lane(-6, 3, 0, 1, 9)

  const boundary = (x: number, y: number, w: number, kind: TownBoundary['kind']) => {
    boundaries.push({ x: wrapTile(cx + x), y: wrapTile(cy + y), w, kind })
  }
  const place = (
    x: number,
    y: number,
    w: number,
    h: number,
    streetY: number,
    kind: BuildingKind,
    farm = false,
  ) => {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) {
        if (
          xx * xx + yy * yy > radius * radius ||
          streets.has(idx(xx, yy)) ||
          occupied.has(idx(xx, yy)) ||
          !dry(xx, yy)
        )
          return
      }
    const bw = farm || kind !== 'house' ? 4 : w - 2
    const bh = 3,
      bx = x + Math.floor((w - bw) / 2)
    const by = farm
      ? y + 1
      : Math.max(y + 1, streetY - 6 - hashInt(base, 2, 'setback', rx, ry, x, y))
    const doorX = bx + Math.floor(bw / 2),
      doorY = by + bh
    for (let yy = by; yy < by + bh; yy++)
      for (let xx = bx; xx < bx + bw; xx++) if (!canBuild(cx + xx, cy + yy)) return
    if (!streets.has(idx(doorX, streetY))) return
    const building = buildings.length
    buildings.push({
      x: wrapTile(cx + bx),
      y: wrapTile(cy + by),
      w: bw,
      h: bh,
      kind,
      facing: 1,
      storeys: kind === 'shop' || kind === 'inn' ? 2 : 1,
      door: [wrapTile(cx + doorX), wrapTile(cy + doorY)],
    })
    lots.push({
      x: wrapTile(cx + x),
      y: wrapTile(cy + y),
      w,
      h,
      building,
      streetY: wrapTile(cy + streetY),
    })
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) occupied.add(idx(xx, yy))
    for (let yy = doorY; yy < streetY; yy++) addPath(doorX, yy)
    // Two-cell open gate, short front fence and a hedge at the back of the parcel.
    if (doorX > x) boundary(x, y + h - 1, doorX - x, 'fence')
    if (doorX + 2 < x + w) boundary(doorX + 2, y + h - 1, x + w - doorX - 2, 'fence')
    boundary(x, y, w, 'hedge')
    for (let yy = y + 2; yy < y + h - 2; yy += 2) {
      boundary(x, yy, 1, 'hedge')
      boundary(x + w - 1, yy, 1, 'hedge')
    }
    if (farm && p.fieldDensity > 0) {
      const height = 3 + Math.round(p.fieldDensity * 4)
      // Beds flank the barn-to-gate lane; the lane itself is never planted.
      for (const [fx, crop] of [
        [x + 1, 'cabbage'],
        [doorX + 1, 'wheat'],
      ] as const) {
        const fw = fx < doorX ? doorX - fx : x + w - 1 - fx
        if (fw < 2) continue
        const fy = streetY - height - 2
        beds.push({ x: wrapTile(cx + fx), y: wrapTile(cy + fy), w: fw, h: height, crop })
        for (let yy = fy; yy < fy + height; yy++)
          for (let xx = fx; xx < fx + fw; xx++) fields.push(wrapTile(cx + xx), wrapTile(cy + yy))
      }
    }
  }
  place(-5, -13, 6, 8, -5, 'shop')
  place(3, -13, 6, 8, -5, 'inn')
  place(-14, -3, 7, 6, 3, 'house')
  place(3, -3, 6, 6, 3, 'house')
  place(-14, 5, 7, 7, 12, 'house')
  place(-5, 5, 6, 7, 12, 'house')
  place(3, 5, 6, 7, 12, 'house')
  place(10, -12, 9, 15, 3, 'barn', true)
  place(-14, -13, 7, 8, -5, 'house')
  if (!buildings.some((b) => b.kind === 'shop' || b.kind === 'inn')) {
    const publicHome = buildings.find((b) => b.kind === 'house')
    if (publicHome) {
      publicHome.kind = 'shop'
      publicHome.storeys = 2
    }
  }
  return {
    cx,
    cy,
    radius,
    plaza: Int32Array.from(plaza),
    paths: Int32Array.from(paths),
    gates: Int32Array.from(gates),
    fields: Int32Array.from(fields),
    buildings,
    lots,
    beds,
    boundaries,
  }
}
