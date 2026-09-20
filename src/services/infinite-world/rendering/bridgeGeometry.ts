/** Exact rectangles: bent bridges must not paint planks over non-walkable water. */
import { delta, wrap } from '../core/torus'
import type { WorldGrid } from '../generation/grid'
export function bridgeDecks(grid: WorldGrid) {
  return grid.bridges.flatMap((bridge) => {
    if (bridge.cells.length < 2) return []
    const x0 = bridge.cells[0]!,
      y0 = bridge.cells[1]!
    const cells = new Set<string>()
    for (let k = 0; k < bridge.cells.length; k += 2) {
      cells.add(`${delta(x0, bridge.cells[k]!)},${delta(y0, bridge.cells[k + 1]!)}`)
    }
    const decks = []
    while (cells.size) {
      const [x, y] = [...cells]
        .map((k) => k.split(',').map(Number) as [number, number])
        .sort((a, b) => a[1] - b[1] || a[0] - b[0])[0]!
      let w = 1,
        h = 1
      while (cells.has(`${x + w},${y}`)) w++
      while (Array.from({ length: w }, (_, k) => cells.has(`${x + k},${y + h}`)).every(Boolean)) h++
      for (let yy = 0; yy < h; yy++)
        for (let xx = 0; xx < w; xx++) cells.delete(`${x + xx},${y + yy}`)
      decks.push({ x: wrap(x0 + x + w / 2), y: wrap(y0 + y + h / 2), w, h, horizontal: w >= h })
    }
    return decks
  })
}
