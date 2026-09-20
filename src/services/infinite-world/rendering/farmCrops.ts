/** Shared crop placement for sprites and their contact shadows. */
import { hashTile01 } from '../generation/rng'
import type { FarmBed, Town } from '../generation/settlement'
import { delta, wrapTile } from '../core/torus'
import { Flag, gridIndex, type WorldGrid } from '../generation/grid'

/** Old saves keep their cell topology; derive visual beds without changing saved generation. */
export function farmBeds(grid: WorldGrid, town: Town): FarmBed[] {
  if (town.beds) return town.beds
  const cells = new Set<string>()
  for (let k = 0; k < town.fields.length; k += 2) {
    const x = town.fields[k]!,
      y = town.fields[k + 1]!
    if (grid.flags[gridIndex(x, y)]! & Flag.Farmland)
      cells.add(`${delta(town.cx, x)},${delta(town.cy, y)}`)
  }
  const beds: FarmBed[] = []
  while (cells.size) {
    const [x, y] = [...cells]
      .map((k) => k.split(',').map(Number) as [number, number])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0])[0]!
    let w = 1,
      h = 1
    while (cells.has(`${x + w},${y}`)) w++
    while (Array.from({ length: w }, (_, i) => cells.has(`${x + i},${y + h}`)).every(Boolean)) h++
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) cells.delete(`${xx},${yy}`)
    beds.push({
      x: wrapTile(town.cx + x),
      y: wrapTile(town.cy + y),
      w,
      h,
      crop: beds.length % 2 ? 'wheat' : 'cabbage',
    })
  }
  return beds
}

export interface CropPlant {
  x: number
  y: number
  name: string
  height: number
  width: number
}
export function cropPlants(bed: FarmBed): CropPlant[] {
  const result: CropPlant[] = []
  if (bed.density === 'dense') {
    const spacing = bed.crop === 'wheat' ? 0.25 : 0.44
    const cols = Math.max(1, Math.floor((bed.w - 0.24) / spacing))
    const rows = Math.max(1, Math.floor((bed.h - 0.18) / spacing))
    for (let row = 0; row < rows; row++)
      for (let col = 0; col < cols; col++) {
        const j = hashTile01(0x51d3, Math.round(bed.x * 7) + col, Math.round(bed.y * 7) + row)
        result.push({
          x: bed.x + 0.15 + ((col + 0.5) * (bed.w - 0.3)) / cols,
          y: bed.y + 0.13 + ((row + 0.65) * (bed.h - 0.32)) / rows + (j - 0.5) * 0.045,
          name: `crop-${bed.crop}`,
          width: bed.crop === 'wheat' ? 0.3 : 0.37,
          height:
            (bed.crop === 'wheat' ? 0.61 : bed.crop === 'seedling' ? 0.38 : 0.35) *
            (0.88 + j * 0.23),
        })
      }
    return result
  }
  for (let row = 0; row < bed.h; row++)
    for (let col = 0; col < bed.w; col++) {
      const jitter = hashTile01(0x51d3, bed.x + col, bed.y + row)
      const crop = bed.crop === 'cabbage' && row >= bed.h - 2 ? 'seedling' : bed.crop
      result.push({
        x: bed.x + col + 0.5,
        y: bed.y + row + 0.65 + (jitter - 0.5) * 0.12,
        name: `crop-${crop}`,
        width: crop === 'wheat' ? 0.55 : 0.64,
        height:
          (crop === 'wheat' ? 1.12 : crop === 'beans' ? 1.25 : crop === 'seedling' ? 0.66 : 0.66) *
          (0.9 + jitter * 0.2),
      })
    }
  return result
}
