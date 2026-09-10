# 世界书引擎（完整对齐 SillyTavern）+ 宏引擎 + 提示词组装/深度注入

# 三大核心引擎实现设计

> 目录约定：以下路径均相对 `D:/tauriApp/nationalProducers/src/`。
> 所有模块**纯 TS、零 Vue/Pinia 依赖**（Pinia store 只负责取数据、存数据、调用这些纯函数）。
> 代码风格：无分号、单引号、2 空格。`noUncheckedIndexedAccess` 已开，所有 `arr[i]` 必须守卫。

---

## 第 0 部分：与现有移植（sillyTavernTauri）的差距清单

`D:/tauriApp/sillyTavernTauri/src/services/worldinfo/engine.ts`（346 行）是一个**行为子集**。逐项差距如下，每一项都是本次要补的：

| # | 缺失/偏离 | 现状 | 需要做什么 |
|---|---|---|---|
| 1 | **数据模型不是 ST 原生** | `id`/`enabled`/`position: 'before_char'` 字符串联合 | 换成 `uid`/`disable`/`position: 0..7` 数字 + 全部 40 个原生字段（用户已拍板）。**这是不可后补的决策，P1 就必须落地** |
| 2 | **无 `WorldInfoBuffer`** | 调用方预先拼好一个扁平 `scanText` | 引入类：`#depthBuffer` / `#recurseBuffer` / `#injectBuffer` / `#globalScanData` + `\x01` MATCHER 连接符 + `#skew`/`advanceScan()` |
| 3 | **无 per-entry `scanDepth`** | 全局 `Settings.scanDepth` 由调用方切片 | `buffer.get(entry)` 内 `entry.scanDepth ?? this.getDepth()` |
| 4 | **无 `scan_state` 状态机** | `for (pass = 0..maxPasses)` | `while (scanState)` + `NONE/INITIAL/RECURSION/MIN_ACTIVATIONS` |
| 5 | **无 `min_activations` / `min_activations_depth_max`** | 无 | 第 5 步"下一状态决策"中的 `advanceScan()` 渐进扩窗 |
| 6 | **无 `max_recursion_steps`** | 有 `maxRecursion` 但语义是 pass 数 | 循环顶端 `if (maxRecursionSteps && maxRecursionSteps <= count) break`，`count` 计**所有**轮次 |
| 7 | **拒绝级联顺序错且不全** | 5 个检查，顺序随意 | 补 `triggers` / `characterFilter(names+tags)` / `decorators` / 外部激活 / `constant` / `无 key 跳过`，并**严格按 ST 顺序**（见 §1.6） |
| 8 | **`delayUntilRecursion` 语义错** | 当成 pass 序号 | 改成"等级队列"：`availableRecursionDelayLevels` 去重升序，每轮耗尽后 shift 一个 |
| 9 | **无 `matchXxx` 扫描源开关** | 只扫聊天窗口 | 6 个开关：persona/charDesc/charPersonality/charDepthPrompt/scenario/creatorNotes |
| 10 | **`matchKeys` 有偏差** | 正则识别用 `startsWith('/')` 启发式；多词 whole-word 未回退 substring；`caseSensitive`/`matchWholeWords` 是非空 boolean，丢失"继承全局"三态 | 用严格 `parseRegexFromString`；多词 needle 回退 `includes`；三态 `?? global` |
| 11 | **`parseRegexFromString` 的 `.replace('\\/','/')` bug** | 未实现该函数 | 实现并修成 `replaceAll`；同时去掉 `g` 标志使 `.test()` 无状态可缓存 |
| 12 | **包含组过滤太弱** | 只做一次、不支持逗号多组、无定时过滤、无评分、无"组已被激活" | 三阶段：`filterGroupsByTimedEffects` → `filterGroupsByScoring`(`getScore`) → 主选取（sticky/已激活/prio/加权随机），且**每轮循环都跑一次** |
| 13 | **无 sticky 优先候选排序** | 无 | `newEntries` 按 `isBSticky - isASticky \|\| indexOf(a) - indexOf(b)` |
| 14 | **预算走法错** | per-entry `used + t > budget` 判断，overflow 后仍继续 | ST 走法：`token_budget_overflowed` 闩锁 + `ignoresBudget` 倒计数器 + `>=` + 累积 `newContent` + 已激活文本计入 |
| 15 | **概率时机错** | 组过滤后统一 roll | 在预算循环内 roll，失败进 `failedProbabilityChecks`（后续轮次不再重试） |
| 16 | **输出桶顺序会反** | `sort(asc)` + `push` | 必须 `sort(desc by order)` + `unshift`（tie 顺序不同！） |
| 17 | **atDepth 未按 (depth, role) 合桶** | 每条一个注入 | 按 `(depth, role)` 合并，桶内 `unshift`，`'\n'` 连接 |
| 18 | **无 `outlet`(7) / `ignoreBudget` 完整语义 / `vectorized` / `automationId`** | 无 | outlet 分桶 + `{{outlet::name}}` 宏；vectorized/automationId 仅存储不参与逻辑 |
| 19 | **定时效果语义偏差**：`delay` 被当成"首次见到后 N 条"（有状态）；`sticky` 每次激活都续期；`cooldown` 只在 sticky 结束时装填；无 `hash`/`protected`/"聊天未推进则丢弃"规则；无 dryRun 保护 | | 全部按 ST：`delay` 无状态（`chatLength < entry.delay` 即压制）；`sticky` 已在跑则不重启；`cooldown` **激活当轮**就装填；sticky→cooldown 交接是 `protected` |
| 20 | **未深拷贝条目** | 直接用 store 里的对象 | 扫描过程会 `entry.content = substitute(entry.content)` 就地改写，必须 `structuredClone` |
| 21 | **无 `characterFilter` / `triggers` / `decorators`** | 无 | 全补 |
| 22 | **无插入策略** | 无 | `evenly/character_first/global_first` + chat lore/persona lore 恒定置前 |
| 23 | **token 计数硬编码** | 直接 import `estimateTokens` | 抽成 `TokenCounter` 接口注入 |

宏引擎差距：`sillyTavernTauri/src/services/prompt/macros.ts` 是**正则链**，无嵌套、无转义、无 `{{trim}}`、无卡片字段宏、无 `{{group}}`/`{{notChar}}`、`{{pick}}` 种子不含 offset。要整体重写为递归下降。

提示词差距：`builder.ts` 的深度注入是 `index = base.length - depth` 后一次性排序 splice，**没有 `totalInserted` 累加器**，多个不同 depth 同时注入时索引会串位；也没有 (depth, order, role) 合并规则、没有把注入预留进预算。要重写。

---

## 第 1 部分：世界书引擎

### 1.1 文件与职责

```
services/worldinfo/
  constants.ts     枚举 + 默认值（数值与 ST 逐字一致，保证零转换互通）
  entry.ts         createEntry / normalizeEntry / parseDecorators / hashEntry
  regex.ts         parseRegexFromString / escapeRegex / 正则缓存
  buffer.ts        WorldInfoBuffer
  timedEffects.ts  WorldInfoTimedEffects + TimedWorldInfo 持久化形状
  groups.ts        filterByInclusionGroups / ByScoring / ByTimedEffects
  sources.ts       resolveSortedEntries（书本来源合并 + 策略 + 深拷贝）
  buckets.ts       bucketActivatedEntries（position → 桶）
  engine.ts        checkWorldInfo（主循环）
  index.ts         barrel
```

### 1.2 `constants.ts` —— 数值必须逐字

```ts
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 } as const
export const WI_POSITION = {
  before: 0, after: 1, ANTop: 2, ANBottom: 3,
  atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7,
} as const
export const WI_ANCHOR = { before: 0, after: 1 } as const
export const SCAN_STATE = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 } as const
export const WI_STRATEGY = { evenly: 0, character_first: 1, global_first: 2 } as const
export const EXT_POSITION = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 } as const
export const EXT_ROLE = { SYSTEM: 0, USER: 1, ASSISTANT: 2 } as const

export const DEFAULT_DEPTH = 4
export const DEFAULT_WEIGHT = 100
export const DEFAULT_ORDER = 100
export const MAX_SCAN_DEPTH = 1000
export const MAX_UID = 1_000_000
export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'] as const
export const GENERATION_TRIGGERS = [
  'normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet',
] as const
export type GenerationTrigger = (typeof GENERATION_TRIGGERS)[number]

export interface WISettings {
  depth: number                   // 2
  minActivations: number          // 0
  minActivationsDepthMax: number  // 0
  budgetPercent: number           // 25
  budgetCap: number               // 0 = 无上限
  includeNames: boolean           // true
  recursive: boolean              // false
  caseSensitive: boolean          // false
  matchWholeWords: boolean        // false
  useGroupScoring: boolean        // false
  insertionStrategy: number       // 1 = character_first
  maxRecursionSteps: number       // 0
}

export function defaultWISettings(): WISettings {
  return {
    depth: 2, minActivations: 0, minActivationsDepthMax: 0,
    budgetPercent: 25, budgetCap: 0, includeNames: true, recursive: false,
    caseSensitive: false, matchWholeWords: false, useGroupScoring: false,
    insertionStrategy: WI_STRATEGY.character_first, maxRecursionSteps: 0,
  }
}
```

### 1.3 `types/worldinfo.ts` —— ST 原生 schema

```ts
export interface WICharacterFilter {
  isExclude: boolean
  names: string[]
  tags: string[]
}

/** 与 SillyTavern newWorldInfoEntryDefinition 一一对应。字段名/默认值不得改。
 *  三态字段（null = 继承全局）：scanDepth / caseSensitive / matchWholeWords /
 *  useGroupScoring / sticky / cooldown / delay —— null ≠ false ≠ 0。 */
export interface WIEntry {
  uid: number
  /** 装载时注入，不写进书文件。身份 = `${world}.${uid}` */
  world: string
  key: string[]
  keysecondary: string[]
  comment: string
  content: string
  constant: boolean
  vectorized: boolean
  selective: boolean
  selectiveLogic: number
  addMemo: boolean
  order: number
  position: number
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
  delayUntilRecursion: number | boolean
  probability: number
  useProbability: boolean
  depth: number
  outletName: string
  group: string
  groupOverride: boolean
  groupWeight: number
  scanDepth: number | null
  caseSensitive: boolean | null
  matchWholeWords: boolean | null
  useGroupScoring: boolean | null
  automationId: string
  role: number | null
  sticky: number | null
  cooldown: number | null
  delay: number | null
  characterFilter: WICharacterFilter
  triggers: string[]
  displayIndex: number
  /** 派生字段，扫描前计算，不持久化 */
  decorators: string[]
  hash: number
}

/** IndexedDB 一条记录 = 一本书。entries 用 ST 的 uid 键对象形式，方便零转换导入导出 */
export interface WIBook {
  id: string
  name: string
  /** 'global' | 'character' —— 本项目的分类（需求 5） */
  scope: 'global' | 'character'
  enabled: boolean
  entries: Record<string, WIEntry>
  updatedAt: number
}
```

### 1.4 `entry.ts`

```ts
import { DEFAULT_DEPTH, DEFAULT_WEIGHT, KNOWN_DECORATORS, MAX_UID, WI_LOGIC } from './constants'
import type { WIEntry } from '@/types/worldinfo'

/** 字段顺序即 hash 顺序，改动会让所有正在跑的 sticky/cooldown 失效 —— 不要重排 */
const FIELD_ORDER = [
  'uid', 'key', 'keysecondary', 'comment', 'content', 'constant', 'vectorized',
  'selective', 'selectiveLogic', 'addMemo', 'order', 'position', 'disable',
  'ignoreBudget', 'excludeRecursion', 'preventRecursion',
  'matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality',
  'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes',
  'delayUntilRecursion', 'probability', 'useProbability', 'depth', 'outletName',
  'group', 'groupOverride', 'groupWeight', 'scanDepth', 'caseSensitive',
  'matchWholeWords', 'useGroupScoring', 'automationId', 'role',
  'sticky', 'cooldown', 'delay', 'characterFilter', 'triggers', 'displayIndex',
] as const

export function defaultEntry(uid: number, world = ''): WIEntry {
  return {
    uid, world,
    key: [], keysecondary: [], comment: '', content: '',
    constant: false, vectorized: false, selective: true,
    selectiveLogic: WI_LOGIC.AND_ANY, addMemo: false,
    order: 100, position: 0, disable: false, ignoreBudget: false,
    excludeRecursion: false, preventRecursion: false,
    matchPersonaDescription: false, matchCharacterDescription: false,
    matchCharacterPersonality: false, matchCharacterDepthPrompt: false,
    matchScenario: false, matchCreatorNotes: false,
    delayUntilRecursion: 0, probability: 100, useProbability: true,
    depth: DEFAULT_DEPTH, outletName: '', group: '', groupOverride: false,
    groupWeight: DEFAULT_WEIGHT, scanDepth: null, caseSensitive: null,
    matchWholeWords: null, useGroupScoring: null, automationId: '', role: 0,
    sticky: null, cooldown: null, delay: null,
    characterFilter: { isExclude: false, names: [], tags: [] },
    triggers: [], displayIndex: uid, decorators: [], hash: 0,
  }
}

/** 最小未占用非负整数（与 ST 一致） */
export function getFreeUid(entries: Record<string, WIEntry>): number {
  for (let uid = 0; uid < MAX_UID; uid++) if (!(String(uid) in entries)) return uid
  return -1
}

/** 回填缺字段 + 强制类型，导入外部书/卡时必跑 */
export function normalizeEntry(raw: Partial<WIEntry>, uid: number, world: string): WIEntry {
  const base = defaultEntry(uid, world)
  const out = { ...base, ...raw, uid, world } as WIEntry
  out.key = Array.isArray(raw.key) ? raw.key.map(String) : []
  out.keysecondary = Array.isArray(raw.keysecondary) ? raw.keysecondary.map(String) : []
  out.triggers = Array.isArray(raw.triggers)
    ? raw.triggers.filter((v): v is string => GENERATION_TRIGGERS.includes(v as never))
    : []
  const cf = raw.characterFilter
  out.characterFilter = {
    isExclude: !!cf?.isExclude,
    names: Array.isArray(cf?.names) ? cf.names : [],
    tags: Array.isArray(cf?.tags) ? cf.tags : [],
  }
  out.displayIndex = typeof raw.displayIndex === 'number' ? raw.displayIndex : uid
  return out
}

/** ST parseDecorators 的逐字移植：剥离开头的 @@ 行 */
export function parseDecorators(content: string): [string[], string] {
  const isKnown = (line: string) => {
    const s = line.startsWith('@@@') ? line.substring(1) : line
    return KNOWN_DECORATORS.some((d) => s.startsWith(d))
  }
  if (!content.startsWith('@@')) return [[], content]

  let newContent = content
  const lines = content.split('\n')
  const decorators: string[] = []
  let fallbacked = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) break
    if (line.startsWith('@@')) {
      if (line.startsWith('@@@') && !fallbacked) continue
      if (isKnown(line)) {
        decorators.push(line.startsWith('@@@') ? line.substring(1) : line)
        fallbacked = false
      } else {
        fallbacked = true
      }
    } else {
      newContent = lines.slice(i).join('\n')
      break
    }
  }
  return [decorators, newContent]
}

/** ST getStringHash（cyrb53 变体），逐字移植 —— 定时效果身份键 */
export function getStringHash(str: string, seed = 0): number {
  if (typeof str !== 'string') return 0
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** 固定键序 stringify，避免不同来源对象键序不同导致 hash 漂移 */
export function hashEntry(entry: WIEntry): number {
  const stable: Record<string, unknown> = {}
  for (const k of FIELD_ORDER) stable[k] = (entry as Record<string, unknown>)[k]
  return getStringHash(JSON.stringify(stable))
}
```

