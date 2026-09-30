# 数据层与整体架构（IndexedDB schema / TS 类型 / 仓储层 / Pinia 划分 / 路由 / provider 层 / 目录结构）

# 数据层与整体架构设计（nationalProducers）

## 0. 架构总览与四条硬边界

```
views/components (Vue SFC)   只读 store 的 state/getter，只调 store action，永不 import repositories
        │
stores/ (Pinia setup)        settings / characters / worlds / groups / chats / generation / ui
        │                    职责：响应式状态、编排、乐观更新、防抖落盘。不含算法、不含 IDB API
   ┌────┴────┐
services/    db/repositories/
(纯 TS)      (纯 TS)
             db/schema.ts (IDB)
```

Review 时按此四条卡：
1. `services/**` 与 `db/**` **禁止** import vue / pinia（保证可在 Worker 与单测中运行）。
2. `stores/**` **禁止**直接 `indexedDB.*`，一律走 repository。
3. `components/**`、`views/**` **禁止** import `db/**`。
4. `types/**` 只放 `interface` / `type` / `const … as const` / 纯 factory。

---

## 1. IndexedDB Schema

### 1.1 选型：用 `idb`（1.3 kB gz），不用 Dexie

| | 裸 IDB | **idb（选它）** | Dexie |
|---|---|---|---|
| 体积 | 0 | ~1.3 kB gz | ~24 kB gz |
| TS | `IDBRequest<any>`，配 `noUncheckedIndexedAccess` 极难写 | `DBSchema` 泛型，store/index/key/value 全类型化 | 有类型但要写 `stores()` 字符串 DSL |
| 事务自动提交陷阱 | 自己踩 | 文档化，`tx.done` 语义清晰 | 框架托管 |
| 响应式 | 无 | 无 | liveQuery |

**不选 Dexie 的关键原因不是体积，是响应式来源唯一性**：已用 Pinia 做响应式层，再引入 `liveQuery` 会出现「store 里的 messages 数组」与「liveQuery 推来的 messages」两个真相源，流式写入时必然打架。而 Dexie 的查询 DSL 对本项目没价值——查询模式只有三种：主键 `get`、复合键区间 `getAll(IDBKeyRange.bound(...))`、单个 `updatedAt` 索引倒序游标，裸 keyRange 完全够用。

**不选裸 IDB 的原因**：事务在 `await` 非 IDB 请求时会静默自动提交，自研包装踩坑概率接近 100%。

> 若"不许加任何依赖"：写 `src/db/idb.ts`（~130 行），API 形状照抄 idb，实现照抄 `D:/tauriApp/sillyTavernTauri/src/services/platform/storage.web.ts` 的 `tx()` 模式。
> **铁律（无论哪种）**：一个 IDB 事务内只能 await IDB 请求。禁止在事务里 await fetch / await repo / await 任何非 IDB Promise。

安装：`npm i idb`

### 1.2 对象仓库划分（DB 名 `np-chat`，`DB_VERSION = 1`）

| store | keyPath | 索引 | 说明 |
|---|---|---|---|
| `settings` | `'id'` | — | 单条 `id:'app'`。全局配置、双模式约束提示词、WI 全局设置、persona、provider（**不含 key**） |
| `secrets` | `'ref'` | — | `{ref,value}`。API Key 独立存：导出设置天然不泄漏；后续加 AES-GCM 只改一个文件 |
| `characters` | `'id'` | `by_updatedAt` · `by_name`(data.name) · `by_fav`(favIdx) | 角色卡，**不含图片二进制** |
| `worldbooks` | `'id'` | `by_updatedAt` · `by_name` | 全局本/角色本/会话本共用一个 store，靠引用关系区分 |
| `groups` | `'id'` | `by_updatedAt` | 含 relations 关系图谱 |
| `chats` | `'id'` | `by_updatedAt` · `by_characterId` · `by_groupId` | ChatMeta，**不含消息** |
| `messages` | `['chatId','seq']` | `by_msgId`(`['chatId','id']`) | 复合主键天然按 chatId 聚簇 + seq 有序 |
| `blobs` | `'id'` | — | `{id,mime,size,data:Blob,createdAt}` |

**消息 key 用 `[chatId, seq]` 的四个理由**：
- 追加 O(1)：seq 由 `ChatMeta.nextSeq` 在**同一事务**内取号自增，不需游标查 max。
- 按 chatId 高效取全量：`IDBKeyRange.bound([chatId], [chatId, []])`。IDB 键序为 `number < date < string < binary < array`，所以 `[chatId, 任意数字] < [chatId, []]`；而长度 1 的 `[chatId]` 作为前缀排在所有 `[chatId, x]` 之前。这是规范写法。
- 删尾 N：同 range 上 `direction:'prev'` 游标 delete N 次。
- 删整会话：`store.delete(range)` 一次调用。
- **绝不 read-modify-write 整个 JSONL**（`storage.web.ts` 的 `appendText` 就是 RMW，非原子，流式写会丢数据）。

**头像单独 `blobs` store 的理由**：角色列表要 `getAll(characters)`，内嵌二进制会把几十 MB 拉进内存和 Pinia。存 `Blob` 而非 dataURL：省 33% 体积、无巨型字符串、structuredClone 更快。

### 1.3 `src/db/schema.ts` 骨架

```ts
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Character } from '@/types/character'
import type { WorldBook } from '@/types/worldinfo'
import type { Group } from '@/types/group'
import type { ChatMeta, ChatMessage } from '@/types/chat'
import type { Settings } from '@/types/settings'

export const DB_NAME = 'np-chat'
export const DB_VERSION = 1

export interface BlobRecord { id: string; mime: string; size: number; data: Blob; createdAt: number }
export interface SecretRecord { ref: string; value: string }

export interface NpDB extends DBSchema {
  settings: { key: string; value: Settings }
  secrets: { key: string; value: SecretRecord }
  characters: { key: string; value: Character; indexes: { by_updatedAt: number; by_name: string; by_fav: number } }
  worldbooks: { key: string; value: WorldBook; indexes: { by_updatedAt: number; by_name: string } }
  groups: { key: string; value: Group; indexes: { by_updatedAt: number } }
  chats: { key: string; value: ChatMeta; indexes: { by_updatedAt: number; by_characterId: string; by_groupId: string } }
  messages: { key: [string, number]; value: ChatMessage; indexes: { by_msgId: [string, string] } }
  blobs: { key: string; value: BlobRecord }
}

let dbPromise: Promise<IDBPDatabase<NpDB>> | null = null

export function getDb(): Promise<IDBPDatabase<NpDB>> {
  if (dbPromise) return dbPromise
  dbPromise = openDB<NpDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      // 迁移阶梯：加版本只追加 if 块，永不改动已发布的块
      if (oldVersion < 1) {
        db.createObjectStore('settings', { keyPath: 'id' })
        db.createObjectStore('secrets', { keyPath: 'ref' })

        const chars = db.createObjectStore('characters', { keyPath: 'id' })
        chars.createIndex('by_updatedAt', 'updatedAt')
        chars.createIndex('by_name', 'data.name')
        chars.createIndex('by_fav', 'favIdx') // IDB 不索引 boolean，故冗余 0|1

        const worlds = db.createObjectStore('worldbooks', { keyPath: 'id' })
        worlds.createIndex('by_updatedAt', 'updatedAt')
        worlds.createIndex('by_name', 'name') // 不加 unique，重名由 UI 提示

        const groups = db.createObjectStore('groups', { keyPath: 'id' })
        groups.createIndex('by_updatedAt', 'updatedAt')

        const chats = db.createObjectStore('chats', { keyPath: 'id' })
        chats.createIndex('by_updatedAt', 'updatedAt')
        chats.createIndex('by_characterId', 'characterId')
        chats.createIndex('by_groupId', 'groupId')

        const msgs = db.createObjectStore('messages', { keyPath: ['chatId', 'seq'] })
        msgs.createIndex('by_msgId', ['chatId', 'id'])

        db.createObjectStore('blobs', { keyPath: 'id' })
      }
      // if (oldVersion < 2) { ... }
    },
    blocked() { console.warn('[db] 另一个标签页占用了旧版本数据库') },
    blocking() { dbPromise = null },
  })
  return dbPromise
}

/** 一个 chat 的全部消息主键区间 */
export function chatRange(chatId: string): IDBKeyRange {
  return IDBKeyRange.bound([chatId], [chatId, []])
}
```

### 1.4 两层版本迁移

| 层 | 触发 | 位置 | 用途 |
|---|---|---|---|
| **结构层** `DB_VERSION` | 增删 store/index | `schema.ts::upgrade` 的 `if (oldVersion < N)` 阶梯 | 只做结构变更，**不做数据重写**（upgrade 事务里遍历几万条消息会卡死首屏） |
| **数据层** `Settings.schemaVersion` | 字段语义变更、默认值补齐 | `db/migrations.ts::runDataMigrations()`，在 `bootstrap()` 里 await | 惰性、可分批、可显进度 |

