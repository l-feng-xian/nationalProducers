# SillyTavern World Info / Lorebook: entry data model + scanWorldInfo (checkWorldInfo) activation algorithm

## Key files
- D:/tauriApp/SillyTavern/public/scripts/world-info.js — The whole World Info subsystem: enums (world_info_logic, world_info_position, scan_state, world_info_insertion_strategy), global settings, WorldInfoBuffer (scan text window + key matching + scoring), WorldInfoTimedEffects (sticky/cooldown/delay), newWorldInfoEntryDefinition (the entry schema with defaults), getSortedEntries(), checkWorldInfo() (the activation algorithm, line 4597), filterByInclusionGroups(), and all importers/converters.
- D:/tauriApp/SillyTavern/public/script.js — Caller. Line ~4565 builds `chatForWI` (the reversed message array actually scanned) and `globalScanData`, then calls getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData). Also defines extension_prompt_roles {SYSTEM:0, USER:1, ASSISTANT:2} at line 493.
- D:/tauriApp/SillyTavern/public/scripts/constants.js — GENERATION_TYPE_TRIGGERS = ['normal','continue','impersonate','swipe','regenerate','quiet'] (line 36) — the allowed values of entry.triggers; inject_ids used for depth/outlet injection.
- D:/tauriApp/SillyTavern/public/index.html — #entry_edit_template markup — the input names map 1:1 to entry field names (order, probability, depth, scanDepth, group, groupWeight, sticky, cooldown, delay, ignoreBudget, triggers, matchXxx checkboxes...).
- D:/tauriApp/SillyTavern/public/scripts/extensions/vectors/index.js — Consumer of entry.vectorized (line ~1659): entries flagged vectorized are skipped by keyword scan and instead retrieved by vector similarity.

## Report
# SillyTavern World Info — Data Model & Activation Algorithm (authoritative spec)

Source: `D:/tauriApp/SillyTavern/public/scripts/world-info.js` (6289 lines). All line numbers below refer to that file unless stated.

---

## 0. Storage shape

A lorebook file is JSON: `{ entries: { "<uid>": Entry, ... }, originalData?: {...} }`. `entries` is an **object keyed by stringified uid**, not an array. UID allocation (`getFreeWorldEntryUid`, L4283):

```js
const MAX_UID = 1_000_000;
for (let uid = 0; uid < MAX_UID; uid++) { if (uid in data.entries) continue; return uid; }
```
i.e. **smallest non-negative integer not already used**.

At load, `addMissingWorldInfoFields()` (L2104) back-fills every field missing from the template, coerces `key`/`keysecondary` to arrays, and ensures `characterFilter` is `{ isExclude:false, names:[], tags:[] }`.

---

## 1. ENTRY DATA MODEL

### 1.1 The canonical schema (`newWorldInfoEntryDefinition`, L4002–4045)

This is the single source of truth for types & defaults. `newWorldInfoEntryTemplate` (L4047) is `Object.fromEntries(...)` of it minus `excludeFromTemplate` fields.

```js
export const newWorldInfoEntryDefinition = {
    key:                       { default: [],    type: 'array' },
    keysecondary:              { default: [],    type: 'array' },
    comment:                   { default: '',    type: 'string' },
    content:                   { default: '',    type: 'string' },
    constant:                  { default: false, type: 'boolean' },
    vectorized:                { default: false, type: 'boolean' },
    selective:                 { default: true,  type: 'boolean' },
    selectiveLogic:            { default: world_info_logic.AND_ANY /* 0 */, type: 'enum' },
    addMemo:                   { default: false, type: 'boolean' },
    order:                     { default: 100,   type: 'number' },
    position:                  { default: 0,     type: 'number' },
    disable:                   { default: false, type: 'boolean' },
    ignoreBudget:              { default: false, type: 'boolean' },
    excludeRecursion:          { default: false, type: 'boolean' },
    preventRecursion:          { default: false, type: 'boolean' },
    matchPersonaDescription:   { default: false, type: 'boolean' },
    matchCharacterDescription: { default: false, type: 'boolean' },
    matchCharacterPersonality: { default: false, type: 'boolean' },
    matchCharacterDepthPrompt: { default: false, type: 'boolean' },
    matchScenario:             { default: false, type: 'boolean' },
    matchCreatorNotes:         { default: false, type: 'boolean' },
    delayUntilRecursion:       { default: 0,     type: 'number' },
    probability:               { default: 100,   type: 'number' },
    useProbability:            { default: true,  type: 'boolean' },
    depth:                     { default: DEFAULT_DEPTH /* 4 */, type: 'number' },
    outletName:                { default: '',    type: 'string' },
    group:                     { default: '',    type: 'string' },
    groupOverride:             { default: false, type: 'boolean' },
    groupWeight:               { default: DEFAULT_WEIGHT /* 100 */, type: 'number' },
    scanDepth:                 { default: null,  type: 'number?' },
    caseSensitive:             { default: null,  type: 'boolean?' },
    matchWholeWords:           { default: null,  type: 'boolean?' },
    useGroupScoring:           { default: null,  type: 'boolean?' },
    automationId:              { default: '',    type: 'string' },
    role:                      { default: 0,     type: 'enum' },   // extension_prompt_roles.SYSTEM
    sticky:                    { default: null,  type: 'number?' },
    cooldown:                  { default: null,  type: 'number?' },
    delay:                     { default: null,  type: 'number?' },
    characterFilterNames:      { default: [],    type: 'array',   excludeFromTemplate: true },
    characterFilterTags:       { default: [],    type: 'array',   excludeFromTemplate: true },
    characterFilterExclude:    { default: false, type: 'boolean', excludeFromTemplate: true },
    triggers:                  { default: [],    type: 'array', arrayFilter: (v) => GENERATION_TYPE_TRIGGERS.includes(v) },
};
```