### 1.5 `regex.ts`

```ts
export function escapeRegex(s: string): string {
  return s.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&')
}

const cache = new Map<string, RegExp | null>()
const CACHE_MAX = 512

/**
 * ST parseRegexFromString 移植，含两处修正：
 *  1) 上游 `.replace('\\/', '/')` 无 /g，只解转义第一个斜杠 —— 改成 replaceAll
 *  2) 去掉 g 标志：RegExp.test 在 g 下有 lastIndex 状态，而我们缓存了对象
 */
export function parseRegexFromString(input: string): RegExp | null {
  const cached = cache.get(input)
  if (cached !== undefined) return cached

  let result: RegExp | null = null
  const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/)
  if (match) {
    const pattern = match[1]
    const flags = match[2] ?? ''
    // 未转义的内部斜杠 => 当纯文本处理
    if (pattern !== undefined && !/(^|[^\\])\//.test(pattern)) {
      try {
        result = new RegExp(pattern.replaceAll('\\/', '/'), flags.replace(/g/g, ''))
      } catch {
        result = null
      }
    }
  }

  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(input, result)
  return result
}
```

### 1.6 `buffer.ts` —— `WorldInfoBuffer`

```ts
import { MAX_SCAN_DEPTH, SCAN_STATE, WI_LOGIC, type WISettings, type GenerationTrigger } from './constants'
import { escapeRegex, parseRegexFromString } from './regex'
import type { WIEntry } from '@/types/worldinfo'

export interface WIGlobalScanData {
  personaDescription: string
  characterDescription: string
  characterPersonality: string
  characterDepthPrompt: string
  scenario: string
  creatorNotes: string
  trigger: GenerationTrigger
}

/** \x01 是非单词字符，充当"合成词边界"：
 *  ① 每条消息开头/结尾都能整词匹配 ② 匹配不会跨消息边界 */
const MATCHER = '\x01'
const JOINER = '\n' + MATCHER

export class WorldInfoBuffer {
  #depthBuffer: string[] = []
  #recurseBuffer: string[] = []
  #injectBuffer: string[] = []
  #globalScanData: WIGlobalScanData
  #settings: WISettings
  #skew = 0
  #startDepth = 0
  #external: Map<string, WIEntry>

  constructor(
    messages: string[],
    globalScanData: WIGlobalScanData,
    settings: WISettings,
    external: Map<string, WIEntry> = new Map(),
  ) {
    this.#globalScanData = globalScanData
    this.#settings = settings
    this.#external = external
    this.#initDepthBuffer(messages)
  }

  #initDepthBuffer(messages: string[]) {
    for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
      const m = messages[depth]
      if (m !== undefined) this.#depthBuffer[depth] = m.trim()
      if (depth === messages.length - 1) break
    }
  }

  #transform(str: string, entry: WIEntry): string {
    const cs = entry.caseSensitive ?? this.#settings.caseSensitive
    return cs ? str : str.toLowerCase()
  }

  /** 组装本条目的 haystack。scanState 只影响"是否包含递归缓冲" */
  get(entry: WIEntry, scanState: number): string {
    let depth = entry.scanDepth ?? this.getDepth()
    if (depth <= this.#startDepth) return ''
    if (depth < 0) return ''
    if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH

    let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER)
    const g = this.#globalScanData
    if (entry.matchPersonaDescription && g.personaDescription) result += JOINER + g.personaDescription
    if (entry.matchCharacterDescription && g.characterDescription) result += JOINER + g.characterDescription
    if (entry.matchCharacterPersonality && g.characterPersonality) result += JOINER + g.characterPersonality
    if (entry.matchCharacterDepthPrompt && g.characterDepthPrompt) result += JOINER + g.characterDepthPrompt
    if (entry.matchScenario && g.scenario) result += JOINER + g.scenario
    if (entry.matchCreatorNotes && g.creatorNotes) result += JOINER + g.creatorNotes

    if (this.#injectBuffer.length > 0) result += JOINER + this.#injectBuffer.join(JOINER)
    // MIN_ACTIVATIONS 扩窗时故意排除递归缓冲，否则"只靠递归文本"的条目会被反复触发
    if (this.#recurseBuffer.length > 0 && scanState !== SCAN_STATE.MIN_ACTIVATIONS) {
      result += JOINER + this.#recurseBuffer.join(JOINER)
    }
    return result
  }

  matchKeys(haystack: string, needle: string, entry: WIEntry): boolean {
    // 正则 key 覆盖大小写/整词全部设置
    const keyRegex = parseRegexFromString(needle)
    if (keyRegex) return keyRegex.test(haystack)

    const hay = this.#transform(haystack, entry)
    const nee = this.#transform(needle, entry)
    const whole = entry.matchWholeWords ?? this.#settings.matchWholeWords

    if (whole) {
      // 多词短语无法整词匹配，回退子串（与 ST 一致）
      if (nee.split(/\s+/).length > 1) return hay.includes(nee)
      return new RegExp(`(?:^|\\W)(${escapeRegex(nee)})(?:$|\\W)`).test(hay)
    }
    return hay.includes(nee)
  }

  /** 包含组内评分：命中的主键数（+ 正向逻辑下的副键数） */
  getScore(entry: WIEntry, scanState: number): number {
    const state = this.get(entry, scanState)
    let nPrimary = 0
    let nSecondary = 0
    let primary = 0
    let secondary = 0
    if (Array.isArray(entry.key)) {
      nPrimary = entry.key.length
      for (const k of entry.key) if (this.matchKeys(state, k, entry)) primary++
    }
    if (Array.isArray(entry.keysecondary)) {
      nSecondary = entry.keysecondary.length
      for (const k of entry.keysecondary) if (this.matchKeys(state, k, entry)) secondary++
    }
    if (!nPrimary) return 0
    if (nSecondary > 0) {
      if (entry.selectiveLogic === WI_LOGIC.AND_ANY) return primary + secondary
      if (entry.selectiveLogic === WI_LOGIC.AND_ALL) {
        return secondary === nSecondary ? primary + secondary : primary
      }
    }
    return primary
  }

  addRecurse(m: string) { this.#recurseBuffer.push(m) }
  addInject(m: string) { this.#injectBuffer.push(m) }
  hasRecurse() { return this.#recurseBuffer.length > 0 }
  advanceScan() { this.#skew++ }
  getDepth() { return this.#settings.depth + this.#skew }
  getExternallyActivated(entry: WIEntry) { return this.#external.get(`${entry.world}.${entry.uid}`) }
  resetExternalEffects() { this.#external.clear() }
}
```

### 1.7 `timedEffects.ts`

**持久化替代方案**：ST 存在 `chat_metadata.timedWorldInfo`。本项目存在 IndexedDB 的 `chats` 对象仓库里，作为 `ChatMeta.timedWorldInfo`（分支聊天时随 meta 一起 `structuredClone`）。`delay` 无状态，不持久化。

**"消息数"时钟统一口径**：`chatLength = 参与提示词的非系统消息条数`（与构建 `chatForWI` 的那份数组等长）。`start`/`end`/`delay` 三处必须用同一个数，否则效果永不过期。

```ts
import type { WIEntry } from '@/types/worldinfo'

export interface WITimedEffect {
  hash: number
  start: number
  end: number
  /** 受保护的效果在"聊天未推进"时不会被清除（sticky→cooldown 交接用） */
  protected: boolean
}
export interface TimedWorldInfo {
  sticky: Record<string, WITimedEffect>
  cooldown: Record<string, WITimedEffect>
}
export type TimedEffectType = 'sticky' | 'cooldown' | 'delay'

export function emptyTimedWorldInfo(): TimedWorldInfo {
  return { sticky: {}, cooldown: {} }
}

export class WorldInfoTimedEffects {
  #chatLength: number
  #entries: WIEntry[]
  #isDryRun: boolean
  #store: TimedWorldInfo
  #buffer: Record<TimedEffectType, WIEntry[]> = { sticky: [], cooldown: [], delay: [] }

  constructor(chatLength: number, entries: WIEntry[], isDryRun: boolean, store: TimedWorldInfo) {
    this.#chatLength = chatLength
    this.#entries = entries
    this.#isDryRun = isDryRun
    this.#store = store
    if (!store.sticky || typeof store.sticky !== 'object') store.sticky = {}
    if (!store.cooldown || typeof store.cooldown !== 'object') store.cooldown = {}
  }

  #key(e: WIEntry) { return `${e.world}.${e.uid}` }

  #make(type: 'sticky' | 'cooldown', e: WIEntry, isProtected: boolean): WITimedEffect {
    return {
      hash: e.hash,
      start: this.#chatLength,
      end: this.#chatLength + Number(e[type]),
      protected: isProtected,
    }
  }

  /** dryRun 下 sticky/cooldown 完全不评估（也就不会推进状态），delay 始终评估 */
  checkTimedEffects() {
    if (!this.#isDryRun) {
      this.#checkOfType('sticky', this.#buffer.sticky, (e) => this.#onStickyEnded(e))
      this.#checkOfType('cooldown', this.#buffer.cooldown, () => {})
    }
    this.#checkDelay(this.#buffer.delay)
  }

  #checkOfType(type: 'sticky' | 'cooldown', buf: WIEntry[], onEnded: (e: WIEntry) => void) {
    const records = this.#store[type]
    for (const [key, value] of Object.entries(records)) {
      const entry = this.#entries.find((x) => String(x.hash) === String(value.hash))
      // ① 聊天未推进（重roll/swipe）=> 丢弃，除非受保护
      if (this.#chatLength <= Number(value.start) && !value.protected) { delete records[key]; continue }
      // ② 条目已不存在（换了角色书）=> 到期后丢弃
      if (!entry) { if (this.#chatLength >= Number(value.end)) delete records[key]; continue }
      // ③ 条目已不再配置该效果 => 丢弃
      if (!entry[type]) { delete records[key]; continue }
      // ④ 到期 => 丢弃 + 触发 onEnded
      if (this.#chatLength >= Number(value.end)) { delete records[key]; onEnded(entry); continue }
      // ⑤ 仍在生效
      buf.push(entry)
    }
  }

  /** sticky 结束的瞬间立刻起一个"受保护"的 cooldown，并对本次扫描即时生效 */
  #onStickyEnded(entry: WIEntry) {
    if (!entry.cooldown) return
    this.#store.cooldown[this.#key(entry)] = this.#make('cooldown', entry, true)
    this.#buffer.cooldown.push(entry)
  }

  /** delay 无状态：聊天长度不足 N 就压制 */
  #checkDelay(buf: WIEntry[]) {
    for (const entry of this.#entries) {
      if (!entry.delay) continue
      if (this.#chatLength < entry.delay) buf.push(entry)
    }
  }

  isEffectActive(type: TimedEffectType, entry: WIEntry): boolean {
    return this.#buffer[type].some((x) => x.hash === entry.hash)
  }

  /** 注意：有 cooldown 的条目在"激活当轮"就开始冷却，而不是停止触发之后 */
  setTimedEffects(activated: WIEntry[]) {
    if (this.#isDryRun) return
    for (const e of activated) { this.#set('sticky', e); this.#set('cooldown', e) }
  }

  #set(type: 'sticky' | 'cooldown', entry: WIEntry) {
    if (!entry[type]) return
    const key = this.#key(entry)
    // 已在运行的效果不重启（这一点现有移植做反了）
    if (!this.#store[type][key]) this.#store[type][key] = this.#make(type, entry, false)
  }
}
```

### 1.8 `groups.ts` —— 包含组