```ts
export const DATA_SCHEMA_VERSION = 1
type Migration = { to: number; run: (db: IDBPDatabase<NpDB>) => Promise<void> }
const MIGRATIONS: Migration[] = [ /* { to: 2, run: async (db) => {...} } */ ]

export async function runDataMigrations(): Promise<void> {
  const db = await getDb()
  const s = await db.get('settings', 'app')
  let from = s?.schemaVersion ?? 0
  for (const m of MIGRATIONS) { if (m.to <= from) continue; await m.run(db); from = m.to }
  if (s && from !== s.schemaVersion) await db.put('settings', { ...s, schemaVersion: from })
}
```

导入 ST 社区资产走 `services/io/normalize.ts` 的**字段补齐**（对应 ST 的 `addMissingWorldInfoFields`），不占用 migration。

---

## 2. TS 类型（ST 原生字段名）

数值枚举一律 `as const` 对象 + 派生 union，**不用 `enum`**（isolatedModules 友好；数值必须与 ST 完全一致才能零转换互导）。

### 2.1 `src/types/worldinfo.ts`

```ts
export const world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const
export type WorldInfoLogic = (typeof world_info_logic)[keyof typeof world_info_logic]

export const world_info_position = {
  before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7,
} as const
export type WorldInfoPosition = (typeof world_info_position)[keyof typeof world_info_position]

export const wi_anchor_position = { before: 0, after: 1 } as const
export const scan_state = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 } as const
export const world_info_insertion_strategy = { evenly: 0, character_first: 1, global_first: 2 } as const
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const
export type ExtensionPromptRole = 0 | 1 | 2

export const GENERATION_TYPE_TRIGGERS =
  ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'] as const
export type GenerationTrigger = (typeof GENERATION_TYPE_TRIGGERS)[number]

export const DEFAULT_DEPTH = 4
export const DEFAULT_WEIGHT = 100
export const MAX_SCAN_DEPTH = 1000
export const MAX_UID = 1_000_000
export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'] as const

export interface CharacterFilter { isExclude: boolean; names: string[]; tags: string[] }

/** 与 ST newWorldInfoEntryDefinition 一一对应。
 *  null 三态语义必须保留：null = 继承全局，不等于 false/0。 */
export interface WorldInfoEntry {
  uid: number
  key: string[]                        // 明文或 /regex/flags
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  vectorized: boolean
  selective: boolean                   // 死字段，只做往返兼容，永不分支
  selectiveLogic: WorldInfoLogic
  addMemo: boolean                     // 死字段
  order: number                        // 默认 100，排序为降序
  position: WorldInfoPosition
  disable: boolean
  ignoreBudget: boolean
  excludeRecursion: boolean
  preventRecursion: boolean
  matchPersonaDescription: boolean
  matchCharacterDescription: boolean
  matchCharacterPersonality: boolean
  matchCharacterDepthPrompt: boolean
  matchScenario: boolean
  matchCreatorNotes: boolean
  delayUntilRecursion: number          // ST 允许 true，导入时规范化为 1
  probability: number                  // 0-100
  useProbability: boolean
  depth: number                        // 仅 position===atDepth
  outletName: string                   // 仅 position===outlet
  group: string                        // 逗号分隔，可属多组
  groupOverride: boolean
  groupWeight: number
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  automationId: string
  role: ExtensionPromptRole
  sticky: number | null
  cooldown: number | null
  delay: number | null
  characterFilter: CharacterFilter
  triggers: GenerationTrigger[]
  displayIndex?: number
}

export const DEFAULT_WI_ENTRY: Omit<WorldInfoEntry, 'uid'> = {
  key: [], keysecondary: [], comment: '', content: '',
  constant: false, vectorized: false, selective: true,
  selectiveLogic: world_info_logic.AND_ANY, addMemo: false,
  order: 100, position: world_info_position.before,
  disable: false, ignoreBudget: false,
  excludeRecursion: false, preventRecursion: false,
  matchPersonaDescription: false, matchCharacterDescription: false,
  matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
  matchScenario: false, matchCreatorNotes: false,
  delayUntilRecursion: 0, probability: 100, useProbability: true,
  depth: DEFAULT_DEPTH, outletName: '',
  group: '', groupOverride: false, groupWeight: DEFAULT_WEIGHT,
  scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null,
  automationId: '', role: extension_prompt_roles.SYSTEM,
  sticky: null, cooldown: null, delay: null,
  characterFilter: { isExclude: false, names: [], tags: [] },
  triggers: [],
}

/** 落库形态与 ST 文件格式同构：entries 是 uid 字符串键的对象 → 零转换导入导出 */
export interface WorldBook {
  id: string
  name: string
  description: string
  entries: Record<string, WorldInfoEntry>
  createdAt: number
  updatedAt: number
}

/** 扫描运行态（不落库）。engine 内部只见 ResolvedEntry */
export interface ResolvedEntry extends WorldInfoEntry {
  world: string        // 书 id（ST 用书名；我们用 id，导出时映射）
  worldName: string
  hash: number         // 定时效果身份；内容变更即失效，与 ST 语义一致
  decorators: string[]
}

/** getFreeWorldEntryUid：最小未占用非负整数 */
export function nextEntryUid(entries: Record<string, WorldInfoEntry>): number {
  for (let uid = 0; uid < MAX_UID; uid++) if (!(String(uid) in entries)) return uid
  throw new Error('世界书条目已达上限')
}
export function createEntry(entries: Record<string, WorldInfoEntry>): WorldInfoEntry {
  return { uid: nextEntryUid(entries), ...structuredClone(DEFAULT_WI_ENTRY) }
}
```

### 2.2 `src/types/character.ts`

**关键决策**：`data.*` 是**唯一权威**；v1 顶层镜像只在导入时读（回填 data）、导出时写。运行时一律 `char.data.description`，杜绝双真相源。

```ts
export interface DepthPrompt { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' }

export interface CharacterExtensions {
  talkativeness: number           // 0..1 默认 0.5，1vN natural 策略权重
  fav: boolean
  world?: string                  // ST 单本角色书名，导入时转 worldBookIds
  depth_prompt?: DepthPrompt
  np?: { worldBookNames?: string[]; mainPrompt?: string }  // 本 app 命名空间，往返无损
  [k: string]: unknown
}

export interface CharacterBookSpec { name?: string; description?: string; entries: unknown[]; [k: string]: unknown }

export interface CharacterDataV2 {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string             // <START> 分隔的多条对话示例
  creator_notes: string
  system_prompt: string
  post_history_instructions: string
  tags: string[]
  creator: string
  character_version: string
  alternate_greetings: string[]   // 需求 2：新对话从 [first_mes, ...alts] 随机取
  character_book?: CharacterBookSpec
  extensions: CharacterExtensions
}

/** @deprecated 仅导入回填 / 导出镜像；运行时永远读 data.* */
export interface CharacterV1Mirror {
  name?: string; description?: string; personality?: string; scenario?: string
  first_mes?: string; mes_example?: string; creatorcomment?: string
  tags?: string[]; talkativeness?: number; fav?: boolean
}

export interface Character extends CharacterV1Mirror {
  id: string                      // crypto.randomUUID()，不用 ST 的 avatar 文件名当主键
  spec: 'chara_card_v2'
  spec_version: '2.0'
  data: CharacterDataV2
  // app-only
  avatarBlobId?: string
  worldBookIds: string[]          // 角色世界书，扩展成多本
  fav: boolean
  favIdx: 0 | 1                   // IDB 索引用
  createdAt: number
  updatedAt: number
}

export function emptyCharacter(id: string, name = '新角色'): Character { /* 见文中默认值 */ }

/** 开场白池：ST 演绎规则——空串过滤后均匀随机 */
export function greetingPool(c: Character): string[] {
  return [c.data.first_mes, ...c.data.alternate_greetings].filter((x) => !!x && x.trim())
}
```

### 2.3 `src/types/group.ts`（含自研关系图谱）

```ts
export const group_activation_strategy = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 } as const
export const group_generation_mode = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 } as const
export const DEFAULT_AUTO_MODE_DELAY = 5
export const TALKATIVENESS_DEFAULT = 0.5

/** 有向边：A→B 与 B→A 可完全不同 */
export interface GroupRelation {
  id: string
  from: string          // characterId
  to: string            // characterId
  label: string         // 「妹妹」「宿敌」「暗恋对象」——注入提示词的主体
  desc?: string
  color?: string
  mirrorOf?: string     // 双向便捷创建标记，仅 UI 用
}

export interface GroupNodeLayout { x: number; y: number }   // 逻辑坐标，渲染时按 viewBox 缩放

export interface Group {
  id: string
  name: string
  members: string[]                   // 有序 characterId = ST 的 list order
  disabled_members: string[]          // 静音
  activation_strategy: 0 | 1 | 2 | 3
  generation_mode: 0 | 1 | 2
  generation_mode_join_prefix: string
  generation_mode_join_suffix: string
  auto_mode_delay: number
  allow_self_responses: boolean
  hide_muted_sprites: boolean
  fav: boolean
  // 自研
  relations: GroupRelation[]
  layout: Record<string, GroupNodeLayout>
  relationTemplate: string            // 支持 {{from}} {{to}} {{label}} {{desc}}
  mergeMemberBooks: boolean           // false=照 ST（只用当前发言者的书）；true=并集去重
  avatarBlobId?: string
  createdAt: number
  updatedAt: number
}

export const DEFAULT_RELATION_TEMPLATE = '{{from}} 对 {{to}} 的关系：{{label}}'
```