### 1.2 Field-by-field meaning

| Field | Type | Default | Meaning |
|---|---|---|---|
| `uid` | number | auto (lowest free int, 0-based) | Primary key inside a book. Not in the template — assigned by `createWorldInfoEntry` as `{ uid: newUid, ...template }` (L4065). Identity across books is `` `${entry.world}.${entry.uid}` ``. |
| `world` | string | injected at load | Book name. **Not stored in the file** — added by `getGlobalLore`/`getCharacterLore`/`getChatLore`/`getPersonaLore` when mapping entries (`.map(({uid, ...rest}) => ({uid, world: worldName, ...rest}))`). |
| `key` | string[] | `[]` | Primary keywords. Each element is either plain text or a `/regex/flags` string. An entry with `key.length === 0` can never activate by scanning (`'has no keys defined, skipped'`, L4793) — only `constant`, sticky, decorator, or external activation works. |
| `keysecondary` | string[] | `[]` | Secondary/optional filter keywords, combined via `selectiveLogic`. Ignored when empty. |
| `comment` | string | `''` | Entry title / memo. Purely cosmetic; used as the display name and by search. UI placeholder falls back to first 100 chars of joined keys (`MAX_COMMENT_LENGTH = 100`). |
| `content` | string | `''` | The text injected into the prompt. Macros are substituted in-place at activation time (`entry.content = substituteParams(entry.content)`, L4939). Leading `@@decorator` lines are stripped at load into `entry.decorators`. |
| `constant` | boolean | `false` | "Blue light" — always activates, no key check (L4781). Mutually exclusive with `vectorized` in the UI tri-state selector (`constant` / `normal` / `vectorized`, L3204–3236). |
| `vectorized` | boolean | `false` | "Green light" — the entry is *not* keyword-scanned by WI; the Vectors extension retrieves it by embedding similarity instead. Note: `checkWorldInfo` itself does **not** special-case `vectorized`; it's consumed by `scripts/extensions/vectors/index.js` (~L1659: `if (!entry.vectorized && !settings.enabled_for_all) skip`). |
| `selective` | boolean | `true` | Legacy toggle for "use secondary keys". Comment in code: `entry.selective && //all entries are selective now` (L4813). The UI input is force-checked and hidden (L3549–3550). Effectively always true. |
| `selectiveLogic` | enum number | `0` (AND_ANY) | How `keysecondary` combines with the primary match. See §2. |
| `addMemo` | boolean | `false` | Legacy UI flag "this entry has a memo/title". Only toggles the comment textarea visibility (L3507). No effect on activation. |
| `order` | number | `100` | **Insertion order / priority.** Sorting is *descending* everywhere: `const sortFn = (a, b) => b.order - a.order;` (L88). Higher order = evaluated/inserted earlier. Also the tiebreaker in inclusion-group priority. |
| `position` | enum number | `0` (before) | Where the content is injected. See `world_info_position` in §1.4. |
| `disable` | boolean | `false` | Kill switch. `if (entry.disable == true) continue;` (L4689) — first check after the already-processed guard. Serialized to the character-book field as `enabled: !disable`. |
| `ignoreBudget` | boolean | `false` | Entry bypasses the token budget entirely: it is neither counted against the budget nor skipped once overflow occurred (L4898–4907, L4942). |
| `excludeRecursion` | boolean | `false` | This entry cannot be *activated by* recursion — it is skipped when `scanState === RECURSION` (L4758). ("Non-recursable".) |
| `preventRecursion` | boolean | `false` | This entry's content is **not added to the recursion buffer**, so it cannot activate others (L4961: `successfulNewEntries.filter(x => !x.preventRecursion)`). |
| `delayUntilRecursion` | number \| boolean | `0` (falsy) | "Delay until recursion" level. `true` is normalized to level `1`. The entry may only activate during a RECURSION pass whose `currentRecursionDelayLevel >= entry.delayUntilRecursion` (L4748–4756). Levels are processed ascending, one per drained loop. |
| `probability` | number 0–100 | `100` | % chance the entry activates once it matched. Clamped `Math.min(100, Math.max(0, v))` in the UI (L3100). |
| `useProbability` | boolean | `true` | Whether to roll at all. If false (or `probability === 100`) the roll is skipped. Toggling it off sets `probability = null`; toggling on restores `100` (L3130–3135). The UI toggle is force-checked and hidden (L3138–3139). |
| `depth` | number | `4` (`DEFAULT_DEPTH`) | Only meaningful for `position === atDepth (4)`. How many messages from the end the content is injected at. UI range `0..MAX_SCAN_DEPTH (1000)`, not clamped. Set to `null` when position ≠ atDepth (L3351). |
| `outletName` | string | `''` | Only for `position === outlet (7)`. Named injection point; entries are bucketed into `outletEntries[outletName]`. Entry is skipped with a warning if position is outlet and name is empty (L5130). |
| `group` | string | `''` | Inclusion group(s). **Comma-separated, multi-group**: `item.group.split(/,\s*/)` (L5273). Only one entry per group activates per scan. |
| `groupOverride` | boolean | `false` | "Group priority". If any member of a group has it, the highest-`order` such member wins outright, no random roll (L5325–5330). |
| `groupWeight` | number | `100` (`DEFAULT_WEIGHT`) | Weight in the group's weighted-random roll. UI clamped `1..10000`. |
| `scanDepth` | number \| null | `null` | Per-entry override of the global scan window (in messages). `null` ⇒ use `world_info_depth + skew`. UI clamps to `0..1000` and floors. |
| `caseSensitive` | boolean \| null | `null` | Per-entry override of `world_info_case_sensitive`. `null` ⇒ inherit global. |
| `matchWholeWords` | boolean \| null | `null` | Per-entry override of `world_info_match_whole_words`. `null` ⇒ inherit global. |
| `useGroupScoring` | boolean \| null | `null` | Per-entry override of `world_info_use_group_scoring`. `null` ⇒ inherit global. |
| `automationId` | string | `''` | Links the entry to a Quick Reply automation: when this entry activates, the QR with the same `automationId` is executed. No effect inside `checkWorldInfo`. |
| `role` | enum number | `0` (SYSTEM) | Only for `atDepth`. `extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 }` (script.js L493). Depth entries are bucketed by `(depth, role)` pair. |
| `sticky` | number \| null | `null` | Once activated, force-activate for the next N messages. Stored in `chat_metadata.timedWorldInfo.sticky[world.uid] = { hash, start, end, protected }`. UI range 1..10000. |
| `cooldown` | number \| null | `null` | After activating, suppress for N messages. Same metadata shape under `.cooldown`. When a *sticky* period ends, cooldown starts immediately and `protected: true` (L518–529). |
| `delay` | number \| null | `null` | Entry cannot activate until the chat has at least N messages: `if (this.#chat.length < entry.delay) buffer.push(entry)` ⇒ suppressed (L666–677). Unlike sticky/cooldown, delay is stateless (recomputed every scan) and *is* evaluated during dry runs. |
| `matchPersonaDescription` | boolean | `false` | Append the user persona description to the scanned text for this entry. |
| `matchCharacterDescription` | boolean | `false` | Append character description to the scanned text. |
| `matchCharacterPersonality` | boolean | `false` | Append character personality. |
| `matchCharacterDepthPrompt` | boolean | `false` | Append character depth prompt / character's note. |
| `matchScenario` | boolean | `false` | Append scenario. |
| `matchCreatorNotes` | boolean | `false` | Append creator notes. |
| `triggers` | string[] | `[]` | Generation-type filter. Allowed values `GENERATION_TYPE_TRIGGERS = ['normal','continue','impersonate','swipe','regenerate','quiet']`. Empty array = all types. Check at L4695: `if (!entry.triggers.includes(globalScanData.trigger)) continue;` |
| `characterFilter` | `{isExclude:boolean, names:string[], tags:string[]}` | `{false,[],[]}` | Restrict/exclude the entry for specific characters (by avatar filename) or tags. Evaluated at L4704–4731. Stored as a nested object in the file, but the *definition* exposes flattened `characterFilterNames/Tags/Exclude` (excluded from the template) for the slash-command API. |
| `displayIndex` | number | `uid` if absent (L2365) | Manual sort order in the editor only. Reassigned on drag-and-drop. |
| `decorators` | string[] | computed | Derived at load, not stored. `parseDecorators()` (L4540) strips leading `@@`-lines from content. Known: `KNOWN_DECORATORS = ['@@activate', '@@dont_activate']`. `@@@` prefix = fallback form (only used if the previous decorator was unknown). |
| `hash` | number | computed | `getStringHash(JSON.stringify(entry))` computed after decorator parsing (L4520). Identity key for timed-effect metadata (survives uid renumbering but *breaks when the entry text is edited*). |

