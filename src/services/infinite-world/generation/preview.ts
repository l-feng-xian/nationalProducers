import { createNoise2D } from 'simplex-noise'
import type { Biome, GameWorld, TerrainPreview } from '@/types/infiniteWorld'

function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return () => {
    h += h << 13
    h ^= h >>> 7
    h += h << 3
    h ^= h >>> 17
    h += h << 5
    return ((h >>> 0) % 1_000_000) / 1_000_000
  }
}

const BIOME_CODE: Record<Biome, number> = {
  town: 0,
  field: 1,
  wild: 2,
  forest: 3,
  river: 4,
  wetland: 5,
}

export function generateTerrainPreview(world: Pick<GameWorld, 'seed' | 'settings'>, size = 32): TerrainPreview {
  const random = seededRandom(world.seed)
  const noise = createNoise2D(random)
  const moisture = createNoise2D(seededRandom(`${world.seed}:moisture`))
  const biome = new Uint8Array(size * size)
  const heightMap = new Float32Array(size * size)
  const walkable = new Uint8Array(size * size)
  const counts: Record<Biome, number> = { town: 0, field: 0, wild: 0, forest: 0, river: 0, wetland: 0 }
  const center = (size - 1) / 2
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x
      const nx = (x - center) / size
      const ny = (y - center) / size
      const h = noise(nx * 2.8, ny * 2.8) * 0.65 + noise(nx * 7, ny * 7) * 0.25
      const wet = moisture(nx * 3.2 + 11, ny * 3.2 - 4) * 0.5 + 0.5
      heightMap[i] = h
      let kind: Biome
      const townRadius = Math.hypot(nx, ny)
      if (townRadius < 0.19) kind = 'town'
      else if (Math.abs(h) < 0.08 && wet > 0.63) kind = 'river'
      else if (wet > 0.78 && h < 0.1) kind = 'wetland'
      else if (wet > 0.48 && random() < world.settings.forestDensity * 0.7) kind = 'forest'
      else if (random() < world.settings.fieldDensity && h > -0.15) kind = 'field'
      else kind = 'wild'
      biome[i] = BIOME_CODE[kind]
      counts[kind]++
      walkable[i] = kind === 'forest' || kind === 'river' ? 0 : 1
    }
  }
  return { width: size, height: size, biome, heightMap, walkable, counts }
}

export const biomeCode = BIOME_CODE