### 2.4 `src/types/chat.ts`

```ts
export interface MessageExtra {
  gen_id?: number          // 一次多发言人批次的批号 → 「重掷整批」
  model?: string
  reasoning?: string
  token_count?: number
  characterId?: string
  duration?: number
  stopped?: boolean
  [k: string]: unknown
}

export interface SwipeInfo { send_date: number; gen_started?: number; gen_finished?: number; extra: MessageExtra }

export interface ChatMessage {
  // 主键
  chatId: string
  seq: number              // 由 ChatMeta.nextSeq 在同一事务内分配
  id: string               // crypto.randomUUID，用于 by_msgId 与 v-for :key
  // ST 原生字段名
  name: string
  is_user: boolean
  is_system: boolean
  exclude?: boolean        // 眼睛图标：从提示词排除但仍显示
  mes: string
  send_date: number
  swipes?: string[]
  swipe_id?: number
  swipe_info?: SwipeInfo[]
  extra: MessageExtra
  original_avatar?: string // 权威的「谁说的」= characterId（ST 用 avatar 文件名）
  force_avatar?: string    // blobs id
}

export interface TimedEffect { hash: number; start: number; end: number; protected: boolean }
/** key = `${bookId}.${uid}` */
export interface TimedWorldInfo { sticky: Record<string, TimedEffect>; cooldown: Record<string, TimedEffect> }

export interface ChatMetadata {
  timedWorldInfo: TimedWorldInfo
  variables: Record<string, string>   // {{setvar}}/{{getvar}} 会话作用域
  tainted: boolean                    // false 且无消息时才播种开场白
  scenario?: string
  mes_example?: string
  worldBookId?: string                // 会话专属世界书（优先级最高层）
  chat_id_hash?: number               // {{pick}} 稳定种子，分支后继承
}

export interface ChatMeta {
  id: string
  kind: 'solo' | 'group'
  characterId?: string
  groupId?: string
  title: string
  createdAt: number
  updatedAt: number
  lastMessageAt: number
  messageCount: number                // 冗余计数，避免侧栏渲染时 count()
  nextSeq: number                     // append 与自增在同一事务
  chat_metadata: ChatMetadata
  parentChatId?: string               // 分支
  branchFromSeq?: number
}

export function newChatMetadata(): ChatMetadata {
  return { timedWorldInfo: { sticky: {}, cooldown: {} }, variables: {}, tainted: false }
}
export function newAiMessage(chatId: string, name: string, mes = '', extra: MessageExtra = {}): Omit<ChatMessage, 'seq'>
export function newUserMessage(chatId: string, name: string, mes: string): Omit<ChatMessage, 'seq'>
```

### 2.5 `src/types/settings.ts`

```ts
export type ChatMode = 'solo' | 'group'

/** 需求 4：1v1 / 1vN 两套约束提示词，各自可配插入深度（默认 0） */
export interface ConstraintPromptConfig {
  enabled: boolean
  text: string          // 支持宏：{{user}} {{char}} {{group}} {{groupNotMuted}} {{notChar}} {{relations}}
  depth: number         // depth N = 注入后仍有 N 条真实消息在其后；0 = 追加到最末
  role: 0 | 1 | 2
  order: number         // 同 depth 同 role 多来源排序，越大越靠近模型（默认 100）
}

export interface ProviderSettings {
  baseUrl: string        // https://api.deepseek.com/v1 或 /proxy/deepseek/v1
  model: string
  secretRef: string      // secrets store 的 ref，不直接存 key
  proxyPrefix: string    // 空 = 直连；见 provider/http.ts::resolveUrl
  stream: boolean
  temperature: number
  maxTokens: number
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  stop: string[]
  contextWindow?: number
  extraHeaders: Record<string, string>
  modelCache?: { at: number; ids: string[] }
}

/** 与 ST 全局 WI 设置一一对应 */
export interface WorldInfoSettings {
  world_info_depth: number                    // 2
  world_info_min_activations: number          // 0
  world_info_min_activations_depth_max: number// 0
  world_info_budget: number                   // 25 (%)
  world_info_budget_cap: number               // 0 = 无上限
  world_info_include_names: boolean           // true
  world_info_recursive: boolean               // false
  world_info_max_recursion_steps: number      // 0
  world_info_overflow_alert: boolean          // false
  world_info_case_sensitive: boolean          // false
  world_info_match_whole_words: boolean       // false
  world_info_use_group_scoring: boolean       // false
  world_info_character_strategy: 0 | 1 | 2    // 1 = character_first
  globalBookIds: string[]                     // 需求 5：全局世界书只在全局配置启用
}

export interface PersonaSettings {
  name: string; description: string; avatarBlobId?: string
  position: 0 | 2 | 3 | 4 | 9; depth: number; role: 0 | 1 | 2
  worldBookId?: string
}

export interface PromptSettings {
  mainPrompt: string
  compact: boolean
  contextStrategy: 'drop' | 'trim'
  trimKeep: number
  squashSystemMessages: boolean
  newChatPrompt: string
  newGroupChatPrompt: string      // '[开始新的演绎。成员：{{group}}]'
  groupNudge: string              // '[只以 {{char}} 的身份写下一条回复。]'
  perMessageTokens: number        // 16
}

export interface Settings {
  id: 'app'
  schemaVersion: number
  theme: 'light' | 'dark' | 'system'
  provider: ProviderSettings
  worldInfo: WorldInfoSettings
  persona: PersonaSettings
  prompt: PromptSettings
  constraint: Record<ChatMode, ConstraintPromptConfig>   // 需求 4 核心
  chat: { streamFlushMs: number; pageSize: number; sendOnEnter: boolean }
  updatedAt: number
}
export function defaultSettings(): Settings
```

### 2.6 `src/types/provider.ts`

近乎逐字复用 `D:/tauriApp/sillyTavernTauri/src/types/provider.ts`，删掉多 provider 相关：

```ts
export type Role = 'system' | 'user' | 'assistant'
export interface ChatMessageParam { role: Role; content: string; name?: string }  // name: example_user/example_assistant
export interface ChatCompletionRequest {
  model: string; messages: ChatMessageParam[]; stream: boolean
  maxTokens?: number; temperature?: number; topP?: number
  frequencyPenalty?: number; presencePenalty?: number; stop?: string[]
}
export interface HttpRequestSpec { url: string; method: 'POST' | 'GET'; headers: Record<string, string>; body?: string }
export interface StreamChunk { delta: string; reasoningDelta?: string; finishReason?: string }
export interface ProviderConfig { baseUrl: string; apiKey?: string; headers?: Record<string, string>; proxyPrefix?: string }
export interface ModelInfo { id: string; contextLength?: number }
```

---

## 3. 仓储层 `src/db/repositories/`

导出**平铺 async 函数**（不是 class），`export * as xxxRepo` 命名空间聚合，便于 tree-shaking 与 mock。只接受/返回纯数据，不接受 Ref。

```ts
// src/db/repositories/index.ts
export * as settingsRepo from './settings'
export * as secretsRepo from './secrets'
export * as charactersRepo from './characters'
export * as worldsRepo from './worldbooks'
export * as groupsRepo from './groups'
export * as chatsRepo from './chats'
export * as messagesRepo from './messages'
export * as blobsRepo from './blobs'
```

### 3.1 characters（含跨 store 级联删除）

```ts
list(): Promise<Character[]>            // by_updatedAt 倒序
get(id: string): Promise<Character | undefined>
save(c: Character): Promise<Character>  // 自动 stamp updatedAt + favIdx
remove(id: string): Promise<void>
toggleFav(id: string): Promise<void>
count(): Promise<number>

// remove 必须在一个跨 store 事务里，否则中途失败留孤儿
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['characters', 'blobs', 'chats', 'messages', 'groups'], 'readwrite')
  const c = await tx.objectStore('characters').get(id)
  if (c?.avatarBlobId) await tx.objectStore('blobs').delete(c.avatarBlobId)

  const chatStore = tx.objectStore('chats')
  const chatIds = await chatStore.index('by_characterId').getAllKeys(id)
  for (const cid of chatIds) {
    await tx.objectStore('messages').delete(chatRange(cid as string))
    await chatStore.delete(cid)
  }

  const gStore = tx.objectStore('groups')
  for (const g of await gStore.getAll()) {
    if (!g.members.includes(id)) continue
    g.members = g.members.filter((m) => m !== id)
    g.disabled_members = g.disabled_members.filter((m) => m !== id)
    g.relations = g.relations.filter((r) => r.from !== id && r.to !== id)
    delete g.layout[id]
    await gStore.put(g)
  }
  await tx.objectStore('characters').delete(id)
  await tx.done
}
```

### 3.2 messages（最关键）