```ts
import { DEFAULT_WEIGHT, type WISettings } from './constants'
import type { WorldInfoBuffer } from './buffer'
import type { WorldInfoTimedEffects } from './timedEffects'
import type { WIEntry } from '@/types/worldinfo'

const sortFn = (a: WIEntry, b: WIEntry) => b.order - a.order

/** 就地修改 newEntries */
export function filterByInclusionGroups(
  newEntries: WIEntry[],
  allActivatedEntries: Map<string, WIEntry>,
  buffer: WorldInfoBuffer,
  scanState: number,
  timedEffects: WorldInfoTimedEffects,
  settings: WISettings,
): void {
  // 一个条目可属于多个组（逗号分隔）
  const grouped: Record<string, WIEntry[]> = {}
  for (const item of newEntries) {
    if (!item.group) continue
    for (const g of item.group.split(/,\s*/).filter(Boolean)) {
      const list = grouped[g]
      if (list) list.push(item)
      else grouped[g] = [item]
    }
  }
  if (Object.keys(grouped).length === 0) return

  const removeEntry = (entry: WIEntry) => {
    const i = newEntries.indexOf(entry)
    if (i !== -1) newEntries.splice(i, 1)
  }
  const removeAllBut = (group: WIEntry[], chosen: WIEntry | null) => {
    for (const e of group) if (e !== chosen) removeEntry(e)
  }

  const hasStickyMap = filterGroupsByTimedEffects(grouped, timedEffects, removeEntry)
  filterGroupsByScoring(grouped, buffer, removeEntry, scanState, hasStickyMap, settings)

  for (const [key, group] of Object.entries(grouped)) {
    if (hasStickyMap.get(key)) continue
    // NOTE: 与 ST 一致用整串比较（多组条目会漏过此判断）。刻意保留以对齐上游。
    if ([...allActivatedEntries.values()].some((x) => x.group === key)) {
      removeAllBut(group, null)
      continue
    }
    if (group.length <= 1) continue

    const prios = group.filter((x) => x.groupOverride).sort(sortFn)
    const prio = prios[0]
    if (prio) { removeAllBut(group, prio); continue }

    const totalWeight = group.reduce((acc, i) => acc + (i.groupWeight ?? DEFAULT_WEIGHT), 0)
    const rollValue = Math.random() * totalWeight
    let currentWeight = 0
    let winner: WIEntry | null = null
    for (const entry of group) {
      currentWeight += entry.groupWeight ?? DEFAULT_WEIGHT
      if (rollValue <= currentWeight) { winner = entry; break }
    }
    if (!winner) continue
    removeAllBut(group, winner)
  }
}

function filterGroupsByTimedEffects(
  groups: Record<string, WIEntry[]>,
  timedEffects: WorldInfoTimedEffects,
  removeEntry: (e: WIEntry) => void,
): Map<string, boolean> {
  const hasStickyMap = new Map<string, boolean>()
  for (const [key, group] of Object.entries(groups)) {
    hasStickyMap.set(key, false)
    const stickyEntries = group.filter((x) => timedEffects.isEffectActive('sticky', x))
    if (stickyEntries.length) {
      // 注意：所有 sticky 成员都保留，不收敛成一个
      for (const e of group) if (!stickyEntries.includes(e)) removeEntry(e)
      hasStickyMap.set(key, true)
    }
    for (const e of group) if (timedEffects.isEffectActive('cooldown', e)) removeEntry(e)
    for (const e of group) if (timedEffects.isEffectActive('delay', e)) removeEntry(e)
  }
  return hasStickyMap
}

function filterGroupsByScoring(
  groups: Record<string, WIEntry[]>,
  buffer: WorldInfoBuffer,
  removeEntry: (e: WIEntry) => void,
  scanState: number,
  hasStickyMap: Map<string, boolean>,
  settings: WISettings,
): void {
  for (const [key, group] of Object.entries(groups)) {
    if (!settings.useGroupScoring && !group.some((x) => x.useGroupScoring)) continue
    if (hasStickyMap.get(key)) continue

    const scores = group.map((e) => buffer.getScore(e, scanState))
    const maxScore = Math.max(...scores)
    for (let i = 0; i < group.length; i++) {
      const member = group[i]
      const score = scores[i]
      if (member === undefined || score === undefined) continue
      // 三态：true 强制参评、false 豁免、null 跟随全局
      const isScored = member.useGroupScoring ?? settings.useGroupScoring
      if (!isScored) continue
      if (score < maxScore) {
        removeEntry(member)
        group.splice(i, 1)
        scores.splice(i, 1)
        i--
      }
    }
  }
}
```

### 1.9 `sources.ts`

```ts
import { WI_STRATEGY } from './constants'
import { hashEntry, parseDecorators } from './entry'
import type { WIEntry } from '@/types/worldinfo'

export interface LoreSources {
  /** 全局配置里启用的全局世界书（需求 5） */
  global: WIEntry[]
  /** 当前角色（1vN 时为所有参与角色）的角色世界书并集 */
  character: WIEntry[]
  /** 本会话专属（v1 可为空数组） */
  chat: WIEntry[]
  /** 用户人设绑定（v1 可为空数组） */
  persona: WIEntry[]
}

const sortFn = (a: WIEntry, b: WIEntry) => b.order - a.order

/**
 * 优先级 = chat > persona > (策略决定的 global/character 交错)，块内 order 降序。
 * 这个顺序既是预算消耗顺序，也是溢出时的存活优先级。
 * 调用方（store）需先按书名去重，去重优先级同上。
 */
export function resolveSortedEntries(src: LoreSources, strategy: number): WIEntry[] {
  let entries: WIEntry[]
  switch (strategy) {
    case WI_STRATEGY.evenly:
      entries = [...src.global, ...src.character].sort(sortFn)
      break
    case WI_STRATEGY.global_first:
      entries = [...[...src.global].sort(sortFn), ...[...src.character].sort(sortFn)]
      break
    case WI_STRATEGY.character_first:
    default:
      entries = [...[...src.character].sort(sortFn), ...[...src.global].sort(sortFn)]
      break
  }
  entries = [...[...src.chat].sort(sortFn), ...[...src.persona].sort(sortFn), ...entries]

  // 先剥 decorators，再算 hash（顺序与 ST 一致，保证 hash 值可比）
  const withDecorators = entries.map((e) => {
    const [decorators, content] = parseDecorators(e.content)
    return { ...e, decorators, content }
  })
  // 深拷贝：扫描期间会就地把 content 替换成宏展开结果
  return withDecorators.map((e) => structuredClone({ ...e, hash: hashEntry(e) }))
}
```

### 1.10 `buckets.ts`

```ts
import { DEFAULT_DEPTH, EXT_ROLE, WI_ANCHOR, WI_POSITION } from './constants'
import type { WIEntry } from '@/types/worldinfo'

export interface WIDepthBucket { depth: number; role: number; entries: string[] }
export interface WIBuckets {
  worldInfoBefore: string
  worldInfoAfter: string
  emEntries: { position: number; content: string }[]
  anTop: string[]
  anBottom: string[]
  depthEntries: WIDepthBucket[]
  outletEntries: Record<string, string[]>
}

/**
 * 关键约定：按 order **降序**遍历 + **unshift**，桶内最终为 order 升序
 * （低 order 在前 / 高 order 贴近角色定义）。
 * 绝不能改写成 "升序 sort + push"：相同 order 的并列条目顺序会反过来。
 */
export function bucketActivatedEntries(entries: WIEntry[]): WIBuckets {
  const before: string[] = []
  const after: string[] = []
  const em: { position: number; content: string }[] = []
  const anTop: string[] = []
  const anBottom: string[] = []
  const depthEntries: WIDepthBucket[] = []
  const outletEntries: Record<string, string[]> = {}

  for (const entry of [...entries].sort((a, b) => b.order - a.order)) {
    const content = entry.content
    if (!content) continue
    switch (entry.position) {
      case WI_POSITION.before: before.unshift(content); break
      case WI_POSITION.after: after.unshift(content); break
      case WI_POSITION.EMTop: em.unshift({ position: WI_ANCHOR.before, content }); break
      case WI_POSITION.EMBottom: em.unshift({ position: WI_ANCHOR.after, content }); break
      case WI_POSITION.ANTop: anTop.unshift(content); break
      case WI_POSITION.ANBottom: anBottom.unshift(content); break
      case WI_POSITION.atDepth: {
        const d = entry.depth ?? DEFAULT_DEPTH
        const r = entry.role ?? EXT_ROLE.SYSTEM
        const found = depthEntries.find((e) => e.depth === d && e.role === r)
        if (found) found.entries.unshift(content)
        // BUGFIX: ST 这里 push 的是未归一化的 entry.depth，undefined 会变 NaN
        else depthEntries.push({ depth: d, role: r, entries: [content] })
        break
      }
      case WI_POSITION.outlet: {
        if (!entry.outletName) break
        const list = outletEntries[entry.outletName]
        // 保留 ST 的 push（唯一不 unshift 的桶）以对齐上游行为
        if (list) list.push(content)
        else outletEntries[entry.outletName] = [content]
        break
      }
      default: break
    }
  }

  return {
    worldInfoBefore: before.length ? before.join('\n') : '',
    worldInfoAfter: after.length ? after.join('\n') : '',
    emEntries: em, anTop, anBottom, depthEntries, outletEntries,
  }
}
```

### 1.11 `engine.ts` —— `checkWorldInfo` 主循环

```ts
import { SCAN_STATE, WI_LOGIC, type GenerationTrigger, type WISettings } from './constants'
import { WorldInfoBuffer, type WIGlobalScanData } from './buffer'
import { WorldInfoTimedEffects, type TimedWorldInfo } from './timedEffects'
import { filterByInclusionGroups } from './groups'
import { bucketActivatedEntries, type WIBuckets } from './buckets'
import type { WIEntry } from '@/types/worldinfo'

export interface WIScanInput {
  /** 新→旧倒序的消息文本（includeNames 时已是 `Name: mes`） */
  chat: string[]
  /** 定时效果时钟：参与提示词的非系统消息条数 */
  chatLength: number
  maxContext: number
  isDryRun: boolean
  globalScanData: WIGlobalScanData
  /** resolveSortedEntries 的产物（已深拷贝） */
  sortedEntries: WIEntry[]
  settings: WISettings
  /** 就地修改；dryRun 时调用方需传 structuredClone 的副本 */
  timedStore: TimedWorldInfo
  /** scan:true 的注入文本（作者注释/约束提示词等，若允许被 WI 扫描） */
  injects: string[]
  countTokens: (text: string) => number
  substitute: (text: string) => string
  characterName?: string
  characterTags?: string[]
  externalActivations?: Map<string, WIEntry>
}

export type WIScanResult = WIBuckets & { allActivatedEntries: WIEntry[] }

const emptyResult = (): WIScanResult => ({
  worldInfoBefore: '', worldInfoAfter: '', emEntries: [], anTop: [], anBottom: [],
  depthEntries: [], outletEntries: {}, allActivatedEntries: [],
})

const entryId = (e: WIEntry) => `${e.world}.${e.uid}`

export function checkWorldInfo(input: WIScanInput): WIScanResult {
  const {
    chat, chatLength, maxContext, isDryRun, globalScanData,
    sortedEntries, settings, timedStore, injects, countTokens, substitute,
  } = input

  const buffer = new WorldInfoBuffer(chat, globalScanData, settings, input.externalActivations)
  for (const inj of injects) if (inj) buffer.addInject(inj)

  let scanState: number = SCAN_STATE.INITIAL
  let tokenBudgetOverflowed = false
  let count = 0
  const allActivatedEntries = new Map<string, WIEntry>()
  const failedProbabilityChecks = new Set<WIEntry>()
  let allActivatedText = ''

  let budget = Math.round((settings.budgetPercent * maxContext) / 100) || 1
  if (settings.budgetCap > 0 && budget > settings.budgetCap) budget = settings.budgetCap

  const timedEffects = new WorldInfoTimedEffects(chatLength, sortedEntries, isDryRun, timedStore)
  timedEffects.checkTimedEffects()

  if (sortedEntries.length === 0) return emptyResult()

  // sortedEntries.indexOf 在比较器里是 O(n)，预先建索引
  const orderIndex = new Map<WIEntry, number>()
  sortedEntries.forEach((e, i) => orderIndex.set(e, i))
  const idxOf = (e: WIEntry) => orderIndex.get(e) ?? -1

  const availableRecursionDelayLevels = [
    ...new Set(
      sortedEntries
        .filter((e) => e.delayUntilRecursion)
        .map((e) => (e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion))),
    ),
  ].sort((a, b) => a - b)
  let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0

  while (scanState) {
    // 注意：maxRecursionSteps 非零时 minActivations 事实上被禁用，反之亦然
    if (settings.maxRecursionSteps && settings.maxRecursionSteps <= count) break
    count++

    let nextScanState: number = SCAN_STATE.NONE
    const activatedNow = new Set<WIEntry>()

    // ===== 第 1 步：候选筛选。以下 16 步的顺序是有语义的，禁止重排 =====
    for (const entry of sortedEntries) {
      // 1 已处理/已激活
      if (failedProbabilityChecks.has(entry) || allActivatedEntries.has(entryId(entry))) continue
      // 2 禁用
      if (entry.disable === true) continue
      // 3 生成类型过滤
      if (entry.triggers.length > 0 && !entry.triggers.includes(globalScanData.trigger)) continue
      // 4 角色名过滤
      if (entry.characterFilter.names.length > 0) {
        const included = input.characterName !== undefined
          && entry.characterFilter.names.includes(input.characterName)
        if (entry.characterFilter.isExclude ? included : !included) continue
      }
      // 5 角色标签过滤
      if (entry.characterFilter.tags.length > 0) {
        const tags = input.characterTags ?? []
        const included = tags.some((t) => entry.characterFilter.tags.includes(t))
        if (entry.characterFilter.isExclude ? included : !included) continue
      }

      const isSticky = timedEffects.isEffectActive('sticky', entry)
      const isCooldown = timedEffects.isEffectActive('cooldown', entry)
      const isDelay = timedEffects.isEffectActive('delay', entry)

      // 6 delay 优先级最高，压过 sticky 与 constant
      if (isDelay) continue
      // 7 sticky 压过 cooldown
      if (isCooldown && !isSticky) continue
      // 8 非递归轮里的 delayUntilRecursion
      if (scanState !== SCAN_STATE.RECURSION && entry.delayUntilRecursion && !isSticky) continue
      // 9 递归轮但等级未到
      if (
        scanState === SCAN_STATE.RECURSION && entry.delayUntilRecursion
        && Number(entry.delayUntilRecursion) > currentRecursionDelayLevel && !isSticky
      ) continue
      // 10 递归轮里的 excludeRecursion
      if (scanState === SCAN_STATE.RECURSION && settings.recursive && entry.excludeRecursion && !isSticky) continue

      // ---- 正向短路 ----
      // 11 / 12 装饰器
      if (entry.decorators.includes('@@activate')) { activatedNow.add(entry); continue }
      if (entry.decorators.includes('@@dont_activate')) continue
      // 13 外部强制激活（注意加入的是外部那份对象）
      const external = buffer.getExternallyActivated(entry)
      if (external) { activatedNow.add(external); continue }
      // 14 常驻
      if (entry.constant) { activatedNow.add(entry); continue }
      // 15 sticky 无需关键词
      if (isSticky) { activatedNow.add(entry); continue }
      // 16 无主键 => 只能靠上面的路径激活
      if (!Array.isArray(entry.key) || !entry.key.length) continue

      // ---- 关键词扫描 ----
      const textToScan = buffer.get(entry, scanState)
      const primaryKeyMatch = entry.key.find((k) => {
        const s = substitute(k)
        return !!s && buffer.matchKeys(textToScan, s.trim(), entry)
      })
      if (!primaryKeyMatch) continue

      const hasSecondary = entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0
      if (!hasSecondary) { activatedNow.add(entry); continue }
      if (matchSecondaryKeys(buffer, textToScan, entry, substitute)) activatedNow.add(entry)
    }

    // ===== 第 2 步：候选排序（sticky 优先，其次原优先级序） =====
    const newEntries = [...activatedNow].sort((a, b) => {
      const sa = timedEffects.isEffectActive('sticky', a) ? 1 : 0
      const sb = timedEffects.isEffectActive('sticky', b) ? 1 : 0
      return sb - sa || idxOf(a) - idxOf(b)
    })

    let newContent = ''
    const textToScanTokens = countTokens(allActivatedText)

    // ===== 第 3 步：包含组过滤（就地删元素） =====
    filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects, settings)

    // ===== 第 4 步：概率 + 预算 =====
    let ignoresBudget = newEntries.filter((e) => e.ignoreBudget).length
    for (const entry of newEntries) {
      ignoresBudget -= entry.ignoreBudget ? 1 : 0
      if (tokenBudgetOverflowed && !entry.ignoreBudget) {
        // 后面还有 ignoreBudget 条目就继续走，否则直接停
        if (ignoresBudget > 0) continue
        break
      }

      if (!verifyProbability(entry, timedEffects, failedProbabilityChecks)) continue

      // 宏就地展开，之后的分桶直接用这份 content
      entry.content = substitute(entry.content)
      newContent += `${entry.content}\n`

      // 注意是 >=，且计入之前轮次已激活的文本
      if (!entry.ignoreBudget && textToScanTokens + countTokens(newContent) >= budget) {
        tokenBudgetOverflowed = true
        continue // 本条被丢弃，但它已经进了 newContent，仍会挤压后面的条目
      }
      allActivatedEntries.set(entryId(entry), entry)
    }

    // ===== 第 5 步：下一状态 =====
    const successfulNewEntries = newEntries.filter((x) => !failedProbabilityChecks.has(x))
    const forRecursion = successfulNewEntries.filter((x) => !x.preventRecursion)

    if (settings.recursive && !tokenBudgetOverflowed && forRecursion.length) {
      nextScanState = SCAN_STATE.RECURSION
    }
    if (
      settings.recursive && !tokenBudgetOverflowed
      && scanState === SCAN_STATE.MIN_ACTIVATIONS && buffer.hasRecurse()
    ) {
      nextScanState = SCAN_STATE.RECURSION
    }

    const minNotSatisfied = settings.minActivations > 0
      && allActivatedEntries.size < settings.minActivations
    if (!nextScanState && !tokenBudgetOverflowed && minNotSatisfied) {
      const overMax =
        (settings.minActivationsDepthMax > 0 && buffer.getDepth() > settings.minActivationsDepthMax)
        || buffer.getDepth() > chat.length
      if (!overMax) { nextScanState = SCAN_STATE.MIN_ACTIVATIONS; buffer.advanceScan() }
    }

    if (nextScanState === SCAN_STATE.NONE && availableRecursionDelayLevels.length) {
      nextScanState = SCAN_STATE.RECURSION
      currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0
    }

    // ===== 第 6 步：扩展递归缓冲 =====
    scanState = nextScanState
    if (scanState) {
      const text = forRecursion.map((x) => x.content).join('\n')
      if (text) {
        buffer.addRecurse(text)
        allActivatedText = text + '\n' + allActivatedText
      }
    }
  }

  const activated = [...allActivatedEntries.values()]
  const buckets = bucketActivatedEntries(activated)
  timedEffects.setTimedEffects(activated)
  buffer.resetExternalEffects()
  return { ...buckets, allActivatedEntries: activated }
}

function verifyProbability(
  entry: WIEntry,
  timedEffects: WorldInfoTimedEffects,
  failed: Set<WIEntry>,
): boolean {
  if (!entry.useProbability || entry.probability === 100) return true
  if (timedEffects.isEffectActive('sticky', entry)) return true // sticky 不重 roll
  if (Math.random() * 100 <= entry.probability) return true
  failed.add(entry)
  return false
}

function matchSecondaryKeys(
  buffer: WorldInfoBuffer,
  textToScan: string,
  entry: WIEntry,
  substitute: (s: string) => string,
): boolean {
  const logic = entry.selectiveLogic ?? WI_LOGIC.AND_ANY
  let hasAnyMatch = false
  let hasAllMatch = true
  for (const raw of entry.keysecondary) {
    const s = substitute(raw)
    const hit = !!s && buffer.matchKeys(textToScan, s.trim(), entry)
    if (hit) hasAnyMatch = true
    else hasAllMatch = false
    if (logic === WI_LOGIC.AND_ANY && hit) return true
    if (logic === WI_LOGIC.NOT_ALL && !hit) return true
  }
  if (logic === WI_LOGIC.NOT_ANY && !hasAnyMatch) return true
  if (logic === WI_LOGIC.AND_ALL && hasAllMatch) return true
  return false
}
```

