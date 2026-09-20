import type { CharacterDataV2 } from './character'
import type { GroupNodeLayout } from './group'
import type { WorldBook } from './worldinfo'

export type Biome = 'town' | 'field' | 'wild' | 'forest' | 'river' | 'wetland'

export interface WorldRelation {
  id: string
  from: string
  to: string
  label: string
  score: number
  trust: number
  desc: string
}

export interface PlayerIdentity {
  name: string
  identity: string
  description: string
  goal: string
  spawn: [number, number]
}

export interface ScheduleEntry {
  start: number
  end: number
  location: [number, number]
  activity: string
}

export interface NpcBlueprint {
  npcId: string
  sourceCharacterId?: string
  sourceUpdatedAt?: number
  name: string
  profession: string
  home: [number, number]
  work?: [number, number]
  speed: number
  useLlm: boolean
  cardSnapshot?: CharacterDataV2
  avatarBlobId?: string
  schedule: ScheduleEntry[]
}

export interface WorldLore {
  premise: string
  tone: string
  rules: string
  geography: string
  worldBookIds: string[]
  worldBookSnapshots?: WorldBook[]
}

export interface WorldSettings {
  dayMinutes: number
  season: number
  fieldDensity: number
  forestDensity: number
  waterRatio: number
  startChunk: [number, number]
}

export interface GameWorld {
  id: string
  name: string
  seed: string
  generatorVersion: string
  lore: WorldLore
  player: PlayerIdentity
  npcs: NpcBlueprint[]
  relations: WorldRelation[]
  relationLayout: Record<string, GroupNodeLayout>
  settings: WorldSettings
  createdAt: number
  updatedAt: number
}

export interface WorldSave {
  id: string
  worldId: string
  revision: number
  day: number
  minute: number
  weather: 'clear' | 'rain' | 'storm'
  playerPosition: [number, number]
  inventory: Record<string, number>
  stamina: number
  money: number
  relations?: WorldRelation[]
  updatedAt: number
}

export interface WorldChunkDelta {
  saveId: string
  cx: number
  cy: number
  generatorVersion: string
  revision: number
  removedObjectIds: string[]
  changedTiles: { x: number; y: number; biome?: Biome; tilled?: boolean; watered?: boolean }[]
  placedObjects: { id: string; type: string; x: number; y: number }[]
}

export interface WorldNpcState {
  saveId: string
  npcId: string
  position: [number, number]
  state: 'idle' | 'moving' | 'working' | 'talking' | 'waiting' | 'sleeping'
  target?: [number, number]
  scheduleIndex: number
  updatedAt: number
}

export interface WorldEvent {
  saveId: string
  seq: number
  at: number
  type: string
  actorId?: string
  targetId?: string
  payload: Record<string, unknown>
}

export interface TerrainPreview {
  width: number
  height: number
  biome: Uint8Array
  heightMap: Float32Array
  walkable: Uint8Array
  counts: Record<Biome, number>
}

export const BIOMES: readonly Biome[] = ['town', 'field', 'wild', 'forest', 'river', 'wetland']
export const BIOME_LABEL: Record<Biome, string> = {
  town: '城镇',
  field: '田野',
  wild: '野外',
  forest: '森林',
  river: '河流',
  wetland: '湿地',
}

export function emptyWorld(id = crypto.randomUUID()): GameWorld {
  const now = Date.now()
  return {
    id,
    name: '新世界',
    seed: String(Math.floor(Math.random() * 1_000_000_000)),
    // ⚠️ 必须与 pipeline.ts 的 GENERATOR_VERSION 一致。
    // 这里写死字面量而不是 import —— types/ 不该依赖 services/。
    // 改了那边记得改这里，否则新建的世界会被「旧版生成器」拦截逻辑挡住。
    generatorVersion: 'torus-4',
    lore: { premise: '沿着河流来到一座安静的小镇，从一间小屋开始新的田园生活。', tone: '温柔、日常、充满发现', rules: '', geography: '', worldBookIds: [] },
    player: { name: '我', identity: '', description: '', goal: '', spawn: [16, 16] },
    npcs: [],
    relations: [],
    relationLayout: {},
    settings: {
      dayMinutes: 20,
      season: 0,
      fieldDensity: 0.55,
      forestDensity: 0.55,
      waterRatio: 0.18,
      startChunk: [0, 0],
    },
    createdAt: now,
    updatedAt: now,
  }
}

export function emptySave(world: GameWorld): WorldSave {
  return {
    id: crypto.randomUUID(),
    worldId: world.id,
    revision: 0,
    day: 1,
    minute: 7 * 60,
    weather: 'clear',
    playerPosition: [...world.player.spawn],
    inventory: {},
    stamina: 100,
    money: 500,
    relations: world.relations.map((relation) => ({ ...relation })),
    updatedAt: Date.now(),
  }
}