```ts
/** 追加一条：同一事务内从 ChatMeta.nextSeq 取号并自增，同时更新计数/时间 */
export async function append(chatId: string, msg: Omit<ChatMessage, 'seq'>): Promise<ChatMessage> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (!meta) throw new Error(`chat ${chatId} 不存在`)
  const row: ChatMessage = { ...msg, seq: meta.nextSeq }
  await tx.objectStore('messages').put(row)
  meta.nextSeq += 1
  meta.messageCount += 1
  meta.lastMessageAt = row.send_date
  meta.updatedAt = Date.now()
  await chats.put(meta)
  await tx.done
  return row
}

export async function appendMany(chatId: string, msgs: Omit<ChatMessage, 'seq'>[]): Promise<ChatMessage[]>

/** 原地更新（流式增量落盘 / 编辑 / swipe 切换）。已知 seq */
export async function update(row: ChatMessage): Promise<void> {
  const db = await getDb(); await db.put('messages', row)
}

export async function getById(chatId: string, id: string): Promise<ChatMessage | undefined> {
  const db = await getDb(); return db.getFromIndex('messages', 'by_msgId', [chatId, id])
}

/** 最近 limit 条，升序返回；before 传入则取 seq < before 的一页（向上翻页） */
export async function page(
  chatId: string,
  opts: { limit: number; before?: number } = { limit: 50 },
): Promise<{ rows: ChatMessage[]; hasMore: boolean }> {
  const db = await getDb()
  const upper: IDBValidKey = opts.before === undefined ? [chatId, []] : [chatId, opts.before]
  const range = IDBKeyRange.bound([chatId], upper, false, opts.before !== undefined)
  const out: ChatMessage[] = []
  let cursor = await db.transaction('messages').store.openCursor(range, 'prev')
  while (cursor && out.length < opts.limit) { out.push(cursor.value); cursor = await cursor.continue() }
  return { rows: out.reverse(), hasMore: cursor !== null }
}

/** 取最后 n 条（提示词构建 / WI 扫描窗口），升序 */
export async function tail(chatId: string, n: number): Promise<ChatMessage[]>

export async function remove(chatId: string, seq: number): Promise<void>

/** 删除末尾 n 条（regenerate / 重掷整批） */
export async function removeTail(chatId: string, n: number): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['chats', 'messages'], 'readwrite')
  let cursor = await tx.objectStore('messages').openCursor(chatRange(chatId), 'prev')
  let removed = 0
  while (cursor && removed < n) { await cursor.delete(); removed++; cursor = await cursor.continue() }
  const chats = tx.objectStore('chats')
  const meta = await chats.get(chatId)
  if (meta) { meta.messageCount = Math.max(0, meta.messageCount - removed); meta.updatedAt = Date.now(); await chats.put(meta) }
  await tx.done
}

export async function removeFrom(chatId: string, fromSeq: number): Promise<void>   // 分支点之后
export async function clear(chatId: string): Promise<void>
export async function copyUpTo(src: string, dst: string, atSeq: number): Promise<number>  // 分支
```

> **`nextSeq` 只增不减**：`removeTail` 后不回退，避免 seq 复用导致游标/分页错乱。seq 稀疏无害。

### 3.3 其余仓储签名

```ts
// chats.ts
list(): Promise<ChatMeta[]>                       // by_updatedAt 倒序
listByCharacter(characterId: string): Promise<ChatMeta[]>
listByGroup(groupId: string): Promise<ChatMeta[]>
get(id: string): Promise<ChatMeta | undefined>
create(init: Pick<ChatMeta, 'kind' | 'characterId' | 'groupId' | 'title'>): Promise<ChatMeta>
save(meta: ChatMeta): Promise<void>
patchMetadata(id: string, patch: Partial<ChatMetadata>): Promise<void>   // timedWorldInfo 回写
remove(id: string): Promise<void>                 // 同事务删 messages

// worldbooks.ts
list() / get(id) / getMany(ids) / create(name) / save(book) / rename(id, name) / remove(id)
upsertEntry(bookId: string, entry: WorldInfoEntry): Promise<void>
removeEntry(bookId: string, uid: number): Promise<void>
// remove 级联：从 settings.globalBookIds、各 Character.worldBookIds、ChatMetadata.worldBookId 摘除

// groups.ts
list / get / save / remove(级联删 group 会话)
addMember / removeMember / reorderMember / toggleMute
upsertRelation(groupId, r) / removeRelation(groupId, relationId) / saveLayout(groupId, layout)

// blobs.ts
put(data: Blob): Promise<string>          // 返回新 id
get(id): Promise<Blob | undefined>
remove(id): Promise<void>
gc(): Promise<number>                     // 扫全库引用，设置页「清理未引用图片」

// secrets.ts
get(ref): Promise<string>   // 不存在返回 ''
set(ref, value): Promise<void>
remove(ref): Promise<void>

// settings.ts
load(): Promise<Settings>   // 不存在则写 defaultSettings()
save(s: Settings): Promise<void>
```

---

## 4. Pinia store 划分

7 个 setup 式 store。**边界**：store 持有内存真相 + 响应式；repository 负责持久化；写路径一律「先改内存（乐观）→ await repo → 失败回滚 + toast」。

| store | state | 关键 action |
|---|---|---|
| `useSettingsStore` | `settings: Settings`、`loaded` | `load()` · `patch(partial)` · `applyTheme()` · `setApiKey(k)`（走 secretsRepo）· `getApiKey()`。深 watch + 400ms 防抖落盘 |
| `useCharactersStore` | `items: Character[]`、`byId: computed Map` | `load` `get` `create` `save` `remove` `setAvatar(id, file)` `importFromFile(file)` `exportCard(id,'png'\|'json')` |
| `useWorldsStore` | `books: WorldBook[]` | `load` `create(name)` `save` `remove` `upsertEntry` `removeEntry` `resolveActiveBooks(ctx)` `importBook` `exportBook` |
| `useGroupsStore` | `items: Group[]` | `load` `create` `save` `remove` `addMember` `toggleMute` `upsertRelation` `removeRelation` `saveLayout` |
| `useChatsStore` | `metas: ChatMeta[]`、`activeId`、`messages: ChatMessage[]`（窗口）、`hasMore` | `loadList` `open(chatId)` `loadMore()` `createSolo(charId)` `createGroup(groupId)` `seedGreetings()` `appendUser` `appendAi` `editMessage` `deleteMessage` `setSwipe(seq, idx)` `branchFrom(seq)` `remove` |
| `useGenerationStore` | `isGenerating`、`generatingSeq`、`speakerQueue: string[]`、`abort: AbortController \| null`、`error` | `send(text)` `regenerate()` `swipeNext(seq)` `continueLast()` `triggerSpeaker(charId)` `stop()` `inspectPrompt()`（dry-run） |
| `useUiStore` | `drawerOpen` `rightPanelOpen` `isMobile` `toasts` `confirm` | 纯 UI，无持久化（theme 在 settings） |

**为什么把生成从 chats 里拆出去**：`sillyTavernTauri/src/stores/chats.ts` 是 1267 行，因为它同时管数据和编排。拆开后 `useChatsStore` 只做 CRUD + 窗口分页（~250 行），`useGenerationStore` 只做「选发言人 → 建提示词 → 流式 → 落盘」（~350 行），两个都可读可测。

### 4.1 世界书来源解析（store 层，engine 只吃数组）

```ts
export interface BookSourceCtx {
  character?: Character      // 当前发言角色（1vN 每轮不同）
  chatMetadata?: ChatMetadata
  persona?: PersonaSettings
  group?: Group
}
function resolveActiveBooks(ctx: BookSourceCtx): {
  global: WorldBook[]; character: WorldBook[]; chat: WorldBook[]; persona: WorldBook[]
}
```

顺序规则必须与 ST `getSortedEntries` 一致：
1. 各层按**书 id** 对更高优先层去重（低优先层跳过已在高优先层出现的书）。
2. global 与 character 按 `world_info_character_strategy` 合并（evenly / character_first / global_first）。
3. 最终 `entries = [...chatLore, ...personaLore, ...合并结果]`，每段内部按 `order` **降序**。

**1vN 取舍（明确记录）**：ST 只用**当前发言者**的角色书。默认照做（`Group.mergeMemberBooks = false`）；开关打开时并集所有未静音成员的书并按 id 去重。群共享设定的**推荐路径**仍是会话世界书 `chat_metadata.worldBookId`。

---

## 5. 路由与页面