### 1.12 token 计数策略

**决策：P1~P3 用同步启发式估算，接口化以便后换真 tokenizer。** 理由：ST 每条目每轮 `await getTokenCountAsync`（服务端往返）；本项目纯 Web 无后端，引入 `gpt-tokenizer`（~2 MB）或 `js-tiktoken` + wasm 会显著拖慢首屏，而世界书预算本质是"粗筛"。同步化还让整个 `checkWorldInfo` 无 `async`，Pinia action 里调用干净。

```ts
// services/tokens.ts
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/g

/** CJK 一字≈1 token，其余 4 字符≈1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = text.match(CJK_RE)?.length ?? 0
  return Math.ceil(cjk + (text.length - cjk) / 4)
}

export type TokenCounter = (text: string) => number

/** 每条 OpenAI 消息的固定开销（role/分隔符），用于最终装配预算 */
export const PER_MESSAGE_OVERHEAD = 4

export function countMessages(msgs: { content: string }[], count: TokenCounter): number {
  return msgs.reduce((sum, m) => sum + count(m.content) + PER_MESSAGE_OVERHEAD, 0)
}
```

设置页留一个"精确 token 计数（体积更大）"开关，后续接入 `js-tiktoken` 时只需替换传入的 `TokenCounter`。

---

## 第 2 部分：宏引擎

### 2.1 设计原则

- **递归下降、内层优先**：遇到 `{{` 找配对 `}}`（计数嵌套），先递归求值内层文本，再把结果当作 `name::args` 分派。`{{if {{getvar::x}}}}`、`{{random::{{char}}::{{user}}}}` 天然可用。
- **fail-open**：未知宏 → 原样返回 `{{已展开的内层}}`；handler 抛异常 → 警告 + 返回原文。**永远不让坏卡片打断生成**。
- **handler 输出不再被扫描**：杜绝死循环，也让 `{{trim}}` 能靠 handler 返回标记 + 后处理吃掉。
- **`\{` / `\}` 转义**：扫描时跳过，后处理还原。
- 大约 110 行核心 + 一张注册表。**不引入 chevrotain，不用正则数组。**

### 2.2 `services/macro/engine.ts`

```ts
import { MACROS, type MacroCallCtx } from './registry'
import type { MacroEnv } from './env'

export function evaluateMacros(input: string, env: MacroEnv): string {
  if (!input) return ''
  const pre = preProcess(input)
  const walked = walk(pre, env, 0)
  return postProcess(walked)
}

/** 老式尖括号标记与老式时区语法 */
function preProcess(text: string): string {
  return text
    .replace(/\{\{time_(UTC[+-]\d+)\}\}/gi, (_m, off: string) => `{{time::${off}}}`)
    .replace(/<USER>/gi, '{{user}}')
    .replace(/<BOT>/gi, '{{char}}')
    .replace(/<CHAR>/gi, '{{char}}')
    .replace(/<GROUP>/gi, '{{group}}')
    .replace(/<CHARIFNOTGROUP>/gi, '{{group}}')
}

function postProcess(text: string): string {
  return text
    .replace(/\\([{}])/g, '$1')                        // \{ -> {
    .replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '') // {{trim}} 连同前后换行一起吃掉
}

function walk(text: string, env: MacroEnv, baseOffset: number): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === undefined) break
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === '{' || next === '}') { out += ch + next; i += 2; continue }
      out += ch
      i++
      continue
    }
    if (ch === '{' && text[i + 1] === '{') {
      const end = findClosing(text, i)
      if (end === -1) { out += text.slice(i); break } // 未闭合，原样输出
      const inner = text.slice(i + 2, end)
      const resolvedInner = walk(inner, env, baseOffset + i + 2) // 内层优先
      out += applyMacro(resolvedInner, env, baseOffset + i)
      i = end + 2
      continue
    }
    out += ch
    i++
  }
  return out
}

/** 返回配对 `}}` 的第一个 `}` 的下标，找不到返回 -1 */
function findClosing(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '{' && text[i + 1] === '{') { depth++; i++; continue }
    if (text[i] === '}' && text[i + 1] === '}') {
      depth--
      i++
      if (depth === 0) return i - 1
    }
  }
  return -1
}

const IDENT_RE = /^[A-Za-z][\w-]*$/

function splitMacro(inner: string): { name: string; args: string[] } | null {
  const trimmed = inner.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('//')) return { name: '//', args: [trimmed.slice(2)] }

  const dd = trimmed.indexOf('::')
  let head: string
  let rest: string
  if (dd !== -1) {
    head = trimmed.slice(0, dd)
    rest = trimmed.slice(dd + 2)
  } else {
    // 兼容老写法 {{random:a,b}} / {{datetimeformat YYYY-MM-DD}}
    const m = trimmed.match(/^([A-Za-z][\w-]*)[\s:]([\s\S]*)$/)
    if (m && m[1] !== undefined && m[2] !== undefined) { head = m[1]; rest = m[2] }
    else { head = trimmed; rest = '' }
  }
  head = head.trim()
  if (!IDENT_RE.test(head)) return null
  return { name: head, args: rest === '' ? [] : rest.split('::') }
}

function applyMacro(inner: string, env: MacroEnv, offset: number): string {
  const parts = splitMacro(inner)
  if (!parts) return `{{${inner}}}`
  const def = MACROS.get(parts.name.toLowerCase())
  if (!def) return `{{${inner}}}` // 未知宏原样保留（内层已展开）
  const ctx: MacroCallCtx = { args: parts.args, env, offset, raw: inner }
  try {
    return normalize(def(ctx))
  } catch (e) {
    console.warn('[macro] handler failed:', inner, e)
    return `{{${inner}}}`
  }
}

function normalize(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
```

### 2.3 `services/macro/env.ts` —— `MacroEnv`

```ts
export interface MacroCardFields {
  description: string
  personality: string
  scenario: string
  mesExample: string
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  characterVersion: string
  depthPrompt: string
  firstMes: string
  alternateGreetings: string[]
}

export interface MacroVarsApi {
  getLocal(name: string): string
  setLocal(name: string, value: string): void
  hasLocal(name: string): boolean
  delLocal(name: string): void
  getGlobal(name: string): string
  setGlobal(name: string, value: string): void
  hasGlobal(name: string): boolean
  delGlobal(name: string): void
}

export interface MacroEnv {
  /** 用户名（人设名） */
  user: string
  /** 1v1 = 角色名；**1vN = 本轮当前发言者**；生成之外为 '' */
  char: string
  /** 全体成员名（含静音），1v1 = [char] */
  groupMembers: string[]
  /** 静音成员名 */
  mutedMembers: string[]
  /** 当前发言者的卡片字段（1vN SWAP 语义） */
  card: MacroCardFields
  persona: string
  /** 已渲染的关系图谱文本（1vN），供 {{relations}} */
  relations: string
  chatId: string
  chatIdHash: number
  /** 本次求值输入原文的 hash，{{pick}} 稳定性用 */
  contentHash: number
  pickRerollSeed?: number
  /** 旧→新时序 */
  messages: { name: string; mes: string; isUser: boolean; isSystem: boolean }[]
  model: string
  maxContext: number
  maxResponse: number
  /** 输入框当前文本，{{input}} 用 */
  input: string
  lastMessageAt?: number
  /** {{original}}，一次性 */
  original?: string
  originalUsed: { value: boolean }
  vars: MacroVarsApi
  /** 世界书 outlet 桶（已 join('\n')） */
  outlets: Record<string, string>
  /** 递归护栏：展开卡片字段本身时置 false，卡片字段类宏会 fail-open */
  replaceCharacterCard: boolean
}
```

派生规则（在 `buildMacroEnv()` 里算）：
- `{{group}}` / `{{charIfNotGroup}}` = `groupMembers.join(', ')`；1v1 下即角色名。
- `{{groupNotMuted}}` = `groupMembers.filter(n => !mutedMembers.includes(n)).join(', ')`。
- `{{notChar}}` = `[...groupMembers.filter(n => n !== char), user].join(', ')`；1v1 下 = `user`。

**卡片字段递归护栏**：展开 `description` 等字段时用 `baseChatReplace()`：

```ts
export function baseChatReplace(value: string, env: MacroEnv): string {
  if (!value) return ''
  return evaluateMacros(value, { ...env, replaceCharacterCard: false }).replace(/\r/g, '')
}
```
`replaceCharacterCard === false` 时，卡片字段宏 handler 直接返回 `{{name}}`，从而 `{{description}}` 里写 `{{description}}` 不会无限展开；同时 `{{char}}`/`{{user}}` 仍会正常展开（这正是 ST 的期望行为）。