### 1.3 `world_info_position` (L855) and `wi_anchor_position` (L866)

```js
export const world_info_position = {
    before:   0,  // before character definitions
    after:    1,  // after character definitions
    ANTop:    2,  // top of Author's Note
    ANBottom: 3,  // bottom of Author's Note
    atDepth:  4,  // @ D — injected N messages from the end, with a role
    EMTop:    5,  // top of example messages
    EMBottom: 6,  // bottom of example messages
    outlet:   7,  // named outlet
};
export const wi_anchor_position = { before: 0, after: 1 };
```

### 1.4 Character-book (V2/V3 spec) field mapping

`originalWIDataKeyMap` (L2607) and `convertCharacterBook` (L5498) define the on-disk portable form: `key→keys`, `keysecondary→secondary_keys`, `order→insertion_order`, `disable→!enabled`, and everything else under `extensions.*` in snake_case (`extensions.exclude_recursion`, `extensions.delay_until_recursion`, `extensions.scan_depth`, `extensions.match_whole_words`, `extensions.group_weight`, `extensions.ignore_budget`, `extensions.triggers`, …). `selectiveLogic` is stored at top level, unprefixed.

---

## 2. `world_info_logic` (L33)

```js
export const world_info_logic = {
    AND_ANY: 0,   // primary matched AND at least one secondary matched
    NOT_ALL: 1,   // primary matched AND at least one secondary did NOT match
    NOT_ANY: 2,   // primary matched AND NO secondary matched
    AND_ALL: 3,   // primary matched AND ALL secondaries matched
};
```

Implementation (`matchSecondaryKeys`, L4831–4866) — evaluated only if `keysecondary.length > 0`; short-circuits inside the loop for AND_ANY / NOT_ALL:

```js
for (let keysecondary of entry.keysecondary) {
    const secondarySubstituted = substituteParams(keysecondary);
    const hasSecondaryMatch = secondarySubstituted && buffer.matchKeys(textToScan, secondarySubstituted.trim(), entry);
    if (hasSecondaryMatch) hasAnyMatch = true;
    if (!hasSecondaryMatch) hasAllMatch = false;
    if (selectiveLogic === world_info_logic.AND_ANY && hasSecondaryMatch) return true;
    if (selectiveLogic === world_info_logic.NOT_ALL && !hasSecondaryMatch) return true;
}
if (selectiveLogic === world_info_logic.NOT_ANY && !hasAnyMatch) return true;
if (selectiveLogic === world_info_logic.AND_ALL && hasAllMatch) return true;
return false;
```

Fallback when the field is missing: `const selectiveLogic = entry.selectiveLogic ?? 0;` (L4827).

---

## 3. THE ACTIVATION ALGORITHM

Entry point `getWorldInfoPrompt(chat, maxContext, isDryRun, globalScanData)` (L892) → `checkWorldInfo(...)` (L4597).

### 3.0 Global settings and their defaults (L69–82)

```js
export let world_info_depth = 2;                      // scan window in messages
export let world_info_min_activations = 0;            // 0 = disabled
export let world_info_min_activations_depth_max = 0;  // 0 = no cap
export let world_info_budget = 25;                    // % of maxContext
export let world_info_include_names = true;           // prefix "Name: " onto scanned messages
export let world_info_recursive = false;
export let world_info_overflow_alert = false;
export let world_info_case_sensitive = false;
export let world_info_match_whole_words = false;
export let world_info_use_group_scoring = false;
export let world_info_character_strategy = world_info_insertion_strategy.character_first; // 1
export let world_info_budget_cap = 0;                 // 0 = no cap (absolute token cap)
export let world_info_max_recursion_steps = 0;        // 0 = disabled
```

Other constants: `DEFAULT_DEPTH = 4`, `DEFAULT_WEIGHT = 100`, `MAX_SCAN_DEPTH = 1000`, `MAX_COMMENT_LENGTH = 100`, `METADATA_KEY = 'world_info'`.

`world_info_insertion_strategy = { evenly: 0, character_first: 1, global_first: 2 }` (L27).

`scan_state = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 }` (L43). The main loop is `while (scanState)`, so `NONE = 0` is the stop condition.

### 3.1 What text gets scanned

The caller (script.js ~L4565) builds:

```js
const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
const globalScanData = {
    personaDescription: persona, characterDescription: description,
    characterPersonality: personality, characterDepthPrompt: charDepthPrompt,
    scenario, creatorNotes,
    trigger: GENERATION_TYPE_TRIGGERS.includes(type) ? type : 'normal',
};
await getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData);
```

So the array is **reverse-chronological**: index 0 = most recent message.

`WorldInfoBuffer` (L199) holds four sources:
- `#depthBuffer` — the messages, trimmed, filled up to `MAX_SCAN_DEPTH` (L250).
- `#injectBuffer` — extension prompts whose `scan` flag is set, collected at the very start of `checkWorldInfo` (L4607–4614) via `getExtensionPromptByName`. Includes the Author's Note (if "allow WI scan") and the quiet prompt.
- `#recurseBuffer` — content of entries activated in earlier loop iterations.
- `#globalScanData` — persona/character/scenario/creator-notes text, opt-in per entry.

`buffer.get(entry, scanState)` (L279) assembles the haystack:

```js
let depth = entry.scanDepth ?? this.getDepth();   // getDepth() = world_info_depth + skew
if (depth <= this.#startDepth) return '';          // #startDepth is always 0 here
if (depth < 0) { error; return ''; }
if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;

const MATCHER = '\x01';
const JOINER = '\n' + MATCHER;
let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);
// + persona/charDesc/charPersonality/charDepthPrompt/scenario/creatorNotes if the entry opts in
// + injectBuffer
// + recurseBuffer, UNLESS scanState === scan_state.MIN_ACTIVATIONS
return result;
```

Two subtleties worth copying:
- Each segment is prefixed with `\x01`. Since `\x01` is a non-word char, it acts as a synthetic word boundary so whole-word matching works at the start of every message and doesn't bleed across message boundaries.
- **The recursion buffer is deliberately excluded during MIN_ACTIVATIONS passes** (L323), so widening the window doesn't let recursion-only text re-trigger things.

### 3.2 Budget computation (L4624–4631)

```js
let budget = Math.round(world_info_budget * maxContext / 100) || 1;
if (world_info_budget_cap > 0 && budget > world_info_budget_cap) budget = world_info_budget_cap;
```
`|| 1` guarantees a minimum of 1 token. `world_info_budget` is a percentage of the generation's max context; `world_info_budget_cap` is an absolute token ceiling (0 = off).

### 3.3 Entry collection and pre-sort — `getSortedEntries()` (L4478)