```ts
// src/router/index.ts
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/chat' },
  { path: '/chat', name: 'chat-empty', component: () => import('@/views/ChatView.vue') },
  { path: '/chat/:chatId', name: 'chat', component: () => import('@/views/ChatView.vue'), props: true },

  { path: '/characters', name: 'characters', component: () => import('@/views/CharactersView.vue') },
  { path: '/characters/new', name: 'character-new', component: () => import('@/views/CharacterEditView.vue') },
  { path: '/characters/:id', name: 'character-edit', component: () => import('@/views/CharacterEditView.vue'), props: true },

  { path: '/groups', name: 'groups', component: () => import('@/views/GroupsView.vue') },
  { path: '/groups/new', name: 'group-new', component: () => import('@/views/GroupEditView.vue') },
  { path: '/groups/:id', name: 'group-edit', component: () => import('@/views/GroupEditView.vue'), props: true },

  { path: '/worlds', name: 'worlds', component: () => import('@/views/WorldBooksView.vue') },
  { path: '/worlds/:id', name: 'world-edit', component: () => import('@/views/WorldBookEditView.vue'), props: true },

  { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  { path: '/settings/:tab', name: 'settings-tab', component: () => import('@/views/SettingsView.vue'), props: true },

  { path: '/:pathMatch(.*)*', redirect: '/chat' },   // vue-router 5：不能用 '*'
]

export default createRouter({ history: createWebHistory(import.meta.env.BASE_URL), routes })
```

页面清单（8 个 view）：

| view | 职责 | 移动端 |
|---|---|---|
| `ChatView` | 消息流 + 输入区 + 顶栏（角色/群、模型徽标、重生成/停止） | 会话列表变离屏抽屉；输入区 `padding-bottom: env(safe-area-inset-bottom)` |
| `CharactersView` | 角色网格、搜索、导入 | 单列 |
| `CharacterEditView` | Tab：基础 / 开场白（多条可增删排序） / 对话示例（多条 `<START>` 块） / 高级（system_prompt、PHI、depth_prompt、talkativeness） / 世界书绑定 | Tab 横向滚动 |
| `GroupsView` | 群列表 | — |
| `GroupEditView` | 成员选择 + **关系图谱 SVG 画布** + 策略/模式/自动模式 | 双指缩放，节点命中区 ≥44px |
| `WorldBooksView` | 世界书列表，标「全局启用」 | — |
| `WorldBookEditView` | 条目列表（虚拟滚动）+ 全字段条目编辑面板 | 列表/编辑堆叠切换 |
| `SettingsView` | Tab：接口 / 提示词（双模式约束+深度） / 世界书 / 角色扮演身份 / 外观 / 数据 | — |

`App.vue` 改造：保留 `.shell` + `aside.sidebar` + `.scrim` + 汉堡按钮骨架，内容替换为 `IconRail` + `SessionList` + `<RouterView />`；theme 逻辑从组件移入 `useSettingsStore`。

---

## 6. provider 层

### 6.1 模块

```
src/services/provider/
  types.ts             # §2.6
  http.ts              # send(spec, signal) + resolveUrl(代理改写)
  openaiCompatible.ts  # buildRequest / parseChunk / parseFull / listModels
  stream.ts            # streamChat() 异步生成器 + completeChat()
  errors.ts            # ProviderError
  contextWindow.ts     # 由 model id 猜上下文窗口（复用 sillyTavernTauri）
```

### 6.2 `http.ts` — 代理地址解析

```ts
/**
 * 三种形态：
 * 1. proxyPrefix 为空          → 直连 baseUrl（OpenAI / DeepSeek / OpenRouter 都发 CORS 头）
 * 2. baseUrl 以 '/' 开头       → 走 vite dev proxy（如 '/proxy/deepseek/v1'），同源，原样返回
 * 3. proxyPrefix 非空          → `${proxyPrefix}${absoluteUrl}`，支持 corsproxy 类服务
 */
export function resolveUrl(baseUrl: string, path: string, proxyPrefix?: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const full = `${base}${path}`
  if (base.startsWith('/')) return full
  if (!proxyPrefix) return full
  const p = proxyPrefix.replace(/\s+/g, '')
  return /[?=]$/.test(p) ? p + encodeURIComponent(full) : p.replace(/\/+$/, '') + '/' + full
}

export async function send(spec: HttpRequestSpec, signal?: AbortSignal): Promise<Response> {
  // 绝不设 mode:'no-cors'——那会拿到不可读的 opaque response
  return fetch(spec.url, { method: spec.method, headers: spec.headers, body: spec.body, signal })
}
```

### 6.3 `openaiCompatible.ts`

改编自 `D:/tauriApp/sillyTavernTauri/src/services/providers/base.ts`（删 DeepSeek prefix/thinking 特判，保留 `reasoning_content`）：

```ts
export function buildRequest(req: ChatCompletionRequest, cfg: ProviderConfig): HttpRequestSpec {
  const body: Record<string, unknown> = { model: req.model, messages: req.messages, stream: req.stream }
  if (req.temperature != null) body.temperature = req.temperature
  if (req.maxTokens != null) body.max_tokens = req.maxTokens
  if (req.topP != null) body.top_p = req.topP
  if (req.frequencyPenalty != null) body.frequency_penalty = req.frequencyPenalty
  if (req.presencePenalty != null) body.presence_penalty = req.presencePenalty
  if (req.stop?.length) body.stop = req.stop

  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(cfg.headers ?? {}) }
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`

  return { url: resolveUrl(cfg.baseUrl, '/chat/completions', cfg.proxyPrefix), method: 'POST', headers, body: JSON.stringify(body) }
}

export function parseChunk(data: string): StreamChunk | null {
  let json: any
  try { json = JSON.parse(data) } catch { return null }
  const choice = json?.choices?.[0]
  if (!choice) return null
  const d = choice.delta ?? {}
  const out: StreamChunk = { delta: d.content ?? '' }
  if (d.reasoning_content) out.reasoningDelta = d.reasoning_content
  if (choice.finish_reason) out.finishReason = choice.finish_reason
  if (!out.delta && !out.reasoningDelta && !out.finishReason) return null
  return out
}

export function parseFull(json: any): { text: string; reasoning?: string }
export async function listModels(cfg: ProviderConfig): Promise<ModelInfo[]>   // GET /models
```

### 6.4 `stream.ts` — SSE 解析 / 中断 / 错误

复用 `sillyTavernTauri/src/services/stream/index.ts` 的循环骨架，但**必须修两处**：
1. **按空行分帧，而非按单行**。原实现假设一帧一行 `data: {...}`，遇到多行 `data:` 续行（部分兼容端点会发）会丢数据。
2. `\r\n` 兼容（某些代理会转 CRLF）。

```ts
export async function* streamChat(
  req: ChatCompletionRequest, cfg: ProviderConfig, signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const spec = buildRequest({ ...req, stream: true }, cfg)
  let res: Response
  try {
    res = await send(spec, signal)
  } catch (e) {
    if ((e as Error).name === 'AbortError') return
    throw new ProviderError('network', 0,
      `无法连接接口：${(e as Error).message}。若是浏览器 CORS 拦截，请在设置里填写代理地址或使用 /proxy/* 开发代理。`)
  }
  if (!res.ok) throw ProviderError.fromResponse(res.status, await res.text().catch(() => ''))
  if (!res.body) {
    const full = parseFull(JSON.parse(await res.text()))
    if (full.reasoning) yield { delta: '', reasoningDelta: full.reasoning }
    yield { delta: full.text }
    return
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let sep: number
      while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {         // SSE 帧分隔 = 空行
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep + (buf[sep] === '\r' ? 4 : 2))
        const payload = raw.split(/\r?\n/)
          .filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
        if (!payload) continue
        if (payload === '[DONE]') return
        const chunk = parseChunk(payload)
        if (chunk) yield chunk
      }
    }
  } finally {
    reader.cancel().catch(() => {})   // 中断时释放底层连接
  }
}
```

**错误处理契约**：

```ts
export class ProviderError extends Error {
  constructor(
    public kind: 'network' | 'auth' | 'rate_limit' | 'bad_request' | 'server' | 'unknown',
    public status: number, message: string, public body?: string,
  ) { super(message) }

  static fromResponse(status: number, body: string): ProviderError {
    const detail = safeJson(body)?.error?.message ?? body.slice(0, 300)
    if (status === 401 || status === 403) return new ProviderError('auth', status, `鉴权失败：${detail}`, body)
    if (status === 429) return new ProviderError('rate_limit', status, `请求过于频繁：${detail}`, body)
    if (status >= 500) return new ProviderError('server', status, `服务端错误 ${status}：${detail}`, body)
    return new ProviderError('bad_request', status, `请求被拒绝 ${status}：${detail}`, body)
  }
}
```

`useGenerationStore.stop()` → `abort.abort()` → `send` 处吞掉 AbortError、生成器正常结束 → 已流出文本原样保留并落盘（**不回滚**），消息 `extra.stopped = true`。

### 6.5 `vite.config.ts` proxy 写法

```ts
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const mk = (target: string, prefix: string) => ({
    target,
    changeOrigin: true,     // 必须：否则 TLS SNI / Host 头不对，多数网关直接 421/403
    secure: true,
    ws: false,
    rewrite: (p: string) => p.replace(new RegExp(`^${prefix}`), ''),
    configure: (proxy: any) => {
      // SSE 必须禁用上游压缩，否则 http-proxy 会缓冲
      proxy.on('proxyReq', (proxyReq: any) => proxyReq.setHeader('Accept-Encoding', 'identity'))
    },
  })

  return {
    plugins: [vue(), vueDevTools()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: true,           // 手机同局域网实机调试
      proxy: {
        '/proxy/openai': mk('https://api.openai.com', '/proxy/openai'),
        '/proxy/deepseek': mk('https://api.deepseek.com', '/proxy/deepseek'),
        '/proxy/openrouter': mk('https://openrouter.ai', '/proxy/openrouter'),
        '/proxy/siliconflow': mk('https://api.siliconflow.cn', '/proxy/siliconflow'),
        // 自定义端点：VITE_LLM_PROXY_TARGET=http://127.0.0.1:11434 npm run dev
        '/proxy/custom': mk(env.VITE_LLM_PROXY_TARGET || 'http://127.0.0.1:11434', '/proxy/custom'),
      },
    },
  }
})
```

用法：设置页 baseURL 直接填 `/proxy/deepseek/v1`，`resolveUrl` 见 `/` 开头即原样返回 → 同源 → 无 CORS。

**生产构建没有 dev proxy**，设置页必须给出提示：
> 打包后（`npm run build`）不再有开发代理。请改用支持浏览器直连的接口地址（OpenAI / DeepSeek / OpenRouter 均返回 CORS 头），或在「代理前缀」里填自己的 CORS 代理，如 `https://your-worker.workers.dev/`。