### 2.4 `services/macro/registry.ts` —— 必须支持的宏清单

```ts
export interface MacroCallCtx {
  args: string[]
  env: MacroEnv
  /** 该宏在原始输入中的字符偏移，{{pick}} 稳定性用 */
  offset: number
  raw: string
}
export type MacroHandler = (ctx: MacroCallCtx) => unknown

export const MACROS = new Map<string, MacroHandler>()

const def = (names: string[], fn: MacroHandler) => {
  for (const n of names) MACROS.set(n.toLowerCase(), fn)
}
const arg = (ctx: MacroCallCtx, i: number) => (ctx.args[i] ?? '').trim()
/** 卡片字段宏的护栏封装 */
const card = (name: string, pick: (c: MacroCardFields) => string) =>
  (ctx: MacroCallCtx) =>
    ctx.env.replaceCharacterCard ? baseChatReplace(pick(ctx.env.card), ctx.env) : `{{${name}}}`
```

| 分类 | 宏 | 说明 |
|---|---|---|
| 名称 | `{{user}}` `{{char}}` `{{group}}` `{{charIfNotGroup}}` `{{groupNotMuted}}` `{{notChar}}` | 1vN 下 `{{char}}` = 当前发言者 |
| 卡片 | `{{description}}`/`{{charDescription}}`、`{{personality}}`/`{{charPersonality}}`、`{{scenario}}`/`{{charScenario}}`、`{{persona}}`、`{{mesExamples}}`、`{{mesExamplesRaw}}`、`{{charDepthPrompt}}`、`{{creatorNotes}}`/`{{charCreatorNotes}}`、`{{charPrompt}}`、`{{charInstruction}}`/`{{charJailbreak}}`、`{{charVersion}}`/`{{version}}`/`{{char_version}}`、`{{charFirstMessage}}`/`{{greeting[::n]}}` | 全部走 `card()` 护栏。`greeting::0` = first_mes，`n≥1` = alternate_greetings[n-1]，越界 = `''` |
| 一次性 | `{{original}}` | 用 `env.originalUsed.value` 做一次性闸门 |
| 工具 | `{{newline[::n]}}` `{{space[::n]}}` `{{noop}}` `{{trim}}` `{{input}}` `{{reverse::s}}` `{{// 注释}}` `{{outlet::key}}` | `{{trim}}` handler 返回字面标记 `'{{trim}}'`，由后处理吃掉前后换行 |
| 状态 | `{{maxContext}}`/`{{maxContextTokens}}` `{{maxResponse}}`/`{{maxResponseTokens}}` `{{maxPrompt}}` `{{model}}` `{{isMobile}}` | |
| 随机 | `{{random::a::b}}` / `{{random:a,b}}`、`{{pick::…}}`、`{{roll::1d20}}` / `{{roll::6}}` | 见下 |
| 时间 | `{{time}}` `{{time::UTC+8}}` `{{date}}` `{{weekday}}` `{{isotime}}` `{{isodate}}` `{{datetimeformat::fmt}}` `{{idleDuration}}` `{{timeDiff::a::b}}` | 用 `Intl.DateTimeFormat` 手写，**不引入 dayjs/moment**（项目当前零运行时依赖） |
| 聊天 | `{{lastMessage}}` `{{lastMessageId}}` `{{lastUserMessage}}` `{{lastCharMessage}}` `{{allChatRange}}` | |
| 变量 | `{{setvar::n::v}}` `{{getvar::n}}` `{{addvar}}` `{{incvar}}` `{{decvar}}` `{{hasvar}}` `{{deletevar}}` + `*globalvar` 全套 | 局部变量存 `ChatMeta.variables`，全局存 settings |
| 本项目扩展 | `{{relations}}` | 关系图谱渲染文本，供 1vN 约束提示词模板引用 |

随机三兄弟（零依赖）：

```ts
// services/macro/rng.ts
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 逗号列表，`\,` 转义逗号 */
export function splitList(args: string[]): string[] {
  if (args.length > 1) return args
  const single = args[0] ?? ''
  return single
    .replace(/\\,/g, '\u0000')
    .split(',')
    .map((s) => s.trim().replace(/\u0000/g, ','))
    .filter((s) => s !== '')
}
```

```ts
def(['random'], (ctx) => {
  const list = splitList(ctx.args)
  if (!list.length) return ''
  return list[Math.floor(Math.random() * list.length)] ?? ''
})

/** 稳定：同一会话 + 同一原文 + 同一位置 => 永远同一结果 */
def(['pick'], (ctx) => {
  const list = splitList(ctx.args)
  if (!list.length) return ''
  const parts = [ctx.env.chatIdHash, ctx.env.contentHash, ctx.offset]
  if (ctx.env.pickRerollSeed != null) parts.push(ctx.env.pickRerollSeed)
  const rng = mulberry32(getStringHash(parts.join('-')))
  return list[Math.floor(rng() * list.length)] ?? ''
})

def(['roll'], (ctx) => {
  let f = arg(ctx, 0)
  if (/^\d+$/.test(f)) f = `1d${f}`
  const m = f.match(/^(\d*)d(\d+)([+-]\d+)?$/i)
  if (!m || m[2] === undefined) return ''
  const n = Math.min(Number(m[1] || '1') || 1, 100)
  const sides = Number(m[2])
  const mod = m[3] ? Number(m[3]) : 0
  let total = mod
  for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * sides)
  return String(total)
})
```

---

## 第 3 部分：提示词组装 + 深度注入

### 3.1 `types/prompt.ts`

```ts
export type PromptRole = 'system' | 'user' | 'assistant'

export interface PromptMessage {
  role: PromptRole
  content: string
  /** example_user / example_assistant */
  name?: string
  /** 标记为注入产生的伪消息 */
  injected?: boolean
  /** 调试面板分组标识：main / wiBefore / charDesc / chatHistory / … */
  source?: string
}

/** 注入注册表条目。替代 ST 的全局可变 extension_prompts —— 每次生成重新构建 */
export interface Injection {
  key: string
  value: string
  /** EXT_POSITION */
  position: number
  depth: number
  /** EXT_ROLE */
  role: number
  /** 该文本是否参与世界书扫描 */
  scan: boolean
  /** 替代 ST 的"按 key 字典序排"：显式数字优先级，越大越贴近回复 */
  order: number
  filter?: () => boolean
}

export function makeInjection(p: Partial<Injection> & { key: string; value: string }): Injection {
  return {
    position: EXT_POSITION.IN_CHAT,
    depth: 0,
    role: EXT_ROLE.SYSTEM,
    scan: false,
    order: DEFAULT_ORDER,
    ...p,
  }
}
```

### 3.2 `services/prompt/injections.ts` —— **深度注入核心算法**

```ts
import { DEFAULT_ORDER, EXT_POSITION, EXT_ROLE } from '../worldinfo/constants'
import type { Injection, PromptMessage, PromptRole } from '@/types/prompt'

const ROLE_NAME: Record<number, PromptRole> = {
  [EXT_ROLE.SYSTEM]: 'system',
  [EXT_ROLE.USER]: 'user',
  [EXT_ROLE.ASSISTANT]: 'assistant',
}
/** 角色优先级：越靠后越"重要"，最终会落在越靠下的位置 */
const ROLE_ORDER = [EXT_ROLE.SYSTEM, EXT_ROLE.USER, EXT_ROLE.ASSISTANT]

/**
 * 把 IN_CHAT 注入按深度插进聊天历史。
 *
 * depth N 的精确语义：**注入之后恰好还有 N 条真实聊天消息**。
 *   depth 0 = 追加在最后一条消息之后（独立的一条消息，不是拼接到最后一条上）
 *   depth 1 = 紧挨最后一条消息之前
 *   depth ≥ 历史长度 = 顶到历史最前
 *
 * 实现要点（缺一不可）：
 *   ① 在**新→旧倒序**数组上操作
 *   ② splice 索引 = depth + totalInserted（已插入的伪消息不能顶掉后续深度）
 *   ③ 深度必须**升序**处理，②才成立
 *   ④ 最后 reverse 回时序
 *
 * 手工验算  chat=[M1,M2,M3]（M3 最新）→ 倒序 [M3,M2,M1]
 *   depth0 : splice(0) → [X,M3,M2,M1] → reverse → [M1,M2,M3,X]   ✔ 在最后一条之后
 *   depth1 : splice(1) → [M3,X,M2,M1] → reverse → [M1,M2,X,M3]   ✔
 *   depth0+depth1 同时: 先 0 → [X0,M3,M2,M1] (total=1)
 *                       再 1 → idx=1+1=2 → [X0,M3,X1,M2,M1]
 *                       reverse → [M1,M2,X1,M3,X0]                ✔
 */
export function injectAtDepths(
  chronological: PromptMessage[],
  injections: Injection[],
  opts: { isContinue?: boolean } = {},
): PromptMessage[] {
  const inChat = injections.filter(
    (i) => i.position === EXT_POSITION.IN_CHAT && i.value.trim() !== '' && (!i.filter || i.filter()),
  )
  if (!inChat.length) return chronological.slice()

  // 1) 按深度分桶（continue 时 depth 0 顺延到 1，避免插进被续写的那条之后）
  const byDepth = new Map<number, Injection[]>()
  for (const inj of inChat) {
    let d = Math.max(0, Math.floor(Number(inj.depth) || 0))
    if (opts.isContinue && d === 0) d = 1
    const list = byDepth.get(d)
    if (list) list.push(inj)
    else byDepth.set(d, [inj])
  }

  const messages = chronological.slice().reverse() // 新→旧
  let totalInserted = 0

  // 2) 只遍历真正有注入的深度（ST 是 0..10000 死循环，不要抄）
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const atDepth = byDepth.get(depth)
    if (!atDepth) continue

    const roleMessages: PromptMessage[] = []

    // 3) order 分组，**降序**（高 order 最终更贴近回复）
    const orders = [...new Set(atDepth.map((i) => i.order ?? DEFAULT_ORDER))].sort((a, b) => b - a)
    for (const order of orders) {
      const inOrder = atDepth.filter((i) => (i.order ?? DEFAULT_ORDER) === order)
      // 4) 角色顺序 [system, user, assistant]
      for (const role of ROLE_ORDER) {
        const content = inOrder
          .filter((i) => i.role === role)
          .sort((a, b) => a.key.localeCompare(b.key)) // 确定性 tiebreak
          .map((i) => i.value.trim())
          .filter((v) => v !== '')
          .join('\n')                                  // 5) 同一 (depth,order,role) 合成一条
        if (content) {
          roleMessages.push({
            role: ROLE_NAME[role] ?? 'system',
            content,
            injected: true,
            source: `inject@${depth}`,
          })
        }
      }
    }
    if (!roleMessages.length) continue

    const idx = Math.min(depth + totalInserted, messages.length)
    messages.splice(idx, 0, ...roleMessages)
    totalInserted += roleMessages.length
  }

  messages.reverse()
  return messages
}

/** 预算预留用：注入最终会产生哪些消息（不做插入） */
export function materializeInjections(
  injections: Injection[],
  opts: { isContinue?: boolean } = {},
): PromptMessage[] {
  return injectAtDepths([], injections, opts)
}
```

**同一 depth 多注入的合并规则总结**（用户可见行为）：
1. 先按 `order` 分组，**降序**遍历；
2. 每组内按角色 `[system, user, assistant]` 顺序；
3. 每个 `(depth, order, role)` 单元的所有注入 `.trim()` 后用 `'\n'` 连成**一条**消息（不是每个注入一条）；
4. 由于倒序数组 + 末尾 reverse，最终时序读下来是：**低 order 组在上、高 order 组在下；每组内 assistant → user → system**，system 紧贴其后的那条真实消息（depth 0 时就在整段历史的最末）。

### 3.3 `services/prompt/examples.ts` —— `<START>` 解析

```ts
/** 拆成块，每块以 <START>\n 开头（我们只走 Chat Completion，heading 恒为 <START>） */
export function parseMesExamples(examplesStr: string): string[] {
  if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') return []
  let s = examplesStr
  if (!s.startsWith('<START>')) s = '<START>\n' + s.trim()
  return s
    .split(/<START>/gi)
    .slice(1) // 丢掉第一个 <START> 之前的空片段
    .map((block) => `<START>\n${block.trim()}\n`)
}

export interface ExampleNames {
  user: string
  char: string
  /** 1vN：所有成员名，用于识别 "Bob:" 开头的行 */
  members: string[]
  isGroup: boolean
}

/**
 * 一块 <START> → example_user / example_assistant 消息。
 * 前置条件：块内的 {{user}}/{{char}} 已经过宏替换（由 baseChatReplace 完成）
 */
export function exampleBlockToMessages(block: string, names: ExampleNames): PromptMessage[] {
  const out: PromptMessage[] = []
  const lines = block.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '').split('\n')

  let buf: string[] = []
  let curName = ''
  let isUserTurn = false

  const flush = () => {
    if (!buf.length) return
    let content = buf.join('\n')
    if (curName) content = content.replace(new RegExp(`^${escapeRegex(curName)}\\s*:\\s*`), '')
    content = content.trim()
    if (content) {
      out.push({
        role: 'system',
        name: isUserTurn ? 'example_user' : 'example_assistant',
        // 1vN 时给 AI 的示例回补发言者，模型才分得清谁在说话
        content: names.isGroup && !isUserTurn && curName ? `${curName}: ${content}` : content,
        source: 'dialogueExamples',
      })
    }
    buf = []
  }

  for (let i = 1; i < lines.length; i++) { // 跳过第 0 行的 heading
    const line = lines[i]
    if (line === undefined) continue
    if (line.startsWith(`${names.user}:`)) { flush(); curName = names.user; isUserTurn = true }
    else {
      const member = names.members.find((n) => line.startsWith(`${n}:`))
      if (member || line.startsWith(`${names.char}:`)) {
        flush()
        curName = member ?? names.char
        isUserTurn = false
      }
    }
    buf.push(line)
  }
  flush()
  return out
}
```

装配时：世界书 `EMTop` 条目 → `parseMesExamples` 后 `unshift` 到卡片示例前，`EMBottom` → `push` 到后。每个块前插一条 `{ role:'system', content:'[Example Chat]' }`。

