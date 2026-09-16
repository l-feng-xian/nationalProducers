import { createNoise2D } from 'simplex-noise'
import { BIOMES, type Biome, type GameWorld, type TerrainPreview } from '@/types/infiniteWorld'
import { generateTerrainPreview as legacyPreview } from './preview'

export const CHUNK_SIZE = 32
export const WORLD_LIMIT = 100_000
export const TERRAIN_COLORS = ['#b99870', '#b3a371', '#899563', '#698273', '#69969f', '#94aaa0']
export interface TerrainTile { biome: Biome; height: number; walkable: boolean; object?: 'tree' | 'house'; bridge: boolean }

function random(seed: string) {
  let state = 2166136261
  for (const c of seed) state = Math.imul(state ^ c.charCodeAt(0), 16777619)
  return () => {
    state += 0x6d2b79f5
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Global-coordinate sampling: visiting chunks in a different order cannot change their content. */
export function createTerrain(world: Pick<GameWorld, 'seed' | 'settings' | 'generatorVersion'>) {
  if (world.generatorVersion === 'dual-grid-0.1') {
    const old = legacyPreview(world)
    return (x: number, y: number): TerrainTile => {
      x = Math.floor(x); y = Math.floor(y)
      const i = y * old.width + x
      if (x < 0 || y < 0 || x >= old.width || y >= old.height) return { biome: 'river', height: 0, walkable: false, bridge: false }
      return { biome: BIOMES[old.biome[i]!]!, height: old.heightMap[i]!, walkable: !!old.walkable[i], bridge: false }
    }
  }
  if (world.generatorVersion !== 'terrain-1') throw new Error('此世界使用了不支持的地图版本，请更新应用后重试。')
  const noise = createNoise2D(random(world.seed))
  const vegetation = createNoise2D(random(`${world.seed}:trees`))
  return (x: number, y: number): TerrainTile => {
    x = Math.floor(x); y = Math.floor(y)
    const h = noise(x / 53, y / 53)
    const riverX = 29 + Math.sin(y / 22) * 3 + noise(0, y / 40) * 2
    const riverDistance = Math.abs(x - riverX)
    const riverWidth = 1 + world.settings.waterRatio * 8
    const bridge = riverDistance <= riverWidth + 1 && Math.abs(y - 16) <= 1
    const town = Math.hypot(x - 16, y - 16) < 7
    const road = Math.abs(y - 16) <= 1
    let biome: Biome = 'wild'
    if (riverDistance < riverWidth) biome = bridge ? 'town' : 'river'
    else if (riverDistance < riverWidth + 1.5) biome = road ? 'town' : 'wetland'
    else if (town || road) biome = 'town'
    else if (x >= 7 && x <= 15 && y >= 23 && y <= 28) biome = 'field'
    else if (h > 0.6 - world.settings.forestDensity * 1.2) biome = 'forest'
    else if (h < -0.65 + world.settings.fieldDensity * 0.65) biome = 'field'
    const house = y === 12 && (x === 13 || x === 19)
    const tree = biome === 'forest' && vegetation(x * 1.7, y * 1.7) > 0.28
    return {
      biome, height: h, bridge,
      walkable: Math.abs(x) <= WORLD_LIMIT && Math.abs(y) <= WORLD_LIMIT && biome !== 'river' && !house && !tree,
      object: house ? 'house' : tree ? 'tree' : undefined,
    }
  }
}

export function generateTerrainPreview(world: Pick<GameWorld, 'seed' | 'settings' | 'generatorVersion'>, size = 32): TerrainPreview {
  const sample = createTerrain(world)
  const biome = new Uint8Array(size * size)
  const heightMap = new Float32Array(size * size)
  const walkable = new Uint8Array(size * size)
  const counts = Object.fromEntries(BIOMES.map((b) => [b, 0])) as Record<Biome, number>
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const tile = sample(x, y), i = y * size + x
    biome[i] = BIOMES.indexOf(tile.biome)
    heightMap[i] = tile.height
    walkable[i] = Number(tile.walkable)
    counts[tile.biome]++
  }
  return { width: size, height: size, biome, heightMap, walkable, counts }
}