---

## 7. `src/` 完整目录树

```
src/
├── main.ts                       # createApp → pinia → router → bootstrap()
├── App.vue                       # shell + RouterView + Drawer + Toast + Confirm
├── bootstrap.ts                  # getDb() → runDataMigrations() → settings.load() → 各 store load()
├── assets/styles/
│   ├── tokens.css                # 保持不动
│   ├── base.css                  # 追加 .cbx-bubble/.cbx-avatar/.cbx-composer/.cbx-prose/.cbx-code/.cbx-typing/.cbx-empty/.cbx-modal
│   └── graph.css                 # 关系图谱画布专用（仅 var(--cbx-*)）
├── router/index.ts
├── types/
│   ├── worldinfo.ts  character.ts  group.ts  chat.ts  settings.ts  provider.ts
├── db/
│   ├── schema.ts                 # NpDB DBSchema + getDb() + chatRange()
│   ├── migrations.ts             # DATA_SCHEMA_VERSION + 数据级迁移阶梯
│   └── repositories/
│       ├── index.ts  settings.ts  secrets.ts  characters.ts
│       ├── worldbooks.ts  groups.ts  chats.ts  messages.ts  blobs.ts
├── services/                     # 纯 TS，零 Vue / 零 Pinia / 零 IDB
│   ├── tokens.ts                 # estimateTokens（CJK 1/字，其余 len/4）— 同步，让预算循环全同步
│   ├── hash.ts                   # fnv1a → 定时效果 hash / {{pick}} 种子
│   ├── worldinfo/
│   │   ├── constants.ts  buffer.ts  match.ts  timed.ts  groups.ts  engine.ts  buckets.ts
│   ├── prompt/
│   │   ├── macros.ts  examples.ts  depth.ts  relations.ts  budget.ts  builder.ts
│   ├── group/
│   │   ├── activation.ts  cards.ts  greeting.ts
│   ├── provider/
│   │   ├── types.ts  http.ts  openaiCompatible.ts  stream.ts  errors.ts  contextWindow.ts
│   └── io/
│       ├── pngCard.ts  pngWriter.ts  normalize.ts  exportCard.ts
│       ├── importWorld.ts  exportWorld.ts  backup.ts
├── stores/
│   ├── settings.ts  characters.ts  worlds.ts  groups.ts  chats.ts  generation.ts  ui.ts
├── composables/
│   ├── useBreakpoint.ts  useAutoScroll.ts  useObjectUrl.ts
│   ├── useToast.ts  useConfirm.ts  useMarkdown.ts  useDragCanvas.ts
├── utils/
│   ├── id.ts  debounce.ts  clone.ts  bytes.ts  format.ts
├── views/
│   ├── ChatView.vue  CharactersView.vue  CharacterEditView.vue
│   ├── GroupsView.vue  GroupEditView.vue
│   ├── WorldBooksView.vue  WorldBookEditView.vue  SettingsView.vue
└── components/
    ├── layout/{AppShell,IconRail,SessionList,TopBar,BottomSheet}.vue
    ├── chat/{MessageList,MessageBubble,Composer,SwipeControls,TypingIndicator,GroupBar}.vue
    ├── character/{CharacterCard,AvatarPicker,GreetingListEditor,ExampleListEditor}.vue
    ├── group/{RelationGraph,RelationNode,RelationEdge,RelationEditor,MemberPicker}.vue
    ├── worldinfo/{EntryList,EntryEditor,PositionSelect,TimedFields}.vue
    ├── settings/{ProviderPane,PromptPane,WorldInfoPane,PersonaPane,AppearancePane,DataPane}.vue
    └── overlays/{Modal,Drawer,ConfirmDialog,Toast}.vue
```

---

## 8. 三个可直接起步的文件

1. `src/types/worldinfo.ts` — §2.1 已给完整代码，可直接粘。
2. `src/db/schema.ts` — §1.3 已给完整代码（先 `npm i idb`）。
3. `src/db/repositories/messages.ts` — §3.2 已给核心函数，其余按同样模式补。

三者落地后阶段 0 的验收脚本即可跑通，后续所有工作都有稳定地基。

## FILES
- `db/schema.ts` — IndexedDB 8 个对象仓库的 DBSchema 类型定义、getDb() 单例、upgrade 迁移阶梯、chatRange() 键区间工具  
  reuse: new（结构参考 D:/tauriApp/sillyTavernTauri/src/services/platform/storage.web.ts 的 openDb/tx 模式，但从 key-value 单 store 改为 8 个类型化 store，仅参考）
- `db/migrations.ts` — 数据级迁移（Settings.schemaVersion 阶梯），与结构级 DB_VERSION 分离，在 bootstrap 里 await  
  reuse: new
- `db/repositories/messages.ts` — 消息行 CRUD：append(同事务取 nextSeq)、appendMany、update、getById、page(向上翻页)、tail、remove、removeTail、removeFrom、clear、copyUpTo(分支)  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/server/src/messages.rs 的语义（append/upsert/delete tail），实现改写为 IndexedDB 复合键游标
- `db/repositories/characters.ts` — 角色 CRUD + 跨 store 级联删除（blobs/chats/messages/groups 五 store 单事务）  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/src/services/storage/repositories.ts 的 charactersRepo（路径 doc 改为对象仓库）
- `db/repositories/worldbooks.ts` — 世界书 CRUD + 条目 upsert/remove + 删除时从 globalBookIds/Character.worldBookIds/ChatMetadata.worldBookId 级联摘除  
  reuse: 改编自 sillyTavernTauri src/services/storage/repositories.ts::worldsRepo
- `db/repositories/chats.ts` — ChatMeta CRUD、按 characterId/groupId 索引查询、patchMetadata(timedWorldInfo 回写)、remove 同事务删消息  
  reuse: 改编自 sillyTavernTauri chatsRepo 的 listMeta/getMeta/saveMeta
- `db/repositories/blobs.ts` — 头像等二进制独立存储 put/get/remove/gc，避免 Blob 进入角色记录与 Pinia  
  reuse: new
- `db/repositories/secrets.ts` — API Key 按 ref 独立存储，为后续 AES-GCM 加密预留唯一改动点  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/src/services/storage/secrets.ts（去掉 /api/secrets，改 IndexedDB）；加密可复用 src/services/storage/crypto.ts
- `types/worldinfo.ts` — ST 原生 WI 枚举（logic/position/scan_state/insertion_strategy/roles/triggers）+ WorldInfoEntry 全字段 + DEFAULT_WI_ENTRY + WorldBook + ResolvedEntry + nextEntryUid  
  reuse: 以 survey/01-wi-model.md 的 newWorldInfoEntryDefinition 为权威规格重写；sillyTavernTauri/src/types/worldinfo.ts 只是子集（26 字段），仅参考命名风格
- `types/character.ts` — Character（v1 镜像 + v2 data 嵌套，data 为唯一权威）、CharacterDataV2、CharacterExtensions(depth_prompt/talkativeness)、emptyCharacter、greetingPool  
  reuse: 以 survey/03-char-macros.md 的 v1CharData/v2CharData 为权威规格；sillyTavernTauri/src/types/character.ts 是扁平化版本，结构不同，仅参考
- `types/group.ts` — Group（ST 原生字段 members/disabled_members/activation_strategy/generation_mode/join_prefix 等）+ 自研 relations/layout/relationTemplate/mergeMemberBooks + 两个策略枚举  
  reuse: ST 字段部分逐字对齐 survey/04-group.md 的 Group interface；relations/layout/relationTemplate 为 new
- `types/chat.ts` — ChatMessage(chatId/seq/id + ST 原生 name/is_user/mes/swipes/swipe_id/swipe_info/extra.gen_id/original_avatar)、ChatMeta(nextSeq/messageCount/分支)、ChatMetadata(timedWorldInfo/variables/tainted)、TimedEffect  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/src/types/chat.ts（改回 ST 原生 snake_case 字段名，TimedState 换成 ST 的 {hash,start,end,protected} 四字段形态）
- `types/settings.ts` — Settings 根 + ConstraintPromptConfig(需求4双模式约束+深度) + ProviderSettings + WorldInfoSettings(ST 全局项逐条对齐) + PersonaSettings + PromptSettings + defaultSettings()  
  reuse: WorldInfoSettings 逐字对齐 survey/01 §3.0 的全局变量；其余改编自 sillyTavernTauri/src/types/settings.ts