1. Load in parallel: `getGlobalLore()` (books in `selected_world_info`), `getCharacterLore()` (character's primary `data.extensions.world` + `world_info.charLore[].extraBooks`), `getChatLore()` (`chat_metadata['world_info']`), `getPersonaLore()` (`power_user.persona_description_lorebook`). Each source **de-duplicates** against the higher-priority sources by book name.
2. Emit `WORLDINFO_ENTRIES_LOADED`.
3. Combine global vs character according to `world_info_character_strategy`:
   - `evenly (0)`: `[...global, ...character].sort(sortFn)` — one merged descending-order list.
   - `character_first (1)`: `[...character.sort(sortFn), ...global.sort(sortFn)]`.
   - `global_first (2)`: `[...global.sort(sortFn), ...character.sort(sortFn)]`.
4. `entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];` — **chat lore always first, then persona lore**, regardless of strategy.
5. Parse decorators out of `content`, then compute `hash = getStringHash(JSON.stringify(entry))` (two separate `.map()` passes so the hash includes the decorators/stripped content but preserves legacy hash values).
6. `return structuredClone(entries)` — a deep copy, so mutating `entry.content` during the scan doesn't corrupt the cache.

`sortFn = (a, b) => b.order - a.order` ⇒ **descending `order`**. The resulting array index in `sortedEntries` is the canonical priority used later for budget cut-off ordering.

### 3.4 Delayed-recursion level queue (L4642–4650)

```js
const availableRecursionDelayLevels = [...new Set(sortedEntries
    .filter(entry => entry.delayUntilRecursion)
    .map(entry => entry.delayUntilRecursion === true ? 1 : entry.delayUntilRecursion),
)].sort((a, b) => a - b);
let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;
```
Distinct levels ascending; the first is pre-loaded, the rest are drained one per exhausted scan.

### 3.5 The main loop (`while (scanState)`, L4654)

**Step 0 — max recursion steps guard** (L4656):
```js
if (world_info_max_recursion_steps && world_info_max_recursion_steps <= count) break;
```
Note the comment: *"if world_info_max_recursion_steps is non-zero min activations are disabled, and vice versa."* `count` counts *all* loop iterations, not just recursion ones.

**Step 1 — per-entry candidate check**, in `sortedEntries` order. Rejection cascade (each `continue`s):

1. `failedProbabilityChecks.has(entry) || allActivatedEntries.has(`${world}.${uid}`)` → already decided.
2. `entry.disable == true`.
3. `triggers` non-empty and `!triggers.includes(globalScanData.trigger)`.
4. `characterFilter.names` non-empty: `filtered = isExclude ? nameIncluded : !nameIncluded` (name = `getCharaFilename()`).
5. `characterFilter.tags` non-empty: same logic against `context.tagMap[tagKey]`.
6. `isDelay` (timed delay active) → suppressed.
7. `isCooldown && !isSticky` → suppressed.
8. `scanState !== RECURSION && entry.delayUntilRecursion && !isSticky` → suppressed.
9. `scanState === RECURSION && entry.delayUntilRecursion > currentRecursionDelayLevel && !isSticky` → suppressed.
10. `scanState === RECURSION && world_info_recursive && entry.excludeRecursion && !isSticky` → suppressed.

Then positive short-circuits (each `activatedNow.add(...)` and `continue`):

11. `decorators.includes('@@activate')` → activate.
12. `decorators.includes('@@dont_activate')` → suppress.
13. `buffer.getExternallyActivated(entry)` → activate the *external* version of the entry (populated by the `WORLDINFO_FORCE_ACTIVATE` event, L1020–1026, keyed `world.uid`).
14. `entry.constant` → activate.
15. `isSticky` → activate.
16. `!Array.isArray(entry.key) || !entry.key.length` → skip.

Finally the actual keyword scan:

```js
const textToScan = buffer.get(entry, scanState);
let primaryKeyMatch = entry.key.find(key => {
    const substituted = substituteParams(key);
    return substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
});
if (!primaryKeyMatch) continue;
const hasSecondaryKeywords = (entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length);
if (!hasSecondaryKeywords) { activatedNow.add(entry); continue; }
// ...selectiveLogic evaluation (see §2)
```

**Step 2 — order the candidates** (L4882):
```js
const newEntries = [...activatedNow].sort((a, b) => {
    const isASticky = timedEffects.isEffectActive('sticky', a) ? 1 : 0;
    const isBSticky = timedEffects.isEffectActive('sticky', b) ? 1 : 0;
    return isBSticky - isASticky || sortedEntries.indexOf(a) - sortedEntries.indexOf(b);
});
```
Sticky entries first, then original `sortedEntries` (order-descending) position. This is the order in which the budget is consumed.

**Step 3 — inclusion groups**: `filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects)` (L5269). Mutates `newEntries` in place. See §3.7.

**Step 4 — probability + budget** (L4898–4958):
```js
const textToScanTokens = await getTokenCountAsync(allActivatedText);
let ignoresBudget = newEntries.filter(e => e.ignoreBudget).length;
for (const entry of newEntries) {
    ignoresBudget -= (entry.ignoreBudget ? 1 : 0);
    if (token_budget_overflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) continue;   // keep walking to reach remaining ignoreBudget entries
        break;                             // no ignoreBudget entries left → stop entirely
    }
    // verifyProbability(): true if !useProbability || probability === 100 || isSticky;
    //                      else Math.random() * 100 <= entry.probability
    //                      on failure → failedProbabilityChecks.add(entry)
    entry.content = substituteParams(entry.content);
    newContent += `${entry.content}\n`;
    if (!entry.ignoreBudget && (textToScanTokens + await getTokenCountAsync(newContent)) >= budget) {
        token_budget_overflowed = true;    // (+ optional toastr warning if world_info_overflow_alert)
        continue;
    }
    allActivatedEntries.set(`${entry.world}.${entry.uid}`, entry);
}
```
Notes: the budget test is `>=` (inclusive), it re-tokenizes the *accumulated* `newContent` each iteration, and it charges the already-activated text (`allActivatedText`) too. An entry that overflows is dropped but `newContent` already contains it, so it still counts against subsequent entries in the same pass.

**Step 5 — decide the next scan state** (L4960–5014):
```js
const successfulNewEntries = newEntries.filter(x => !failedProbabilityChecks.has(x));
const successfulNewEntriesForRecursion = successfulNewEntries.filter(x => !x.preventRecursion);

// (a) normal recursion
if (world_info_recursive && !token_budget_overflowed && successfulNewEntriesForRecursion.length)
    nextScanState = scan_state.RECURSION;

// (b) a MIN_ACTIVATIONS pass is always followed by a recursion pass if there is a recurse buffer
if (world_info_recursive && !token_budget_overflowed && scanState === scan_state.MIN_ACTIVATIONS && buffer.hasRecurse())
    nextScanState = scan_state.RECURSION;

// (c) min activations
const minActivationsNotSatisfied = world_info_min_activations > 0 && (allActivatedEntries.size < world_info_min_activations);
if (!nextScanState && !token_budget_overflowed && minActivationsNotSatisfied) {
    let over_max = (world_info_min_activations_depth_max > 0 && buffer.getDepth() > world_info_min_activations_depth_max)
                || (buffer.getDepth() > chat.length);
    if (!over_max) { nextScanState = scan_state.MIN_ACTIVATIONS; buffer.advanceScan(); /* skew++ */ }
}

// (d) drain the next delayed-recursion level
if (nextScanState === scan_state.NONE && availableRecursionDelayLevels.length) {
    nextScanState = scan_state.RECURSION;
    currentRecursionDelayLevel = availableRecursionDelayLevels.shift();
}
```

**Step 6 — extend the recursion buffer** (L5016–5028):
```js
scanState = nextScanState;
if (scanState) {
    const text = successfulNewEntriesForRecursion.map(x => x.content).join('\n');
    if (text) { buffer.addRecurse(text); allActivatedText = (text + '\n' + allActivatedText); }
}
```

**Step 7 — emit `WORLDINFO_SCAN_DONE`** with a mutable args object (`state.next`, `activated.text`, `recursionDelay.currentLevel`, `budget.current`, `budget.overflowed` are read back after the event, L5060–5067), letting extensions steer the loop.

### 3.6 Building the output (L5070–5162)

```js
[...allActivatedEntries.values()].sort(sortFn).forEach((entry) => {
    const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
    const content = getRegexedString(entry.content, regex_placement.WORLD_INFO, { depth: regexDepth, isMarkdown: false, isPrompt: true });
    if (!content) return;                 // empty after regex scripts → dropped
    switch (entry.position) { ... }
});
```
Buckets, all filled with **`unshift`** (comment: *"Appends from insertion order 999 to 1"*) so that within a bucket the final array reads low-order-first:
- `WIBeforeEntries` → joined with `'\n'` into `worldInfoBefore`
- `WIAfterEntries` → `worldInfoAfter`
- `EMEntries` → `{ position: wi_anchor_position.before|after, content }` objects
- `ANTopEntries` / `ANBottomEntries` → returned as `ANBeforeEntries` / `ANAfterEntries`, and spliced into the Author's Note via `setExtensionPrompt(NOTE_MODULE_NAME, ...)` if `shouldWIAddPrompt`
- `WIDepthEntries` → array of `{ depth, entries: string[], role }`, merged by matching **both** `depth` and `role`; new buckets `push`, existing buckets `unshift`
- `WIOutletEntries` → `{ [outletName]: string[] }`, filled with **`push`** (the one bucket that isn't reversed)

Then `timedEffects.setTimedEffects(activated)` writes sticky/cooldown metadata, `buffer.resetExternalEffects()`, `timedEffects.cleanUp()`.

Return value:
```js
{ worldInfoBefore, worldInfoAfter, EMEntries, WIDepthEntries,
  ANBeforeEntries: ANTopEntries, ANAfterEntries: ANBottomEntries,
  outletEntries: WIOutletEntries, allActivatedEntries: new Set(allActivatedEntries.values()) }
```
`getWorldInfoPrompt` then emits `WORLD_INFO_ACTIVATED` (skipped on dry runs) and returns `worldInfoString = worldInfoBefore + worldInfoAfter`.

### 3.7 Inclusion groups (L5269–5356)

Grouping: `newEntries.filter(x => x.group)` reduced by `item.group.split(/,\s*/)` → `Record<groupName, entries[]>` (an entry can be in several groups).

Order of filters:
1. **`filterGroupsByTimedEffects`** (L5218): if a group has any sticky-active member, remove all non-sticky members and mark `hasStickyMap[group] = true`. Then remove members on cooldown, then members on delay.
2. **`filterGroupsByScoring`** (L5173): skipped when `!world_info_use_group_scoring && !group.some(x => x.useGroupScoring)`, or when the group has stickies. Otherwise `scores = group.map(e => buffer.getScore(e, scanState))`, `maxScore = Math.max(...scores)`, and every member with `useGroupScoring ?? world_info_use_group_scoring` truthy whose score `< maxScore` is removed.
3. Main pass per group: skip if sticky; if any already-activated entry has `x.group === key`, remove **all** members (group already satisfied); skip if `length <= 1`; **priority override** — `group.filter(x => x.groupOverride).sort(sortFn)` → `prios[0]` wins; otherwise **weighted random**:
```js
const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? DEFAULT_WEIGHT), 0);
const rollValue = Math.random() * totalWeight;
let currentWeight = 0;
for (const entry of group) { currentWeight += (entry.groupWeight ?? DEFAULT_WEIGHT); if (rollValue <= currentWeight) { winner = entry; break; } }
removeAllBut(group, winner);
```

**Group scoring** (`WorldInfoBuffer.getScore`, L428): counts how many primary keys match (`primaryScore`) and how many secondary keys match (`secondaryScore`). Returns `0` if no primary keys exist. If there are secondary keys, only *positive* logic contributes: `AND_ANY → primaryScore + secondaryScore`; `AND_ALL → (secondaryScore === numberOfSecondaryKeys) ? primaryScore + secondaryScore : primaryScore`; `NOT_ALL`/`NOT_ANY` fall through to `primaryScore`.

### 3.8 Timed effects details (`WorldInfoTimedEffects`, L479)

Persisted in `chat_metadata.timedWorldInfo = { sticky: {}, cooldown: {} }`, keyed `` `${world}.${uid}` ``, value `{ hash, start, end, protected }` where `start = chat.length` at set time and `end = chat.length + Number(entry[type])`.

`checkTimedEffects()` (L682) — sticky and cooldown are **skipped entirely on dry runs**; delay is always evaluated. `#checkTimedEffectOfType` removes an effect when: chat hasn't advanced past `start` and not `protected`; entry not found and `chat.length >= end`; entry no longer configured for that effect; or `chat.length >= end` (in which case `onEnded` fires — for sticky that immediately starts a **protected** cooldown, L518–529).

---

## 4. KEY MATCHING

`WorldInfoBuffer.matchKeys(haystack, needle, entry)` (L337):

```js
matchKeys(haystack, needle, entry) {
    // If the needle is a regex, we do regex pattern matching and override all the other options
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) return keyRegex.test(haystack);

    haystack = this.#transformString(haystack, entry);
    const transformedString = this.#transformString(needle, entry);
    const matchWholeWords = entry.matchWholeWords ?? world_info_match_whole_words;

    if (matchWholeWords) {
        const keyWords = transformedString.split(/\s+/);
        if (keyWords.length > 1) {
            return haystack.includes(transformedString);       // multi-word ⇒ plain substring
        } else {
            const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
            if (regex.test(haystack)) return true;
        }
    } else {
        return haystack.includes(transformedString);           // plain substring
    }
    return false;
}
```

Key facts:
- **Default matching is naive `String.includes` substring matching**, case-insensitive by default (`world_info_case_sensitive = false`).
- Case handling: `#transformString` (L268) → `(entry.caseSensitive ?? world_info_case_sensitive) ? str : str.toLowerCase()`. Applied to both haystack and needle. It is **not** applied to regex keys — a regex key must carry its own `i` flag.
- Whole-word mode uses `(?:^|\W)(escaped)(?:$|\W)` — custom boundaries that count punctuation, not `\b`. The regex is built **unflagged** (so it is case-sensitive at the regex level, but both strings were already lowercased upstream unless caseSensitive is on). Multi-word needles fall back to substring matching (whole-word is meaningless for phrases here).
- The `\x01` MATCHER prefix inserted between buffer segments is a `\W` char, so whole-word matches at segment starts/ends work and matches cannot straddle two messages.
- Macros: both primary and secondary keys are run through `substituteParams(key)` and `.trim()`ed before matching (L4803, L4835). Falsy (empty after substitution) keys never match.

### 4.1 Regex keys — `parseRegexFromString` (L2821)

```js
export function parseRegexFromString(input) {
    let match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;                       // Not a valid regex format
    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) return null; // unescaped inner slash → reject
    pattern = pattern.replace('\\/', '/');         // NOTE: no /g — only the FIRST escaped slash is unescaped
    try { return new RegExp(pattern, flags); } catch (e) { return null; }
}
```
- Format: `/pattern/flags`, flags limited to `g i m s u y`.
- Every `/` inside the pattern must be backslash-escaped, otherwise the key is treated as plain text.
- A valid regex key **overrides case sensitivity and whole-word settings entirely**.
- Caveat: `.replace('\\/', '/')` is a string replace, so only the first escaped slash is unescaped (a latent bug for multi-slash patterns).
- Beware: with a `g` flag, `RegExp.prototype.test` is stateful (`lastIndex`), and the same RegExp object is recreated per call here so it happens to be safe — but a ported implementation should avoid `g` on cached regexes.
- `splitKeywordsAndRegexes()` / `customTokenizer()` (L2717/L2745) parse a comma-separated key string into tokens while keeping commas inside `/.../` intact.

---

## 5. Related enums / values quick reference

| Constant | Value |
|---|---|
| `world_info_logic.AND_ANY / NOT_ALL / NOT_ANY / AND_ALL` | 0 / 1 / 2 / 3 |
| `world_info_position.before/after/ANTop/ANBottom/atDepth/EMTop/EMBottom/outlet` | 0/1/2/3/4/5/6/7 |
| `wi_anchor_position.before/after` | 0 / 1 |
| `scan_state.NONE/INITIAL/RECURSION/MIN_ACTIVATIONS` | 0/1/2/3 |
| `world_info_insertion_strategy.evenly/character_first/global_first` | 0/1/2 |
| `extension_prompt_roles.SYSTEM/USER/ASSISTANT` | 0/1/2 |
| `DEFAULT_DEPTH` | 4 |
| `DEFAULT_WEIGHT` | 100 |
| `MAX_SCAN_DEPTH` | 1000 |
| `MAX_COMMENT_LENGTH` | 100 |
| `MAX_UID` | 1_000_000 |
| `KNOWN_DECORATORS` | `['@@activate', '@@dont_activate']` |
| `GENERATION_TYPE_TRIGGERS` | `['normal','continue','impersonate','swipe','regenerate','quiet']` |
| UI clamps | groupWeight 1–10000 (clamped); sticky/cooldown/delay 1–10000 (not clamped); probability 0–100 (clamped); scanDepth 0–1000 (floored); depth 0–1000 (not clamped) |


## Reusable
**Copy nearly verbatim (pure logic, no DOM, no jQuery):**

1. `world_info_logic`, `world_info_position`, `wi_anchor_position`, `scan_state`, `world_info_insertion_strategy`, `extension_prompt_roles` — port as TS `const enum`s / union types with the exact numeric values so existing lorebook JSON stays compatible.
2. `newWorldInfoEntryDefinition` (L4002) — this is your entry schema. In TS, express it as an `interface WIEntry` plus a `DEFAULT_ENTRY` object built from the same defaults. Keep the tri-state `null` semantics for `scanDepth`/`caseSensitive`/`matchWholeWords`/`useGroupScoring`/`sticky`/`cooldown`/`delay` — `null` means "inherit global", which is not the same as `false`/`0`.
3. `parseRegexFromString` (L2821) and `matchKeys` (L337) — small, self-contained, and define the entire matching contract. Fix the `.replace('\\/', '/')` → `.replaceAll` bug while porting.
4. `WorldInfoBuffer` (L199) — the `#depthBuffer` / `#recurseBuffer` / `#injectBuffer` / `#globalScanData` split with the `\x01` MATCHER joiner. This class is framework-free; make it a plain TS class the Pinia store instantiates per scan.
5. `getScore` (L428) and `filterByInclusionGroups` / `filterGroupsByScoring` / `filterGroupsByTimedEffects` (L5173–5356) — copy the algorithms as-is.
6. `checkWorldInfo`'s loop skeleton (L4654–5068) — the `scanState` state machine, the rejection cascade ordering, the sticky-first candidate sort, the `ignoresBudget` walk, and the recursion-buffer extension. The exact ordering of the rejection cascade is load-bearing for compatibility; don't reorder it.
7. `parseDecorators` (L4540) if you want `@@activate` / `@@dont_activate` compatibility — 45 lines, trivial.
8. `convertCharacterBook` / `originalWIDataKeyMap` (L5498 / L2607) — required if you want to import real V2/V3 character cards and community lorebooks. The `extensions.*` snake_case mapping is the interchange format.

**Adapt:**

- **Persistence.** Replace `chat_metadata.timedWorldInfo` (a blob hung off the chat file) with an IndexedDB object store `timedEffects` keyed `[chatId, world, uid]` storing `{ hash, start, end, protected }`. `WorldInfoTimedEffects` (L479) reads/writes that map synchronously today; in the IndexedDB app, load the whole map for the current chat into the Pinia store before a scan and flush after.
- **Book storage.** `worldInfoCache` is a `StructuredCloneMap` over server-fetched JSON. In IndexedDB, store one record per book (`{ name, entries: Record<uid, WIEntry> }`) and keep an in-memory Pinia cache; keep the `structuredClone` on read (`getSortedEntries` ends with `return structuredClone(entries)`) because the scan mutates `entry.content` in place.
- **Token counting.** `getTokenCountAsync` is an async server call, awaited inside the budget loop (once per entry per pass) — that's a lot of round-trips. In a local Vue app, use a synchronous tokenizer (gpt-tokenizer / js-tiktoken) or a cheap char/4 estimate, and make the whole budget loop synchronous. This alone removes most of the `async`/`await` from `checkWorldInfo`.
- **Entry sources.** `getGlobalLore`/`getCharacterLore`/`getChatLore`/`getPersonaLore` (L4363–4476) reach into `this_chid`, `characters[]`, `chat_metadata`, `power_user`. Replace with a single `resolveActiveBooks()` in the store that returns `{ global, character, chat, persona }` arrays; keep the de-duplication-by-book-name rule and the "chat lore first, then persona lore, then strategy-sorted global/character" ordering (L4513).
- **Output bucketing.** Keep the bucket set (`before / after / EMTop / EMBottom / ANTop / ANBottom / atDepth(depth,role) / outlet`) but return it as a typed object rather than mutating a global extension-prompt registry. The `unshift`-everywhere convention (and `push` for outlets) must be preserved or the relative order of same-position entries flips.
- **Events.** `WORLDINFO_ENTRIES_LOADED`, `WORLDINFO_SCAN_DONE` (with its mutable args contract), `WORLD_INFO_ACTIVATED`, `WORLDINFO_FORCE_ACTIVATE` → a Pinia action + a small typed emitter, or just drop them for v1. The mutable-args pattern (L5060–5067, where listeners can rewrite `scanState`/`budget`) is a plugin hook you almost certainly don't need.

**Do NOT bother porting:**

- Everything from ~L1049–4000 that is UI: `registerWorldInfoSlashCommands` (~1000 lines of SlashCommand definitions), `displayWorldEntries`, `getWorldEntry` and all the `handle*Helper` functions, select2/jQuery-UI autocomplete (`customTokenizer` is worth keeping only as the key-string parser), pagination, drag-sort/`displayIndex`, the Fuse-based search filter.
- `setWIOriginalDataValue` / `deleteWIOriginalDataValue` / the whole `originalData` round-trip machinery — that exists only to preserve unknown fields of imported character cards on re-export. Skip unless you need lossless re-export.
- `convertAgnaiMemoryBook`, `convertRisuLorebook`, `convertNovelLorebook` — only if you need those import formats.
- `addMemo` and `selective` — dead fields kept for file-format compatibility (`selective` is force-true and its input is hidden; `addMemo` only toggles a textarea). Store and round-trip them, never branch on them.
- `vectorized` — store the flag but there is no logic for it in `checkWorldInfo`; it only matters if you build a vector-retrieval path.
- `automationId` — inert unless you implement the Quick Reply automation system.
- The `world_info_overflow_alert` toastr, `console.debug` logging scaffolding, and the `log()` closure per entry.