### 3.4 `services/prompt/relations.ts` —— 关系图谱 → 文本

```ts
export interface RelationNode { id: string; name: string; x: number; y: number }
/** 有向边：A→B 与 B→A 是两条独立的边，可以完全不同 */
export interface RelationEdge { id: string; from: string; to: string; label: string; note?: string }
export interface RelationGraph { nodes: RelationNode[]; edges: RelationEdge[] }

export function renderRelations(graph: RelationGraph): string {
  if (!graph.edges.length) return ''
  const nameOf = new Map(graph.nodes.map((n) => [n.id, n.name]))
  const lines: string[] = []
  for (const e of graph.edges) {
    const from = nameOf.get(e.from)
    const to = nameOf.get(e.to)
    if (!from || !to) continue
    const label = e.label.trim()
    if (!label) continue
    lines.push(e.note?.trim() ? `- ${from} 对 ${to}：${label}（${e.note.trim()}）` : `- ${from} 对 ${to}：${label}`)
  }
  return lines.length ? lines.join('\n') : ''
}
```

图谱本身存在 `ChatMeta.relationGraph`（1vN 会话级），渲染结果注入 `MacroEnv.relations`，由约束提示词模板里的 `{{relations}}` 引用。

### 3.5 `services/prompt/defaults.ts` —— 需求 4 的双模式约束提示词

```ts
export const DEFAULT_SOLO_CONSTRAINT = `[你正在扮演 {{char}}。始终以 {{char}} 的身份、语气与性格回应 {{user}}，不要跳出角色，不要代替 {{user}} 发言，不要输出解释性旁白。]`

export const DEFAULT_GROUP_CONSTRAINT = `[本场景为多人对话，参与者：{{group}}。本轮只以 {{char}} 的身份发言，不要替 {{notChar}} 说话。
角色之间的关系如下：
{{relations}}
请让 {{char}} 的态度与措辞符合上述关系。]`

export const DEFAULT_GROUP_NUDGE = '[接下来只以 {{char}} 的身份写下一条回复。]'
export const DEFAULT_NEW_CHAT_MARKER = '[开始新的对话]'
export const DEFAULT_NEW_GROUP_CHAT_MARKER = '[开始新的多人对话。参与者：{{group}}]'
export const DEFAULT_EXAMPLE_CHAT_MARKER = '[对话示例]'
export const DEFAULT_WI_FORMAT = '{0}'
```

全局设置（`SettingsStore`）新增：

```ts
soloConstraintPrompt: string   // 默认 DEFAULT_SOLO_CONSTRAINT
soloConstraintDepth: number    // 默认 0
groupConstraintPrompt: string  // 默认 DEFAULT_GROUP_CONSTRAINT
groupConstraintDepth: number   // 默认 0
constraintRole: number         // 默认 EXT_ROLE.SYSTEM
```

约束提示词**不是固定槽位**，而是注册成一条深度注入：

```ts
injections.push(makeInjection({
  key: 'CONSTRAINT',
  value: isGroup ? settings.groupConstraintPrompt : settings.soloConstraintPrompt,
  position: EXT_POSITION.IN_CHAT,
  depth: isGroup ? settings.groupConstraintDepth : settings.soloConstraintDepth,
  role: settings.constraintRole,
  order: 100,
  scan: false,
}))
```

这样"两个模式配置不同插入深度、默认 0"直接落在同一套 `injectAtDepths` 上，零特例代码。

### 3.6 `services/prompt/budget.ts` —— **注入必须先于历史预留预算**

```ts
export interface FitInput {
  /** 卡片块 + WI before/after + persona 等，恒定保留 */
  mandatory: PromptMessage[]
  /** 深度注入产生的伪消息（已 materialize），恒定保留 */
  injected: PromptMessage[]
  /** 旧→新时序的真实历史 */
  history: PromptMessage[]
  /** 对话示例，按块 */
  exampleBlocks: PromptMessage[][]
  budget: number
  count: TokenCounter
  pinExamples: boolean
}

export interface FitResult {
  history: PromptMessage[]
  examples: PromptMessage[]
  droppedHistory: number
  droppedExamples: number
}

/**
 * 顺序至关重要：mandatory + injected 先扣掉，剩下的才给历史/示例。
 * 否则长对话会把用户配置的 depth-0 约束提示词**静默丢掉** —— 需求 4 最坏的失败模式。
 */
export function fitWithinBudget(input: FitInput): FitResult {
  const { mandatory, injected, history, exampleBlocks, budget, count, pinExamples } = input
  const size = (m: PromptMessage) => count(m.content) + PER_MESSAGE_OVERHEAD

  let used = 0
  for (const m of mandatory) used += size(m)
  for (const m of injected) used += size(m) // ← 注入先占位

  const takeExamples = () => {
    const kept: PromptMessage[] = []
    let dropped = 0
    for (const block of exampleBlocks) {
      const t = block.reduce((s, m) => s + size(m), 0)
      if (used + t > budget) { dropped = exampleBlocks.length - kept.length; break }
      used += t
      kept.push(...block)
    }
    return { kept, dropped }
  }

  const takeHistory = () => {
    const kept: PromptMessage[] = []
    let dropped = 0
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]
      if (m === undefined) continue
      const t = size(m)
      // 最新一条永远保留，否则会发出空历史
      if (used + t > budget && kept.length > 0) { dropped = i + 1; break }
      used += t
      kept.unshift(m)
    }
    return { kept, dropped }
  }

  // pinExamples 时示例优先吃预算，否则历史优先（与 ST 一致）
  if (pinExamples) {
    const ex = { kept: exampleBlocks.flat(), dropped: 0 }
    for (const m of ex.kept) used += size(m)
    const h = takeHistory()
    return { history: h.kept, examples: ex.kept, droppedHistory: h.dropped, droppedExamples: 0 }
  }
  const h = takeHistory()
  const ex = takeExamples()
  return { history: h.kept, examples: ex.kept, droppedHistory: h.dropped, droppedExamples: ex.dropped }
}
```

### 3.7 `services/prompt/assemble.ts` —— 最终 OpenAI messages 组装全序

```ts
export interface BuildPromptInput {
  isGroup: boolean
  /** 本轮发言者（1v1 即唯一角色） */
  speaker: CharacterLite
  /** 1vN 全体成员（含静音标记） */
  members: CharacterLite[]
  mutedIds: string[]
  persona: { name: string; description: string }
  history: ChatMessage[]
  settings: AppSettings
  wiSettings: WISettings
  loreSources: LoreSources
  timedStore: TimedWorldInfo
  relationGraph?: RelationGraph
  isDryRun: boolean
  isContinue: boolean
  trigger: GenerationTrigger
  maxContext: number
  maxResponse: number
  model: string
  composerText: string
  chatId: string
  vars: MacroVarsApi
  count: TokenCounter
}

export interface BuiltPrompt {
  messages: { role: PromptRole; content: string; name?: string }[]
  debug: {
    sections: PromptMessage[]
    activatedWI: WIEntry[]
    tokens: number
    droppedHistory: number
  }
}

export function buildChatPrompt(input: BuildPromptInput): BuiltPrompt {
  // ── 步骤 1：先建一个"无关系文本"的 env，用于展开关系图谱本身 ─────────────
  const relations = input.relationGraph ? renderRelations(input.relationGraph) : ''
  const env = buildMacroEnv({ ...input, relations })
  const sub = (t: string) => evaluateMacros(t, env)
  const base = (t: string) => baseChatReplace(t, env)   // 卡片字段专用（带递归护栏）

  // ── 步骤 2：卡片字段（1vN SWAP 语义：只用当前发言者的卡） ────────────────
  const card = {
    description: base(input.speaker.description),
    personality: base(input.speaker.personality),
    scenario: base(input.speaker.scenario),
    mesExample: base(input.speaker.mesExample),
    persona: base(input.persona.description),
    systemPrompt: base(input.speaker.systemPrompt),
    postHistory: base(input.speaker.postHistoryInstructions),
    depthPrompt: base(input.speaker.depthPrompt?.prompt ?? ''),
    creatorNotes: base(input.speaker.creatorNotes),
  }

  // ── 步骤 3：世界书扫描 ────────────────────────────────────────────────
  const chatForWI = input.history
    .filter((m) => !m.isSystem && !m.exclude)
    .map((m) => (input.wiSettings.includeNames ? `${m.name}: ${m.mes}` : m.mes))
    .reverse()                                             // 新→旧

  const sortedEntries = resolveSortedEntries(input.loreSources, input.wiSettings.insertionStrategy)

  // dryRun 不得推进 sticky/cooldown
  const timedStore = input.isDryRun ? structuredClone(input.timedStore) : input.timedStore

  const wi = checkWorldInfo({
    chat: chatForWI,
    chatLength: chatForWI.length,
    maxContext: input.maxContext,
    isDryRun: input.isDryRun,
    globalScanData: {
      personaDescription: card.persona,
      characterDescription: card.description,
      characterPersonality: card.personality,
      characterDepthPrompt: card.depthPrompt,
      scenario: card.scenario,
      creatorNotes: card.creatorNotes,
      trigger: input.trigger,
    },
    sortedEntries,
    settings: input.wiSettings,
    timedStore,
    injects: collectScannableInjections(input),  // scan:true 的注入（如允许被扫的约束提示词）
    countTokens: input.count,
    substitute: sub,
    characterName: input.speaker.name,
    characterTags: input.speaker.tags,
  })
  env.outlets = mapValues(wi.outletEntries, (v) => v.join('\n')) // {{outlet::key}} 现在可用

  // ── 步骤 4：注入注册表（每次生成重建，不存全局，杜绝陈旧注入） ──────────
  const injections: Injection[] = []

  // 4a. 世界书 atDepth：一个 (depth, role) 一条
  for (const e of wi.depthEntries) {
    injections.push(makeInjection({
      key: `customDepthWI_${e.depth}_${e.role}`,
      value: e.entries.join('\n'),
      depth: e.depth, role: e.role, order: 100, scan: false,
    }))
  }
  // 4b. 世界书 ANTop/ANBottom（本项目无作者注释功能，落在作者注释锚点深度 4）
  const anText = [...wi.anTop, ...wi.anBottom].filter((s) => s.trim()).join('\n')
  if (anText) {
    injections.push(makeInjection({ key: '2_authors_note', value: anText, depth: 4, order: 100 }))
  }
  // 4c. 角色深度提示词（卡片 depth_prompt）
  if (card.depthPrompt.trim()) {
    injections.push(makeInjection({
      key: 'DEPTH_PROMPT',
      value: card.depthPrompt,
      depth: input.speaker.depthPrompt?.depth ?? DEFAULT_DEPTH,
      role: roleByName(input.speaker.depthPrompt?.role ?? 'system'),
      order: 100, scan: true,
    }))
  }
  // 4d. 需求 4：双模式约束提示词
  const constraintRaw = input.isGroup
    ? input.settings.groupConstraintPrompt
    : input.settings.soloConstraintPrompt
  const constraint = sub(constraintRaw).trim()
  if (constraint) {
    injections.push(makeInjection({
      key: 'CONSTRAINT',
      value: constraint,
      depth: input.isGroup ? input.settings.groupConstraintDepth : input.settings.soloConstraintDepth,
      role: input.settings.constraintRole,
      order: 200,   // 高于世界书，最终更贴近回复
      scan: false,
    }))
  }

  // ── 步骤 5：固定块（顺序即最终输出顺序） ──────────────────────────────
  const S = (content: string, source: string): PromptMessage[] =>
    content.trim() ? [{ role: 'system', content: content.trim(), source }] : []

  const mandatory: PromptMessage[] = [
    ...S(sub(input.settings.mainPrompt), 'main'),
    ...S(card.systemPrompt, 'charSystem'),
    ...S(formatWI(wi.worldInfoBefore, input.settings.wiFormat), 'worldInfoBefore'),
    ...S(card.description, 'charDescription'),
    ...S(card.personality, 'charPersonality'),
    ...S(card.scenario, 'scenario'),
    ...S(formatWI(wi.worldInfoAfter, input.settings.wiFormat), 'worldInfoAfter'),
    ...S(card.persona, 'personaDescription'),
    // 1vN 且开启"合并角色卡"时，此处追加其余成员的简介块（APPEND 语义）
    ...(input.isGroup ? groupMemberCards(input, base) : []),
  ]

  // ── 步骤 6：对话示例（WI EMTop/EMBottom 夹在卡片示例前后） ──────────────
  const names: ExampleNames = {
    user: env.user, char: env.char,
    members: input.members.map((m) => m.name),
    isGroup: input.isGroup,
  }
  const blocks: PromptMessage[][] = []
  const pushBlocks = (raw: string) => {
    for (const b of parseMesExamples(raw)) {
      blocks.push([
        { role: 'system', content: sub(DEFAULT_EXAMPLE_CHAT_MARKER), source: 'dialogueExamples' },
        ...exampleBlockToMessages(b, names),
      ])
    }
  }
  for (const em of wi.emEntries) if (em.position === WI_ANCHOR.before) pushBlocks(base(em.content))
  pushBlocks(card.mesExample)
  for (const em of wi.emEntries) if (em.position === WI_ANCHOR.after) pushBlocks(base(em.content))

  // ── 步骤 7：真实历史 ─────────────────────────────────────────────────
  const history: PromptMessage[] = input.history
    .filter((m) => !m.isSystem && !m.exclude)
    .map((m) => ({
      role: m.isUser ? 'user' : 'assistant',
      // 1vN 里 AI 消息前缀发言者名，模型才知道是谁说的
      content: input.isGroup && !m.isUser ? `${m.name}: ${sub(m.mes)}` : sub(m.mes),
      source: 'chatHistory',
    }))

  // ── 步骤 8：预算 —— 注入先预留，再填历史 ──────────────────────────────
  const injectedPreview = materializeInjections(injections, { isContinue: input.isContinue })
  const newChatMarker: PromptMessage = {
    role: 'system',
    content: sub(input.isGroup ? DEFAULT_NEW_GROUP_CHAT_MARKER : DEFAULT_NEW_CHAT_MARKER),
    source: 'newChat',
  }
  const groupNudge: PromptMessage[] = input.isGroup && input.trigger !== 'impersonate'
    ? [{ role: 'system', content: sub(input.settings.groupNudgePrompt), source: 'groupNudge' }]
    : []
  const phi: PromptMessage[] = card.postHistory.trim()
    ? [{ role: 'system', content: card.postHistory.trim(), source: 'jailbreak' }]
    : []

  const budget = input.maxContext - input.maxResponse - 8
  const fit = fitWithinBudget({
    mandatory: [...mandatory, newChatMarker, ...groupNudge, ...phi],
    injected: injectedPreview,
    history,
    exampleBlocks: blocks,
    budget,
    count: input.count,
    pinExamples: input.settings.pinExamples,
  })

  // ── 步骤 9：装配 —— 注入在**裁剪后**的历史上做 splice ──────────────────
  const withInjections = injectAtDepths(fit.history, injections, { isContinue: input.isContinue })

  const all: PromptMessage[] = [
    ...mandatory,
    ...fit.examples,
    newChatMarker,
    ...withInjections,
    ...groupNudge,   // group nudge 永远在最末，压过 depth-0 注入
    ...phi,
  ]

  const squashed = input.settings.squashSystemMessages ? squashSystem(all) : all
  return {
    messages: squashed.map(({ role, content, name }) => (name ? { role, content, name } : { role, content })),
    debug: {
      sections: all,
      activatedWI: wi.allActivatedEntries,
      tokens: countMessages(squashed, input.count),
      droppedHistory: fit.droppedHistory,
    },
  }
}

/** 合并相邻的、无 name 的 system 消息（对齐 ST squashSystemMessages） */
function squashSystem(msgs: PromptMessage[]): PromptMessage[] {
  const KEEP = new Set(['newChat', 'dialogueExamples', 'groupNudge'])
  const out: PromptMessage[] = []
  for (const m of msgs) {
    const prev = out[out.length - 1]
    if (
      prev && prev.role === 'system' && m.role === 'system'
      && !prev.name && !m.name
      && !KEEP.has(prev.source ?? '') && !KEEP.has(m.source ?? '')
    ) {
      prev.content = `${prev.content}\n${m.content}`
      continue
    }
    out.push({ ...m })
  }
  return out
}

function formatWI(text: string, format: string): string {
  if (!text) return ''
  return format ? format.replace('{0}', text) : text
}
```

