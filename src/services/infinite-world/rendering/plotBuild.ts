import { CHUNK, WORLD_SIZE } from '../core/constants'
import { delta, wrapTile } from '../core/torus'
import { Decor, gridIndex, type WorldGrid } from '../generation/grid'
import { hashTile01 } from '../generation/rng'
import { cropPlants, farmBeds } from './farmCrops'
import { bridgeDecks } from './bridgeGeometry'
import { pavingDistance } from '../generation/referenceTown'

export type PlotKind =
  | 'yard'
  | 'bed'
  | 'shadow'
  | 'shadow-canopy'
  | 'shadow-building'
  | 'stone'
  | 'step'
  | 'bridge-x'
  | 'bridge-y'
export interface PlotInstances {
  kind: PlotKind
  center: Float32Array
  size: Float32Array
  angle: Float32Array
  count: number
}

/** Ground details have their own footprints; none are baked into the billboard image. */
export function buildPlots(grid: WorldGrid, cx: number, cy: number): PlotInstances[] {
  const groups = new Map<PlotKind, { center: number[]; size: number[]; angle: number[] }>()
  const add = (kind: PlotKind, x: number, y: number, w: number, h: number, angle = 0) => {
    x = ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
    y = ((y % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE
    if (Math.floor(x / CHUNK) !== cx || Math.floor(y / CHUNK) !== cy) return
    let group = groups.get(kind)
    if (!group) {
      group = { center: [], size: [], angle: [] }
      groups.set(kind, group)
    }
    group.center.push(x, y)
    group.size.push(w, h)
    group.angle.push(angle)
  }
  for (const town of grid.towns) {
    for (const r of town.paving ?? []) {
      const covered = (x: number, y: number) =>
        (town.paving ?? []).some((p) => pavingDistance(p, x, y) > 0.02)
      if (r.angle) {
        const c = Math.cos(r.angle),
          s = Math.sin(r.angle)
        for (let x = -r.w / 2 + 0.18; x < r.w / 2; x += 0.38)
          for (const side of [-1, 1]) {
            const y = (side * r.h) / 2,
              wx = r.x + r.w / 2 + x * c - y * s,
              wy = r.y + r.h / 2 + x * s + y * c
            if (!covered(wx - side * s * 0.12, wy + side * c * 0.12))
              add('stone', wx, wy, 0.36, 0.2, r.angle)
          }
        continue
      }
      for (let x = 0.18; x < r.w; x += 0.42) {
        if (!covered(r.x + x, r.y - 0.12)) add('stone', r.x + x, r.y, 0.4, 0.2)
        if (!covered(r.x + x, r.y + r.h + 0.12)) add('stone', r.x + x, r.y + r.h, 0.4, 0.2)
      }
      for (let y = 0.18; y < r.h; y += 0.42) {
        if (!covered(r.x - 0.12, r.y + y)) add('stone', r.x, r.y + y, 0.2, 0.4)
        if (!covered(r.x + r.w + 0.12, r.y + y)) add('stone', r.x + r.w, r.y + y, 0.2, 0.4)
      }
    }
    for (const b of town.buildings) {
      add('shadow', b.x + b.w / 2 + 0.12, b.y + b.h - 0.45, b.w + 0.65, 0.95)
    }
    for (const lot of town.lots ?? []) {
      const b = town.buildings[lot.building]!
      // Worn apron around the foundation, feathering out into the maintained lawn.
      add('yard', b.x + b.w / 2, b.y + b.h - 0.2, b.w + 0.5, b.art ? 0.9 : 2.8)
      if (b.door) {
        const length = b.art && b.kind === 'barn' ? 0.8 : delta(b.door[1], lot.streetY)
        for (let step = 0; step <= length; step += b.art ? 0.5 : 1)
          add(
            b.art ? 'step' : 'stone',
            b.door[0] + 0.5 + Math.sin(step * 2.3) * 0.09,
            b.door[1] + step + 0.4,
            b.art ? 0.47 : 0.65,
            b.art ? 0.26 : 0.46,
            b.art ? Math.sin(step * 5.7 + b.x) * 0.12 : 0,
          )
      }
    }
    for (const bed of farmBeds(grid, town)) {
      add('bed', bed.x + bed.w / 2, bed.y + bed.h / 2, bed.w, bed.h)
      for (const crop of cropPlants(bed))
        add('shadow', crop.x + 0.07, crop.y - 0.03, crop.width, 0.32)
    }
    for (const edge of town.boundaries ?? [])
      if (edge.axis === 'y') add('shadow', edge.x + 0.5, edge.y + edge.w / 2, 0.35, edge.w + 0.12)
      else add('shadow', edge.x + edge.w / 2, edge.y + 0.65, edge.w + 0.12, 0.35)
  }
  if (grid.generatorVersion === 'torus-4')
    for (const deck of bridgeDecks(grid)) {
      add(deck.horizontal ? 'bridge-x' : 'bridge-y', deck.x, deck.y, deck.w + 0.1, deck.h)
      add('shadow', deck.x + 0.12, deck.y + 0.32, deck.w + 0.3, deck.h + 0.5)
    }
  if (grid.generatorVersion === 'torus-4') {
    // Only small root contact shadows stay fixed. Solar silhouettes use sprite
    // geometry and the shared light direction; each root has exactly one owner.
    for (let y = cy * CHUNK - 2; y < (cy + 1) * CHUNK + 2; y++)
      for (let x = cx * CHUNK - 2; x < (cx + 1) * CHUNK + 2; x++) {
        const d = grid.decor[gridIndex(x, y)]
        if (d !== Decor.TreeBroad && d !== Decor.TreeConifer && d !== Decor.TreeBirch) continue
        const tx = wrapTile(x),
          ty = wrapTile(y)
        const rootX = tx + 0.5 + (hashTile01(0x2b1f, tx, ty) - 0.5) * 0.44
        const rootY = ty + 0.5 + (hashTile01(0x77c3, tx, ty) - 0.5) * 0.44
        add('shadow', rootX, rootY, 0.65, 0.35)
      }
  }
  return [...groups.entries()].map(([kind, data]) => ({
    kind,
    center: Float32Array.from(data.center),
    size: Float32Array.from(data.size),
    angle: Float32Array.from(data.angle),
    count: data.size.length / 2,
  }))
}