- `types/provider.ts` — ChatMessageParam/ChatCompletionRequest/HttpRequestSpec/StreamChunk/ProviderConfig/ModelInfo（仅 OpenAI 兼容）  
  reuse: 逐字复用 D:/tauriApp/sillyTavernTauri/src/types/provider.ts，删除 ProviderId 多厂商 union、ProviderAdapter、ConnectionProfile、reasoning/thinking 特化字段
- `services/provider/http.ts` — resolveUrl(baseUrl,path,proxyPrefix) 三形态代理改写 + send(spec,signal) 原生 fetch  
  reuse: send 逐字复用 sillyTavernTauri/src/services/platform/http.web.ts；resolveUrl 为 new
- `services/provider/openaiCompatible.ts` — buildRequest/parseChunk(含 reasoning_content)/parseFull/listModels  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/src/services/providers/base.ts + openai.ts（删 DeepSeek prefix/thinking 特判与 http 门面依赖）
- `services/provider/stream.ts` — streamChat() 异步生成器（按空行分帧的 SSE 解析、[DONE]、AbortSignal、reader.cancel 释放连接）+ completeChat()  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/src/services/stream/index.ts（必须把按行分帧改为按 \r?\n\r?\n 空行分帧，否则多行 data: 会丢字）
- `services/provider/errors.ts` — ProviderError（kind/status/body + fromResponse 分类 401/429/5xx + CORS 中文提示）  
  reuse: new
- `services/provider/contextWindow.ts` — model id → 上下文窗口正则表 + DEFAULT_CONTEXT_WINDOW + WI_BUDGET_PERCENT + resolveContextWindow  
  reuse: 逐字复用 D:/tauriApp/sillyTavernTauri/src/services/providers/contextWindow.ts（刷新模型正则表）
- `services/tokens.ts` — estimateTokens 同步启发式（CJK 1 token/字，其余 len/4），供 WI 预算循环与上下文裁剪使用  
  reuse: 逐字复用 D:/tauriApp/sillyTavernTauri/src/services/tokens.ts
- `services/hash.ts` — fnv1a 字符串哈希：WI 定时效果 hash、{{pick}} 稳定种子、chat_id_hash  
  reuse: 改编自 sillyTavernTauri/src/services/prompt/macros.ts 内的 fnv1a 私有函数（提取为独立模块）
- `stores/settings.ts` — settings ref + load/patch/applyTheme/setApiKey/getApiKey，深 watch 400ms 防抖落盘，theme 写 html[data-theme] + localStorage 'cbx-theme'  
  reuse: 改编自 sillyTavernTauri/src/stores/settings.ts；theme 机制逐字复用 D:/tauriApp/nationalProducers/src/App.vue 的 applyTheme/toggleTheme/onMounted 三段
- `stores/chats.ts` — 会话列表 + 活动会话 + 消息窗口分页（loadMore）+ 开场白播种 + swipe/编辑/删除/分支。约 250 行，不含生成编排  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/src/stores/chats.ts（1267 行）的数据部分，生成部分拆出
- `stores/generation.ts` — 生成编排：选发言人队列 → 构建提示词 → streamChat 流式 → 节流落盘 → 中断。含 inspectPrompt() dry-run  
  reuse: 改编自 sillyTavernTauri/src/stores/chats.ts 的 buildRequest/runGeneration/stop 与 survey/04 的 generateGroupWrapper 循环骨架
- `stores/worlds.ts` — 世界书列表 + resolveActiveBooks(ctx) 四层来源解析（chat > persona > character/global 按 strategy）+ 按 id 去重 + 导入导出  
  reuse: 改编自 sillyTavernTauri/src/stores/worldinfo.ts::activeBooksFor（需按 survey/01 §3.3 扩到四层与三种 strategy）
- `stores/groups.ts` — 群组 CRUD + 成员增删排序静音 + relations/layout 编辑  
  reuse: new（sillyTavernTauri 无独立 group store，群信息挂在 ChatMeta 上）
- `stores/characters.ts` — 角色列表 + CRUD + 头像 Blob 链路 + PNG/JSON 导入导出  
  reuse: 改编自 D:/tauriApp/sillyTavernTauri/src/stores/characters.ts（importFromFile 的 PNG/.charx/JSON 魔数嗅探可逐字复用）
- `composables/useObjectUrl.ts` — blobId → objectURL，模块级引用计数 + URL.revokeObjectURL，防止 Blob 泄漏与 Pinia 膨胀  
  reuse: new
- `bootstrap.ts` — 启动序列：getDb() → runDataMigrations() → settingsStore.load() → 各 store load()，失败时渲染可读错误页  
  reuse: new
- `router/index.ts` — 填充 routes：/chat/:chatId、/characters、/groups、/worlds、/settings/:tab、catch-all（vue-router 5 用 /:pathMatch(.*)*）  
  reuse: 改编自 D:/tauriApp/nationalProducers/src/router/index.ts（当前 routes: []）
- `../vite.config.ts` — 追加 server.host=true 与 server.proxy 的 /proxy/{openai,deepseek,openrouter,siliconflow,custom} 五条规则（changeOrigin + rewrite + proxyReq 设 Accept-Encoding: identity 保证 SSE 不缓冲）  
  reuse: 改编自 D:/tauriApp/nationalProducers/vite.config.ts（现无 server 段）

## RISKS
## 最容易出错 / 被低估的点

**1. IDB 事务在 await 非 IDB Promise 时静默自动提交（头号杀手）**
后果：流式落盘丢数据、级联删除留孤儿，且**不报错**，只在生产偶发。
规避：铁律写进 `db/repositories/index.ts` 顶部注释；跨 store 事务函数体内不得出现除 `tx.*` / `store.*` / `cursor.*` 之外的 await；code review 设专项检查项。

**2. 消息 seq 分配竞态**
后果：两条消息拿到同一 seq，`put` 覆盖，消息凭空消失。
规避：`nextSeq` 的读-增-写必须与 `messages.put` 在**同一个 readwrite 事务**里（见 messages.append）；**绝不在 store 层算 seq**。`removeTail` 后不回退 nextSeq（seq 稀疏无害，回退会导致游标/分页错乱）。

**3. `data.*` 与 v1 顶层镜像双真相源**
后果：编辑简介后导出丢失、导入后显示旧值。
规避：类型上把 v1 字段标 `@deprecated`；`normalize.ts` 是唯一读 v1 的地方，`exportCard.ts` 是唯一写 v1 的地方；其余代码 grep 到 `char.description`（而非 `char.data.description`）即视为 bug。

**4. `noUncheckedIndexedAccess` 在 WI 引擎里雪崩**
后果：`entries[uid]`、`group[i]`、`scores[i]` 全是 `T | undefined`，为过编译乱加 `!`，把类型安全变成噪音。
规避：引擎内部一律先把 `Record<string, Entry>` 转 `Entry[]` 再 `for...of`；需要下标时用 `for (const [i, e] of arr.entries())`；约定 `services/**` 下禁止出现 `arr[i]!`。

**5. 头像 Blob 进入 Pinia**
后果：列表页几十 MB 内存、devtools 卡死、`structuredClone` 变慢。
规避：`blobs` 独立 store；`Character` 只存 `avatarBlobId`；`useObjectUrl` 做引用计数 + `URL.revokeObjectURL`。

**6. SSE 按行分帧（直接照抄 sillyTavernTauri 就会踩）**
后果：少数兼容端点的多行 `data:` 被丢弃，表现为"偶尔吞字"，极难复现定位。
规避：按 `\r?\n\r?\n` 空行分帧，帧内收集所有 `data:` 行拼接。上线前用 DeepSeek + 一个 vLLM/SiliconFlow 端点各跑一遍。

**7. dev proxy 在生产不存在**
后果：打包部署后所有请求 404，用户以为是 key 问题。
规避：设置页对 `baseUrl.startsWith('/') && import.meta.env.PROD` 直接显示红色警告条 + 迁移指引。

**8. `timedWorldInfo` 在 dry-run 时被推进**
后果：点一次"查看提示词"就消耗一轮 sticky / 触发一次 cooldown，用户完全无法理解。
规避：`ScanContext` 必带 `isDryRun`；dry-run 前 `structuredClone(timedWorldInfo)`，扫描后**不回写**。ST 原生行为也是 dry-run 只评估 delay、不评估 sticky/cooldown，照做。

**9. WI 定时效果 hash 用整条 JSON**
后果：用户改一个字，所有 sticky 全部失效。
规避：这是 ST 的**刻意设计**（编辑条目重置计时），保持一致；但在条目编辑器里加一行提示"修改条目会重置其 sticky/cooldown 计时"。