**最终 messages 顺序（自上而下）：**

```
1  main（全局系统提示词）
2  charSystem（角色卡 system_prompt 覆盖）
3  worldInfoBefore   ← WI position 0
4  charDescription
5  charPersonality
6  scenario
7  worldInfoAfter    ← WI position 1
8  personaDescription
9  [1vN] 其余成员简介块
10 dialogueExamples: [对话示例] + example_user/example_assistant …（EMTop → 卡片 → EMBottom）
11 [开始新的对话] / [开始新的多人对话。参与者：…]
12 聊天历史（深度注入已 splice 其中）
      · depth K 注入 …
      · M(n-2)
      · depth 1 注入
      · M(n-1) 最后一条
      · depth 0 注入（约束提示词默认落这里，独立一条消息）
13 [1vN] group nudge：[接下来只以 X 的身份写下一条回复。]
14 postHistoryInstructions（PHI / 越狱）
```

### 3.8 开场白（需求 2：多条随机）

```ts
/** 需求 2：新对话随机选取一条开场白插入（1v1 与 1vN 统一用随机策略） */
export function pickGreeting(char: CharacterLite, env: MacroEnv): string {
  const pool = [char.firstMes, ...(char.alternateGreetings ?? [])].filter((s) => s && s.trim())
  if (!pool.length) return ''
  const picked = pool[Math.floor(Math.random() * pool.length)] ?? ''
  // {{char}} 固定为该角色（1vN 时每个成员各自展开）
  return evaluateMacros(picked.trim(), { ...env, char: char.name })
}
```
1v1 额外把整个 `pool` 存进 `message.swipes`（`swipeId` = 被选中那条的下标），用户可左右切换；1vN 每个成员各随机一条、不生成 swipes。

---

## 第 4 部分：Pinia / IndexedDB 边界

三大引擎全部是纯函数/纯类，store 只负责：

| Store | 职责 |
|---|---|
| `useWorldInfoStore` | 从 IndexedDB `books` 仓库读书；`resolveActiveBooks(chat)` 返回 `LoreSources`（**按书名去重，优先级 chat > persona > character > global，先出现者胜**）；CRUD + 导入导出 |
| `useSettingsStore` | `WISettings` + 约束提示词/深度 + `mainPrompt` + `wiFormat` + `pinExamples` + `squashSystemMessages` |
| `useChatStore` | `ChatMeta.timedWorldInfo`（TimedWorldInfo）、`ChatMeta.variables`、`ChatMeta.relationGraph`；生成时组装 `BuildPromptInput`、调用 `buildChatPrompt`、把 `timedStore` 写回 IndexedDB |

IndexedDB schema 增量：
- `books`：`{ id, name, scope: 'global'|'character', enabled, entries: Record<uid, WIEntry>, updatedAt }`，索引 `scope`、`name`
- `characters`：新增 `worldBookIds: string[]`（角色世界书关联）
- `chats`（meta）：新增 `timedWorldInfo: TimedWorldInfo`、`variables: Record<string,string>`、`relationGraph?: RelationGraph`

---

## 第 5 部分：验证清单（无测试框架，靠浏览器 + 手算）

在设置页做一个"提示词预览（dry run）"面板，直接渲染 `BuiltPrompt.debug.sections`，逐条标 `source`。用它验证：

1. `injectAtDepths` 的三个手算样例（见 §3.2 注释）逐条对上；
2. depth 0 注入是**独立一条消息**，不是拼在最后一条上；
3. 同 depth 下 order 200 的约束提示词在 order 100 的世界书之下；
4. 同 depth 同 order 下 assistant → user → system 自上而下；
5. 长对话（>200 条）时 `CONSTRAINT` 仍在（预算预留生效）；
6. 世界书：改一条 `order` 观察 before 桶内位置；两条同组同权重多次生成看随机分布；`sticky:3` 触发后连续 3 轮存在、第 4 轮消失并进入 cooldown；dry run 反复预览不推进 sticky；
7. 宏：`{{random::{{char}}::{{user}}}}`、`{{foo}}` 原样保留、`\{\{char\}\}` 输出字面 `{{char}}`、`a\n{{trim}}\nb` → `ab`。


## FILES
- `types/worldinfo.ts` — WIEntry（ST 原生 40 字段 schema，含三态 null 语义）+ WIBook（IndexedDB 记录形状，entries 为 uid 键对象）+ WICharacterFilter  
  reuse: 改编：结构骨架参考 D:/tauriApp/sillyTavernTauri/src/types/worldinfo.ts，但字段名/类型全部改回 ST 原生（D:/tauriApp/SillyTavern/public/scripts/world-info.js L4002-4045 逐字对照默认值）
- `services/worldinfo/constants.ts` — WI_LOGIC / WI_POSITION / WI_ANCHOR / SCAN_STATE / WI_STRATEGY / EXT_POSITION / EXT_ROLE 枚举（数值必须与 ST 逐字一致）+ DEFAULT_DEPTH/WEIGHT/ORDER、MAX_SCAN_DEPTH、GENERATION_TRIGGERS、WISettings + defaultWISettings()  
  reuse: 逐字：D:/tauriApp/SillyTavern/public/scripts/world-info.js L27-99、L855-869；D:/tauriApp/SillyTavern/public/script.js L483-499
- `services/worldinfo/entry.ts` — defaultEntry / getFreeUid / normalizeEntry / parseDecorators / getStringHash / hashEntry（固定键序 stringify，保证定时效果 hash 稳定）  
  reuse: 逐字：world-info.js L4002-4090（模板与 uid 分配）、L4540-4586（parseDecorators）；D:/tauriApp/SillyTavern/public/scripts/utils.js L522-539（getStringHash）
- `services/worldinfo/regex.ts` — escapeRegex + parseRegexFromString（含两处修正：replaceAll 解转义所有 \/、去掉 g 标志使 test 无状态）+ 有界正则缓存  
  reuse: 改编：world-info.js L2821-2835（parseRegexFromString），修 .replace('\\/','/') 只替换首个的 bug
- `services/worldinfo/buffer.ts` — WorldInfoBuffer 类：depthBuffer/recurseBuffer/injectBuffer/globalScanData + \x01 MATCHER 连接、get(entry,scanState)、matchKeys、getScore、advanceScan/getDepth、外部激活  
  reuse: 逐字：world-info.js L199-474（整个类），仅把模块级全局设置改为构造注入的 WISettings
- `services/worldinfo/timedEffects.ts` — WITimedEffect / TimedWorldInfo 形状 + WorldInfoTimedEffects 类：sticky/cooldown/delay 的检查、sticky→cooldown 受保护交接、setTimedEffects、dryRun 完全跳过 sticky/cooldown  
  reuse: 改编：world-info.js L479-793，把三处 chat_metadata 全局引用改为构造注入的 store 对象（持久化到 IndexedDB 的 ChatMeta.timedWorldInfo）
- `services/worldinfo/groups.ts` — filterByInclusionGroups + filterGroupsByTimedEffects + filterGroupsByScoring（逗号多组、sticky 全保留、评分三态 useGroupScoring、groupOverride 按 order 降序、加权随机）  
  reuse: 逐字：world-info.js L5173-5356
- `services/worldinfo/sources.ts` — LoreSources 类型 + resolveSortedEntries（插入策略 evenly/character_first/global_first、chat/persona lore 恒定置前、decorators 剥离、hash 计算、structuredClone 深拷贝）  
  reuse: 改编：world-info.js L4478-4527（getSortedEntries），书本装载改由 Pinia store 提供 LoreSources
- `services/worldinfo/buckets.ts` — bucketActivatedEntries：position 0-7 分桶（before/after/EMTop/EMBottom/ANTop/ANBottom/atDepth(depth,role)/outlet），降序遍历 + unshift 约定，修 atDepth push 未归一化 depth 的 NaN bug  
  reuse: 改编：world-info.js L5070-5162
- `services/worldinfo/engine.ts` — checkWorldInfo 主循环：scan_state 状态机、16 步拒绝级联（顺序不可重排）、sticky 优先候选排序、包含组、概率+ignoresBudget 预算走法、下一状态决策、递归缓冲扩展；全同步  
  reuse: 改编：world-info.js L4597-5170，去掉 await/事件/toastr/日志，token 计数改注入的同步 TokenCounter
- `services/tokens.ts` — estimateTokens（CJK 感知启发式）+ TokenCounter 接口 + PER_MESSAGE_OVERHEAD + countMessages  
  reuse: 逐字：D:/tauriApp/sillyTavernTauri/src/services/tokens.ts（23 行），新增 TokenCounter 类型别名与 PER_MESSAGE_OVERHEAD
