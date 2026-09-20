/** Compact reference-derived blocks. All circulation is reserved before placing parcels. */
import { WORLD_SIZE } from '../core/constants'
import { delta, wrap, wrapTile } from '../core/torus'
import { BUILDING_DOOR_X } from './buildingArt'
import type {
  Town,
  SettlementParams,
  BuildingKind,
  TownBuilding,
  TownLot,
  FarmBed,
  TownBoundary,
} from './settlement'

export interface TownProp {
  x: number
  y: number
  frame: string
  width: number
}
export interface TownPaving {
  x: number
  y: number
  w: number
  h: number
  angle?: number
}

export function pavingDistance(p: TownPaving, x: number, y: number): number {
  const dx = delta(p.x + p.w / 2, x),
    dy = delta(p.y + p.h / 2, y),
    c = Math.cos(p.angle ?? 0),
    s = Math.sin(p.angle ?? 0)
  const qx = Math.abs(dx * c + dy * s) - p.w / 2 + 0.08,
    qy = Math.abs(-dx * s + dy * c) - p.h / 2 + 0.08
  return -(Math.hypot(Math.max(0, qx), Math.max(0, qy)) + Math.min(0, Math.max(qx, qy)) - 0.08)
}

export function buildReferenceTown(
  _base: number,
  _rx: number,
  _ry: number,
  cx: number,
  cy: number,
  radius: number,
  p: SettlementParams,
  isDry: (x: number, y: number) => boolean,
  canBuild: (x: number, y: number) => boolean,
): Omit<Town, 'id' | 'name'> {
  const idx = (x: number, y: number) => wrapTile(cy + y) * WORLD_SIZE + wrapTile(cx + x)
  const dry = (x: number, y: number) => isDry(cx + x, cy + y)
  const paths = new Set<number>(),
    plaza = new Set<number>(),
    occupied = new Set<number>()
  const buildings: TownBuilding[] = [
    { x: cx, y: cy, w: 1, h: 1, kind: 'well', facing: 1, storeys: 1, art: 'well' },
  ]
  const lots: TownLot[] = [],
    beds: FarmBed[] = [],
    boundaries: TownBoundary[] = [],
    props: TownProp[] = [],
    paving: TownPaving[] = []
  const xy = (x: number, y: number): [number, number] => [wrapTile(cx + x), wrapTile(cy + y)]
  const prop = (x: number, y: number, frame: string, width: number) => {
    props.push({ x: wrap(cx + x), y: wrap(cy + y), frame, width })
  }
  const rect = (x: number, y: number, w: number, h: number, stone = false, draw = true) => {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) if (dry(xx, yy)) (stone ? plaza : paths).add(idx(xx, yy))
    if (stone && draw) {
      const [xx, yy] = xy(x, y)
      paving.push({ x: xx, y: yy, w, h })
    }
  }
  rect(-3, -2, 6, 4, true)
  rect(-8, 2, 12, 1, true)
  rect(-4, -2, 10, 1)
  rect(-4, -2, 1, 5)
  rect(3, -2, 1, 6)
  rect(0, 3, 1, 8)
  rect(-7, 8, 18, 1)
  rect(6, 4, 5, 1)
  rect(10, -2, 1, 7)
  rect(4, -9, 1, 8)
  rect(4, -2, 10, 1)
  rect(-12, 4, 5, 1, true, false)
  rect(-9, 2, 2, 3, true, false)
  paving.push({ x: wrap(cx - 9.8), y: wrap(cy + 2.75), w: 3.6, h: 1.1, angle: -Math.PI / 4 })
  const boundary = (x: number, y: number, w: number, axis: 'x' | 'y' = 'x') => {
    for (let k = 0; k < w; k++) {
      const xx = x + (axis === 'x' ? k : 0),
        yy = y + (axis === 'y' ? k : 0)
      if (!dry(xx, yy) || paths.has(idx(xx, yy)) || plaza.has(idx(xx, yy))) return
    }
    const [xx, yy] = xy(x, y)
    boundaries.push({ x: xx, y: yy, w, kind: 'fence', axis })
  }
  const place = (
    x: number,
    y: number,
    w: number,
    h: number,
    streetY: number,
    kind: BuildingKind,
    art: string,
    front = 1,
  ) => {
    const margin = kind === 'house' ? 1 : 0
    const lx = x - margin,
      ly = y,
      lw = w + margin * 2,
      lh = h + front
    for (let yy = ly; yy < ly + lh; yy++)
      for (let xx = lx; xx < lx + lw; xx++)
        if (
          !dry(xx, yy) ||
          occupied.has(idx(xx, yy)) ||
          paths.has(idx(xx, yy)) ||
          plaza.has(idx(xx, yy))
        )
          return
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) if (!canBuild(cx + xx, cy + yy)) return
    const doorX =
        x + (kind === 'barn' ? Math.floor(w / 2) : Math.floor(w * (BUILDING_DOOR_X[art] ?? 0.5))),
      doorY = y + h
    // An entrance must connect to the reserved street, never through a neighbouring parcel.
    for (let yy = doorY; yy <= streetY; yy++)
      if (!dry(doorX, yy) || occupied.has(idx(doorX, yy))) return
    const building = buildings.length
    const [bx, by] = xy(x, y)
    buildings.push({
      x: bx,
      y: by,
      w,
      h,
      kind,
      art,
      facing: 1,
      storeys: kind === 'shop' || kind === 'inn' ? 2 : 1,
      door: xy(doorX, doorY),
    })
    const [xx, yy] = xy(lx, ly)
    lots.push({ x: xx, y: yy, w: lw, h: lh, building, streetY: wrapTile(cy + streetY) })
    for (let yy = ly; yy < ly + lh; yy++)
      for (let xx = lx; xx < lx + lw; xx++) occupied.add(idx(xx, yy))
    for (let yy = doorY; yy <= streetY; yy++) paths.add(idx(doorX, yy))
    if (kind === 'house') {
      boundary(lx, ly + lh - 1, doorX - lx)
      if (lx + lw > doorX + 2) boundary(doorX + 2, ly + lh - 1, lx + lw - doorX - 2)
      boundary(lx, ly, Math.max(1, lh - 1), 'y')
      boundary(lx + lw - 1, ly, Math.max(1, lh - 1), 'y')
    }
    prop(
      x + 0.15,
      y + h + 0.1,
      kind === 'barn' ? 'barn-supplies' : 'flower-trough',
      kind === 'barn' ? 1.05 : 0.7,
    )
    prop(x + w - 0.15, y + h - 0.05, kind === 'shop' ? 'barn-supplies' : 'shore-flowers', 0.65)
  }
  place(-4, -4, 4, 2, -2, 'shop', 'shop', 0)
  place(0, -4, 4, 2, -2, 'inn', 'inn', 0)
  place(-8, -2, 3, 3, 2, 'house', 'cottage', 1)
  place(5, 0, 3, 3, 4, 'house', 'cottage-blue', 1)
  place(-6, 4, 4, 3, 8, 'house', 'cottage-wide', 1)
  place(2, 4, 3, 3, 8, 'house', 'cottage-gold', 1)
  place(8, -8, 4, 2, -2, 'barn', 'barn', 0)
  if (p.fieldDensity > 0 && buildings.some((b) => b.kind === 'barn')) {
    for (const [x, w, crop] of [
      [6, 2, 'cabbage'],
      [8, 2, 'seedling'],
      [11, 2, 'wheat'],
    ] as const) {
      const y = -6,
        h = 3
      let valid = true
      for (let yy = y; yy < y + h; yy++)
        for (let xx = x; xx < x + w; xx++)
          if (
            !dry(xx, yy) ||
            occupied.has(idx(xx, yy)) ||
            paths.has(idx(xx, yy)) ||
            plaza.has(idx(xx, yy))
          )
            valid = false
      if (!valid) continue
      const [xx, yy] = xy(x, y)
      beds.push({ x: xx, y: yy, w, h, crop, density: 'dense' })
    }
    boundary(5, -7, 4, 'y')
    boundary(13, -7, 4, 'y')
    boundary(5, -3, 4)
    boundary(11, -3, 3)
  }
  for (const [x, y] of [
    [-3.1, -1.6],
    [3, -1.6],
    [3, 1.8],
  ] as const)
    prop(x, y, 'town-lamp', 0.55)
  prop(-2.7, 1.7, 'flower-trough', 0.75)
  const flatten = (set: Set<number>) =>
    Int32Array.from([...set].flatMap((i) => [i % WORLD_SIZE, Math.floor(i / WORLD_SIZE)]))
  const fields: number[] = []
  for (const b of beds)
    for (let y = 0; y < b.h; y++)
      for (let x = 0; x < b.w; x++) fields.push(wrapTile(b.x + x), wrapTile(b.y + y))
  const gates: number[] = []
  // External roads may only use gates in the plaza's connected street component.
  const connected = new Set<number>(),
    queue = [idx(-2, 0)]
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k]!
    if (connected.has(i) || (!paths.has(i) && !plaza.has(i))) continue
    connected.add(i)
    const x = i % WORLD_SIZE,
      y = Math.floor(i / WORLD_SIZE)
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      queue.push(wrapTile(y + dy!) * WORLD_SIZE + wrapTile(x + dx!))
  }
  for (const [x, y] of [
    [-12, 4],
    [4, -9],
    [13, -2],
    [10, 8],
  ] as const)
    if (connected.has(idx(x, y))) gates.push(...xy(x, y))
  return {
    cx,
    cy,
    radius,
    buildings,
    lots,
    beds,
    boundaries,
    props,
    paving,
    plaza: flatten(plaza),
    paths: flatten(paths),
    fields: Int32Array.from(fields),
    gates: Int32Array.from(gates),
  }
}