**10. 世界书 `by_name` 加 unique 索引**
后果：导入同名书直接抛 `ConstraintError`，整个导入流程炸。
规避：**去掉 unique**，只做普通索引，重名由 UI 提示 + 自动加 `(2)` 后缀。

**11. 1vN 每轮重扫世界书**
后果：5 人群一轮 5 次全量扫描 + 5 次 structuredClone，长会话明显卡顿。
规避：`estimateTokens` 保持同步、整个预算循环同步（这是相对 ST 最大的性能红利，ST 每条目每轮一次异步 tokenize）；`getSortedEntries` 结果按 bookIds 集合在 `useWorldsStore` 缓存，书变更才失效；`structuredClone` 只克隆当轮候选而非全库。

**12. 关系图谱在移动端残废**
后果：需求 3 在手机上不可用。
规避：用 Pointer Events（覆盖 mouse/touch/pen）而非 mousedown；节点命中区 ≥44px（视觉圆点可小，用透明 `<circle r="22">` 做命中）；画布 `touch-action: none`，外层容器保留纵向滚动；提供"自动布局"按钮兜底。

**13. Vite 8 / vue-router 5 / Pinia 4 / TS 6 都是新大版本**
后果：照旧版记忆写代码编译不过（如路由 `*` 通配符、`RouteRecordRaw` 变更）。
规避：用到不熟的 API 先看 `node_modules` 里的 `.d.ts`；catch-all 用 `/:pathMatch(.*)*`。每完成一个模块跑 `npm run type-check`。

**14. `by_fav` 索引建在 boolean 上**
后果：IDB 不接受 boolean 作为 key，索引静默失效（不报错，只是查不到）。
规避：`Character` 冗余 `favIdx: 0 | 1`，由 `charactersRepo.save` 单点维护同步。

**15. 项目无 git 无测试无 lint**
后果：没有回滚基线，重构风险高。
规避：动手前先 `git init` + 首次提交（作为独立建议告知用户）；把阶段 0 的验收脚本沉淀成一段可粘贴到 DevTools Console 的自检代码，充当"手工单测"。

## PHASING
## 分阶段：先跑通 1v1，数据层如何切分

### 阶段 0 — 地基（无可见 UI，但必须先做，1 人 2~3 天）
产出：`types/*` 全部 6 个文件、`db/schema.ts`、`db/migrations.ts`、全部 8 个 `repositories/*`、`utils/id.ts`、`bootstrap.ts`、`useSettingsStore`、`useUiStore`、`App.vue` 改成 shell + RouterView、路由表填满（页面全是占位）、`main.ts` 接 bootstrap、`vite.config.ts` 加 proxy。

验收：
- `npm run type-check` 通过；`npm run format` 无 diff。
- DevTools → Application → IndexedDB 能看到 `np-chat` 的 8 个 store 与全部索引。
- Console 自检脚本：建 1 个 chat → append 200 条 → `page({limit:50})` 返回最后 50 条且升序 → `page({limit:50, before:150})` 返回 seq 100..149 → `removeTail(10)` 后 `messageCount === 190` 且 `nextSeq` 仍为 200 → `chatsRepo.remove()` 后 `messages` store 该 chat 行数为 0。
- 手机尺寸抽屉可开关；主题切换刷新后保持。

### 阶段 1 — 角色（需求 2）
产出：`useCharactersStore`、`CharactersView`、`CharacterEditView`（多条开场白编辑器 + 多条 `<START>` 对话示例编辑器）、`blobsRepo` + `useObjectUrl` 头像链路、`services/io/{pngCard,normalize,exportCard}`。
验收：新建角色（头像 + 简介 + 性格 + 3 条开场白 + 2 段示例）→ 刷新 → 内容与头像完好；导入真实社区 PNG 卡 → 字段正确落到 `data.*`；导出 PNG 再导入 → 无损。

### 阶段 2 — 1v1 跑通（需求 1 的一半 + 需求 4 的机制）★ 里程碑
产出：`services/provider/*` 全套、`services/prompt/{macros,examples,depth,builder,budget}` 最小可用版、`useChatsStore`、`useGenerationStore`、`ChatView`/`MessageList`/`MessageBubble`/`Composer`、`SettingsView` 接口 Tab。
这一阶段就要落地：
- 新对话从 `greetingPool(char)` **随机取一条**作为消息 0，整池写入 `swipes` 供左右切换（需求 2 的"随机插入"）。
- `{{user}}` / `{{char}}` 发送前替换。
- `injectAtDepths()` 纯函数（~40 行）与 depth 语义（depth N = 其后仍有 N 条真实消息；0 = 追加到最末）。
- 流式 + 中断 + 每 `streamFlushMs` 局部落盘。
验收：填 key 后连续对话 20 轮不丢消息；刷新历史完整；中途停止已生成文本保留；断网发送报「无法连接接口 + CORS 提示」而非白屏；移动端输入不触发 iOS 缩放、不被键盘遮挡。**到此 1v1 已可日常使用。**

### 阶段 3 — 世界书完整对齐（需求 5）｜ 与阶段 4 可并行
产出：`services/worldinfo/*` 全套、`useWorldsStore`、`WorldBooksView` + `WorldBookEditView`、设置页世界书 Tab（全局设置 + `globalBookIds`）、`io/{importWorld,exportWorld}`、角色书绑定 UI。
验收（逐项过一本自造验收书）：关键词/正则键/全词/大小写三态；4 种 `selectiveLogic`；`constant`；`probability=50` 随机性；`sticky=3` 后转 `cooldown`；`delay=5`；包含组权重分布与 `groupOverride` 必胜；递归激活 + `preventRecursion` + `excludeRecursion`；预算调至 1% 时只有高 `order` 进入而 `ignoreBudget` 仍进入；8 个 position 各一条在"查看提示词"里落点正确；定时状态刷新后剩余轮数正确；**dry-run 不推进 sticky/cooldown**；导入真实社区世界书字段一致、往返无损。

### 阶段 4 — 1vN 演绎 + 关系图谱（需求 1 另一半 + 需求 3）｜ 与阶段 3 可并行
产出：`useGroupsStore`、`GroupsView`、`GroupEditView`、`components/group/RelationGraph.vue`（SVG 画布、Pointer 拖拽、有向箭头、A→B 与 B→A 双边）、`services/group/{activation,cards,greeting}`、`services/prompt/relations.ts`、发言人队列编排、group nudge。
验收：3 人群，LIST → 每轮 3 人依次发言且 `original_avatar` 正确；NATURAL → 提到名字的必出场；POOLED → 每轮 1 人轮换；MANUAL → 用户发言无自动回复，点「让 TA 说」才生成。新群首次打开每人各随机一条开场白。关系图谱：拖动位置持久化；建 A→B「妹妹」与 B→A「哥哥」两条不同边；"查看提示词"能看到渲染出的关系文本。手机能拖节点、能点边编辑。

### 阶段 5 — 双模式约束提示词与深度收口（需求 4）
产出：设置页提示词 Tab（solo/group 两组 `ConstraintPromptConfig`：文本 + 深度 + role + 启用）、`builder.ts` 把约束提示词并入深度注入队列、"查看提示词"调试面板（列出最终 messages 并标注每条来源）。
验收：solo 深度 0 → 约束文本出现在最后一条消息**之后**；设 2 → 出现在倒数第 2 条**之前**；group 独立生效互不干扰；约束文本里的 `{{relations}}` 在群模式被替换、单聊模式替换为空。

### 阶段 6 — 打磨与数据
产出：全库导出/导入 zip、未引用 blob GC、消息编辑/删除/分支、Markdown + 代码高亮、消息 >500 时虚拟滚动（**已实现**：`ChatView.vue` 的
`VIRTUAL_THRESHOLD`，超阈值才用 `virtua` 的 `Virtualizer`，低于阈值保持扁平渲染以免牺牲
Ctrl+F 查找与跨消息选中；配套见 `useAutoScroll` 的贴底 settle 与 `renderMarkdown` 的 LRU）、错误边界、空状态、暗色补洞（`--cbx-gray-*` 在 dark 下未覆盖导致滚动条拇指发白）。
验收：1000 条消息滚动 60fps；导出后在全新浏览器导入完全还原。

### 依赖关系
```
阶段0 → 阶段1 → 阶段2 ─┬─→ 阶段3 ─┐
                        └─→ 阶段4 ─┴─→ 阶段5 → 阶段6
```
阶段 3 与 4 可两人并行，唯一接口是 `useWorldsStore.resolveActiveBooks(ctx)`——先把这个函数签名定死（阶段 2 末尾即可用假实现占位），两边就不会互相阻塞。

### 数据层在各阶段的"提前量"
阶段 0 一次性把**全部 8 个 store 与全部类型**建好（不是随阶段增量加 store）。理由：IndexedDB 加 store 必须升 `DB_VERSION`，而升版本会阻塞其它已打开标签页；开发期反复升版本会让本地数据反复处于半迁移态，比一次建全麻烦得多。类型同理——`ChatMessage.original_avatar`、`Group.relations`、`ConstraintPromptConfig` 这些字段在阶段 0 就写进类型（哪怕阶段 4/5 才用），阶段 2 写的存取代码就不必回头改。