- `services/macro/engine.ts` — evaluateMacros：preProcess（老式尖括号/时区）→ 递归下降 walk（内层优先、findClosing 计数嵌套、\{ 转义跳过）→ applyMacro（未知宏 fail-open、handler 抛异常返回原文）→ postProcess（解转义 + {{trim}} 吃换行）  
  reuse: new：不抄 ST 的 chevrotain 解析器，也不抄 macros.ts 正则数组；仅复用其语义规则（03-char-macros.md §4.C 的 pre/post processor 与 fail-open 策略）
- `services/macro/registry.ts` — MACROS: Map<string, MacroHandler> —— 名称/卡片/工具/状态/随机/时间/聊天/变量/outlet/relations 全部宏定义，含 card() 递归护栏封装  
  reuse: 改编：ST macros/definitions/*.js 的宏清单（03-char-macros.md §4.D），实现全部重写为 TS handler；时间宏用 Intl.DateTimeFormat 替代 moment/dayjs 以保持零依赖
- `services/macro/env.ts` — MacroEnv / MacroCardFields / MacroVarsApi 接口 + buildMacroEnv() + baseChatReplace()（replaceCharacterCard:false 递归护栏）；1vN 下 char=当前发言者、group/groupNotMuted/notChar 的派生规则  
  reuse: 改编：ST MacroEnvBuilder.js 的 getGroupValue 语义 + script.js L3282 baseChatReplace；把全局可变 name2 改成显式入参（03-char-macros.md 复用建议 #8）
- `services/macro/rng.ts` — mulberry32 种子 PRNG + splitList（逗号列表，\, 转义）；供 {{pick}} 稳定种子与 {{random}}/{{roll}}  
  reuse: new：替代 ST 的 seedrandom 依赖；{{pick}} 种子公式逐字沿用 hash(chatIdHash-contentHash-offset[-rerollSeed])
- `types/prompt.ts` — PromptRole / PromptMessage（含 injected、source 调试标记）/ Injection 注册表条目 {key,value,position,depth,role,scan,order,filter} + makeInjection 工厂  
  reuse: 改编：ST setExtensionPrompt 的注册表形状（script.js L8866-8875），把按 key 字典序排序换成显式数字 order
- `services/prompt/injections.ts` — injectAtDepths(chronological, injections, {isContinue}) —— 深度注入核心纯函数：倒序数组 splice(depth+totalInserted) 后 reverse；(depth,order,role) 合并规则；materializeInjections 供预算预留  
  reuse: 改编：openai.js L806-871 populationInjectionPrompts（算法逐字），去掉 0..10000 死循环改为只遍历有注入的深度
- `services/prompt/examples.ts` — parseMesExamples（<START> 拆块）+ exampleBlockToMessages（→ example_user/example_assistant，1vN 回补发言者前缀）+ ExampleNames  
  reuse: 逐字：script.js L3442-3455（parseMesExamples）；改编 openai.js L725-790（parseExampleIntoIndividual）
- `services/prompt/relations.ts` — RelationNode/RelationEdge/RelationGraph 类型 + renderRelations()：有向边（A→B 与 B→A 独立）渲染成中文关系文本，供 {{relations}}  
  reuse: new（需求 3 特有）
- `services/prompt/budget.ts` — fitWithinBudget：mandatory + injected 先扣预算，再新→旧贪心填历史，最后填示例块；pinExamples 时示例优先。保证 depth-0 约束提示词永不被静默丢弃  
  reuse: 改编：script.js L4819-4841（注入预分配）+ L4901-4911（示例装配）+ sillyTavernTauri/src/stores/chats.ts buildRequest 的 mandatory/fillable 切分策略
- `services/prompt/defaults.ts` — DEFAULT_SOLO_CONSTRAINT / DEFAULT_GROUP_CONSTRAINT（含 {{relations}}）/ DEFAULT_GROUP_NUDGE / 新对话标记 / [对话示例] 标记 / DEFAULT_WI_FORMAT —— 需求 4 的双模式约束提示词默认文案  
  reuse: 改编：openai.js L108-114 的 default_group_nudge_prompt / default_new_group_chat_prompt，改写为中文
- `services/prompt/assemble.ts` — buildChatPrompt：卡片字段展开 → 世界书扫描 → 构建注入注册表（WI atDepth/AN/角色深度提示词/双模式约束提示词）→ 固定块 → 示例 → 预算 → injectAtDepths → group nudge → PHI → squashSystemMessages，返回 OpenAI messages + 调试分段  
  reuse: 改编：script.js Generate() L4400-4700 与 openai.js populateChatCompletion L1181-1343 的顺序；替换 sillyTavernTauri/src/services/prompt/builder.ts（其深度注入缺 totalInserted 累加器，不可直接复用）

## RISKS
## 最容易出错 / 被低估的地方

**1. 拒绝级联的顺序是语义，不是风格（最高风险）**
`checkWorldInfo` 里那 16 步 `continue` 的先后顺序编码了真实的优先级：`delay` 压过一切（含 sticky 和 constant）；`sticky` 压过 `cooldown`、`delayUntilRecursion`、`excludeRecursion`；`decorators` / 外部激活 / `constant` / `sticky` 四个正向短路都排在关键词扫描之前。任何"顺手整理一下"的重排都会产生用不出来但排查极难的偏差。
规避：把 §1.11 的代码连注释一起抄进去，注释里的编号别删；code review 时对照 world-info.js L4685-4877 逐行核对。

**2. `unshift` 约定 + 排序稳定性**
所有输出桶（除 outlet）都是"按 order **降序**遍历 + `unshift`"。写成"升序 sort + push"看似等价，但**相同 order 的并列条目顺序会反过来**——用户把三条同 order=100 的设定放进 before 桶，顺序就乱了，而且只在特定数据下复现。
规避：`bucketActivatedEntries` 里保留那句注释；写个临时页面塞 5 条同 order 条目肉眼验证一次。

**3. 预算走法：`>=`、累积 `newContent`、`ignoresBudget` 倒计数器**
容易被"优化"成 per-entry 判断。真实语义是：溢出的那一条被丢弃但**它的内容仍留在 `newContent` 里继续挤压后续条目**；`token_budget_overflowed` 一旦置位就只放行剩余的 `ignoreBudget` 条目，且计数器归零后 `break`（不是 `continue`）。写错的表现是"预算相同但激活条目数和 ST 差一两条"，几乎不可能靠肉眼发现。
规避：这一段整体复制，不做任何重构。

**4. 深度注入必须先于普通历史预留预算（需求 4 的致命失败模式）**
如果先按预算填历史、剩下的才给注入，长对话下用户配置的 depth-0 约束提示词会**静默消失**——模型突然不守设定，用户完全不知道为什么。`fitWithinBudget` 里 `injected` 和 `mandatory` 一起先扣的那两行是整个需求 4 的命脉。
规避：预览面板必须显示"注入已占用 N tokens"；做一个 300 条历史的会话手动确认 `CONSTRAINT` 还在。

**5. `depth 0` 不是"拼到最后一条消息上"**
它是**独立的一条 message**，追加在最后一条之后。写成 `lastMsg.content += constraint` 会改变模型看到的角色边界，效果差异明显但不会报错。同理 group nudge 必须在 depth-0 注入**之后**。

**6. `totalInserted` 累加器 + 深度升序**
两者互为前提。现有移植 `builder.ts` 就是漏了累加器：多个不同 depth 同时注入时索引串位，depth 4 的内容会跑到 depth 5、6 的位置。
规避：把 §3.2 注释里那三个手算样例做成预览页里的一个"自检"按钮（拿假数据跑一遍打印结果）。

**7. 定时效果的三处时钟必须同口径**
`start`、`end`、`delay` 都要用同一个 `chatLength` = 参与提示词的非系统消息条数（即 `chatForWI.length`）。用了"含系统消息的总数"或"UI 显示条数"，效果就永不过期或立刻过期。另：`hash` 用固定键序 stringify，否则从不同路径（新建 / 导入 / IndexedDB 反序列化）拿到的同一条目 hash 不同，正在跑的 sticky 会莫名断掉。

**8. dryRun 必须 `structuredClone` timedStore**
提示词预览面板会频繁触发扫描；忘了克隆的话，用户每点一次预览就把 sticky/cooldown 推进一格。表现为"看了几眼预览，设定就不生效了"。

**9. `entry.content` 在扫描中被就地改写**
`entry.content = substitute(entry.content)` 是 ST 的设计（后面分桶直接用这份）。若 `sortedEntries` 没有 `structuredClone`，Pinia store 里的原始世界书条目会被宏展开结果永久污染，用户一保存就写回 IndexedDB。**这是会丢数据的 bug。**
规避：`resolveSortedEntries` 结尾的 `structuredClone` 不可省；且必须在 `hashEntry` 之后（hash 要基于原始 content 计算，与 ST 一致）。

**10. 宏引擎的两个死循环入口**
① handler 返回值**绝不能**再被扫描（否则 `{{setvar::a::{{getvar::a}}}}` 之类会自我喂养）；② `findClosing` 找不到配对时必须原样输出剩余文本并跳出，不能死等。
另：`{{trim}}` 的 handler 返回字面 `'{{trim}}'` 标记 + 后处理正则吃掉——如果哪天改成"handler 直接返回空串"，前后换行就吃不掉了。

**11. 卡片字段递归护栏**
展开 `{{description}}` 里的内容时必须用 `replaceCharacterCard: false`，否则一张写了 `{{description}}` 的卡片会无限展开直到栈溢出。但 `{{char}}`/`{{user}}` 在这一层**仍要正常展开**（卡片正文里大量用），别一刀切禁掉全部宏。

**12. `noUncheckedIndexedAccess` 的高发区**
`buffer.#depthBuffer[i]`、`messages.splice` 前后的 `arr[i]`、正则 `match[1]`/`match[2]`、`Object.entries` 解构后的值、`group[i]` 在 `splice` 后 `i--` 的循环里——全部是 `T | undefined`。建议统一模式：`const x = arr[i]; if (x === undefined) continue`，不要用 `!` 断言硬压（`groups.ts` 里 `splice` + `i--` 的循环用 `!` 是真会 undefined 的）。

**13. 正则 key 的 `g` 标志 + 缓存**
本设计缓存了编译后的 RegExp。若保留 `g` 标志，`test()` 会带 `lastIndex` 状态，同一个 key 连续匹配两次结果不同——非确定性 bug，排查代价极高。`parseRegexFromString` 里 `.replace(/g/g, '')` 那句不能删。

**14. 多组条目在"组已被激活"判断上的泄漏（ST 原生行为）**
`x.group === key` 是整串比较，而分桶是按逗号切分的，所以 `group: "a, b"` 的条目不会被 key `"a"` 的已激活判断拦住。这是上游的不一致。**决策：保留 ST 行为并在代码里写明注释**，因为用户明确要求"完整对齐"；若将来要修，改成 `x.group.split(/,\s*/).includes(key)` 并加设置开关，不要静默修改。

**15. token 估算与 ST 不一致导致激活条目数有出入**
启发式估算与真 tokenizer 差 10-30%，同样 25% 预算下激活条目数会和 ST 不同。这是预期内的，但要在设置页把"世界书预算"的实际 token 数显示出来，否则用户会以为引擎有 bug。留好 `TokenCounter` 注入点，后续可无痛切换。

## PHASING
## 分阶段切法（配合「先跑通 1v1」）

### 阶段 0 —— 不可后补的地基（与 P1 同期，必须最先落）
- `types/worldinfo.ts` 的 **WIEntry 必须一次到位用 ST 原生 schema**（`uid`/`disable`/`position: 0-7`/三态 null）。这是唯一不能后补的决策：一旦用了简化字段名，后面所有 store、UI、IndexedDB 记录、导入导出都要跟着迁移。**即使 P1 只用到其中 10 个字段，40 个字段也要全建、全给默认值、全做 round-trip 存储。**
- `services/worldinfo/constants.ts` 全套枚举 + `services/tokens.ts` + `types/prompt.ts`。零成本，先建好。

### 阶段 1 —— 1v1 端到端跑通（本领域交付物）
目标：能选一个角色、发一条消息、看到流式回复，且约束提示词按配置的深度生效。

必须做：
1. **宏引擎完整版**（`macro/engine.ts` + `rng.ts` + `env.ts`）+ 注册表的**第一批宏**：`user / char / description / personality / scenario / persona / mesExamples / charDepthPrompt / creatorNotes / charPrompt / charInstruction / greeting / newline / trim / noop / // / input / random / pick / roll / time / date / isotime / isodate / weekday`。引擎本身不分阶段——递归下降那 110 行一次写完，后续只往 Map 里加 handler。
2. **`prompt/injections.ts` 完整版**（`injectAtDepths` + `materializeInjections`）。这是需求 4 的载体，且是纯函数，先写先赚。
3. **`prompt/examples.ts`**（`<START>` 解析）+ **`prompt/budget.ts`** + **`prompt/defaults.ts`** + **`prompt/assemble.ts` 的 1v1 分支**（`isGroup` 相关代码路径先留空实现）。
4. **世界书引擎的"正确骨架 + 单轮扫描"**：`entry.ts` / `regex.ts` / `buffer.ts` / `buckets.ts` / `engine.ts`，但 `WISettings.recursive=false`、`minActivations=0`、`maxRecursionSteps=0`。此时 `while (scanState)` 只跑一轮 INITIAL，`groups.ts` 与 `timedEffects.ts` 可以先给**空实现存根**（`filterByInclusionGroups` 直接 return；`WorldInfoTimedEffects.isEffectActive` 恒 false，`setTimedEffects` 空转）。
   关键：**主循环骨架、16 步拒绝级联、预算走法、分桶 unshift 约定必须 P1 就写对**，它们没有"简化版"，写错了 P2 是重写而不是补充。

可以推迟：`characterFilter`（1v1 无意义）、`triggers`（先恒 'normal'）、`outlet`、`vectorized`、`automationId`、`min_activations`、`decorators`。

阶段 1 验收：预览面板能看到完整 messages 分段；`soloConstraintDepth` 改成 0/1/4 时约束提示词在历史里的位置正确移动；300 条历史下约束提示词仍在。

### 阶段 2 —— 世界书完整对齐（1v1 仍然是唯一模式）
把阶段 1 留的存根换成真实现，按依赖顺序：
1. `timedEffects.ts` 全套（sticky/cooldown/delay + hash + protected + dryRun 保护）+ IndexedDB `ChatMeta.timedWorldInfo` 持久化 + 预览面板的 `structuredClone` 分支。
2. `groups.ts` 三阶段过滤 + `buffer.getScore`。
3. 主循环开启 `recursive` / `minActivations` / `maxRecursionSteps` / `delayUntilRecursion` 等级队列 / `advanceScan` 扩窗。
4. `sources.ts` 插入策略 + 书本去重；`matchXxx` 六个扫描源开关；`triggers`；`decorators`；`per-entry scanDepth`。
5. 世界书编辑 UI（全局书 / 角色书两个 scope，需求 5）+ ST 世界书 JSON / 角色卡 character_book 的导入导出（零转换互通的兑现点）。

阶段 2 验收：拿一个真实社区世界书（带 sticky/包含组/递归的）导入，行为与 SillyTavern 肉眼一致。

### 阶段 3 —— 1vN
本领域只需要加量、不需要改结构：
1. `macro/env.ts` 补 `groupMembers` / `mutedMembers` / `{{group}}` / `{{groupNotMuted}}` / `{{notChar}}`；`env.char` 由发言轮次驱动（每轮重建 env）。
2. `prompt/relations.ts` + `{{relations}}` 宏 + `DEFAULT_GROUP_CONSTRAINT` 模板；`ChatMeta.relationGraph` 持久化。
3. `assemble.ts` 打开 `isGroup` 分支：`groupMemberCards()`（APPEND 语义的其余成员简介块）、group nudge、1vN 新对话标记、历史消息的发言者前缀、`exampleBlockToMessages` 的 `members` 识别。
4. `groupConstraintPrompt` / `groupConstraintDepth` 走同一套注入注册表——**零特例代码**，这是阶段 1 就把约束提示词做成注入而非固定槽位的回报。
5. 多角色 → `LoreSources.character` 为所有参与角色的角色世界书并集（按书名去重）。

### 阶段 4 —— 打磨
`outlet` 位置 + `{{outlet::key}}`；变量宏全套 + 变量面板；`{{timeDiff}}`/`{{datetimeformat}}`/`{{idleDuration}}`；可选真 tokenizer（换 `TokenCounter` 实现即可）；`squashSystemMessages` 开关；提示词调试面板的 token 分布可视化。

### 与其他领域的接口契约（越早锁越好）
- `useWorldInfoStore.resolveActiveBooks(chat): LoreSources` —— 阶段 1 就定死签名，即使内部先返回 `{global:[], character:[], chat:[], persona:[]}`。
- `useSettingsStore` 的字段名：`mainPrompt / wiFormat / pinExamples / squashSystemMessages / soloConstraintPrompt / soloConstraintDepth / groupConstraintPrompt / groupConstraintDepth / constraintRole / groupNudgePrompt` + `WISettings` 整块。
- `ChatMeta` 新增 `timedWorldInfo / variables / relationGraph` —— 阶段 1 就写进 IndexedDB schema 的默认值，避免后续加版本迁移。