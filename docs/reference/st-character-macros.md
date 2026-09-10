# SillyTavern character card format (v1/v2) + macro substitution engine (legacy regex engine and new CST-based engine), example-dialogue parsing/injection, alternate greetings, and group-chat name resolution

## Key files
- D:\tauriApp\SillyTavern\public\scripts\char-data.js — JSDoc typedefs only (no runtime code, exports 0). Defines v1CharData, v2CharData, v2CharDataExtensionInfos, v2WorldInfoBook, v2DataWorldInfoEntry, v2DataWorldInfoEntryExtensionInfos, RegexScriptData. This is the authoritative field list for the character card model.
- D:\tauriApp\SillyTavern\public\script.js — Core app. Contains substituteParams / substituteParamsLegacy / substituteParamsExtended (lines 2750-2956), baseChatReplace (3282), CharacterCardFields typedef + createLazyFields + getCharacterCardFieldsLazy + getCharacterCardFields (3295-3435), parseMesExamples (3442), getFirstMessage / alternate-greeting-to-swipes (7651-7683), alternate greetings editor UI (9562-9682), create_save defaults (569-592), name1/name2 globals (404-408, 7034, 7084), Generate() prompt assembly (4400-5000).
- D:\tauriApp\SillyTavern\public\scripts\macros.js — LEGACY macro engine. MacrosParser (deprecated registry), evaluateMacros(content, env, postProcessFn) — the ordered array of {regex, replace} macros (preEnv / env / postEnv), plus getRandomReplaceMacro, getPickReplaceMacro, getDiceRollMacro, getTimeDiffMacro, getBannedWordsMacro, getOutletPrompt, initMacros.
- D:\tauriApp\SillyTavern\public\scripts\macros\macro-system.js — Entry point of the NEW macro engine: exports `macros` singleton bundle (engine, registry, envBuilder, lexer, parser, cstWalker) and initRegisterMacros() which registers core/env/state/chat/time/variable/instruct macro sets in a fixed order.
- D:\tauriApp\SillyTavern\public\scripts\macros\engine\MacroEngine.js — New engine: evaluate(input, env, {contextOffset}) → pre-processors → chevrotain lex/parse → MacroCstWalker.evaluateDocument → post-processors. Also #resolveMacro (dynamic macro override, unknown-macro passthrough), normalizeMacroResult, trimScopedContent (trim + dedent).
- D:\tauriApp\SillyTavern\public\scripts\macros\engine\MacroEnvBuilder.js — Builds the MacroEnv passed to handlers: lazy character-card getters, names.user/char/group/groupNotMuted/notChar (group resolution logic lives in getGroupValue at the bottom), system.model, functions.original (one-shot), dynamicMacros (lowercased keys), pluggable providers.
- D:\tauriApp\SillyTavern\public\scripts\macros\engine\MacroRegistry.js — Macro definition registry: MacroCategory + MacroValueType enums, registerMacro/registerMacroAlias, arg-count validation, executeMacro() which builds the MacroExecutionContext (unnamedArgs, list, flags, isScoped, globalOffset, resolve(), trimContent(), normalize(), warn()).
- D:\tauriApp\SillyTavern\public\scripts\macros\engine\MacroLexer.js — Chevrotain token/mode definitions: {{ }} delimiters, flag chars [!?~#/] and >, :: and : argument separators, quotes, variable shorthand prefixes . and $ with operators (++, --, ??, ??=, ||, ||=, +=, -=, ==, !=, >=, <=), identifier patterns.
- D:\tauriApp\SillyTavern\public\scripts\macros\engine\MacroCstWalker.js — Walks the CST, resolves nested macros inside-out (arguments and scoped content evaluated first unless delayArgResolution), pairs {{x}}...{{/x}} scoped macros, computes globalOffset used for deterministic {{pick}} seeding.
- D:\tauriApp\SillyTavern\public\scripts\macros\definitions\core-macros.js — Registers {{space}}, {{newline}}, {{noop}}, {{trim}}, {{if}}/{{else}}, {{input}}, {{maxPrompt|maxContext|maxResponse}}, {{reverse}}, {{//}} comment, {{roll}}, {{random}}, {{pick}}, {{banned}}, {{outlet}}. Contains ELSE_MARKER and the list-splitting helper.
- D:\tauriApp\SillyTavern\public\scripts\macros\definitions\env-macros.js — Registers name and character-card macros: {{user}}, {{char}}, {{group}}/{{charIfNotGroup}}, {{groupNotMuted}}, {{notChar}}, {{charPrompt}}, {{charInstruction}}, {{charDescription|description}}, {{charPersonality|personality}}, {{charScenario|scenario}}, {{persona}}, {{mesExamples}}, {{mesExamplesRaw}}, {{charDepthPrompt}}, {{charCreatorNotes|creatorNotes}}, {{charFirstMessage|greeting[::index]}}, {{charVersion|version|char_version}}, {{model}}, {{original}}, {{isMobile}}.
- D:\tauriApp\SillyTavern\public\scripts\macros\definitions\variable-macros.js — New-engine variable macros: setvar, addvar, incvar, decvar, getvar, hasvar/varexists, deletevar/flushvar and the global* equivalents.
- D:\tauriApp\SillyTavern\public\scripts\macros\definitions\time-macros.js — {{time[::UTC±n]}}, {{date}}, {{weekday}}, {{isotime}}, {{isodate}}, {{datetimeformat::fmt}}, {{idleDuration|idle_duration}}, {{timeDiff::a::b}}.
- D:\tauriApp\SillyTavern\public\scripts\macros\definitions\chat-macros.js — {{lastMessage}}, {{lastMessageId}}, {{lastUserMessage}}, {{lastCharMessage}}, {{firstIncludedMessageId}}, {{firstDisplayedMessageId}}, {{lastSwipeId}}, {{currentSwipeId}}, {{allChatRange}}.
- D:\tauriApp\SillyTavern\public\scripts\macros\definitions\state-macros.js — {{lastGenerationType}} (tracked via GENERATION_STARTED/CHAT_CHANGED events) and {{hasExtension::name}}.
- D:\tauriApp\SillyTavern\public\scripts\macros\engine\MacroFlags.js — Flag symbol enum and parser: ! immediate (unimplemented), ? delayed (unimplemented), ~ reevaluate (unimplemented), > filter (parsed only), / closing block (implemented), # preserve whitespace (implemented).
- D:\tauriApp\SillyTavern\public\scripts\group-chats.js — Group chats: group_generation_mode enum (SWAP 0 / APPEND 1 / APPEND_DISABLED 2), getGroupCharacterCards / getGroupCharacterCardsLazy (joins member cards with <FIELDNAME> prefixes/suffixes), getGroupDepthPrompts, getFirstCharacterMessage (random alternate greeting per member on fresh group chat), setCharacterName() calls that make {{char}} the currently-speaking member during generation.
- D:\tauriApp\SillyTavern\public\scripts\openai.js — Chat Completion path: setOpenAIMessageExamples (replaces <START> with '{Example Dialogue:}'), parseExampleIntoIndividual (splits an example block into example_user/example_assistant system messages), populateDialogueExamples (inserts them under the 'dialogueExamples' prompt collection with the new_example_chat_prompt '[Example Chat]' separator).
- D:\tauriApp\SillyTavern\public\scripts\instruct-mode.js — formatInstructModeExamples (line 511) turns <START> blocks into instruct-wrapped user/assistant turns; getInstructMacros (line 673) returns the legacy {{instruct*}}/{{systemPrompt}}/{{chatSeparator}}/{{chatStart}} macro list.
- D:\tauriApp\SillyTavern\public\scripts\variables.js — Legacy getVariableMacros() — the regex list for {{setvar}}/{{addvar}}/{{incvar}}/{{decvar}}/{{getvar}} and global variants (lines 238-261).
- D:\tauriApp\SillyTavern\src\endpoints\characters.js — Server-side card writing/reading: charaFormatData() builds the on-disk v1+v2 hybrid JSON (spec 'chara_card_v2', spec_version '2.0'), readFromV2() mirrors data.* back into the v1 top-level fields, convertWorldInfoToCharacterBook().
- D:\tauriApp\SillyTavern\default\content\presets\context\Default.json — Default context template: story_string handlebars template, example_separator '***', chat_start '***'. Shows how card fields are assembled into the text-completion prompt.

## Report
# SillyTavern: Character Card Format + Macro Substitution — Exhaustive Spec

Version note: this checkout implements **Character Card Spec V2 only** (`spec: 'chara_card_v2'`, `spec_version: '2.0'`). There is **no V3 support**: `group_only_greetings`, `nickname`, `creator_notes_multilingual`, `assets`, `source`, `creation_date`, and `chara_card_v3` do not appear anywhere in the repo (verified by ripgrep over the whole tree). Also note: **`formatCharacterDescription` does not exist** in this codebase — the equivalent responsibilities are split between `baseChatReplace()` and `getCharacterCardFieldsLazy()` in `public/script.js`.

There are **two macro engines living side by side**, switched by the `power_user.experimental_macro_engine` flag:
1. **Legacy** — ordered array of regex replacements (`public/scripts/macros.js` → `evaluateMacros`).
2. **New** — chevrotain lexer/parser + CST walker + macro registry (`public/scripts/macros/**`).

---

## 1. CHARACTER CARD DATA MODEL

### 1.1 On-disk / in-memory object (`v1CharData`, the object stored in the global `characters[]` array)

From `public/scripts/char-data.js` lines 104-123 plus the ST-server additions:

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Character name. Mirrored from `data.name`. Becomes `name2` / `{{char}}` when the char is selected. |
| `description` | string | Main character description. The largest card field; goes into `{{description}}` / story string. |
| `personality` | string | Short personality summary → `{{personality}}`. |
| `scenario` | string | Setting/background → `{{scenario}}`. Overridable per-chat by `chat_metadata.scenario`. |
| `first_mes` | string | Opening greeting. Becomes chat message #0 in a fresh chat. |
| `mes_example` | string | Example dialogue, `<START>`-delimited (see §3). Overridable per-chat by `chat_metadata.mes_example`. |
| `creatorcomment` | string | Legacy V1 creator notes (server mirrors `data.creator_notes` here for back-compat). |
| `tags` | string[] | Keyword labels. Mirrored from `data.tags`. |
| `talkativeness` | number | 0..1, default `0.5` (`talkativeness_default` in script.js:548). Probability weight for group "natural order" auto-speaker selection. Mirrored from `data.extensions.talkativeness`. |
| `fav` | boolean\|string | Favorite flag. Mirrored from `data.extensions.fav`. Note: server writes `data.fav == 'true'` (form value is a string). |
| `create_date` | string | Creation timestamp. |
| `data` | v2CharData | The Spec V2 payload (below). |
| `chat` | string | **ST-only, not spec**: file name of the currently-open chat for this char (`"<name> - <humanized date>"`). |
| `avatar` | string | **ST-only**: PNG file name; acts as the *unique identifier* for the character everywhere (group `members[]` store avatars, not names). |
| `json_data` | string | **ST-only**: the full raw JSON of the card, kept so foreign/unknown keys survive a round-trip. |
| `shallow` | boolean? | **ST-only**: true when the card was lazy-loaded (list view) and `data` is not fully populated. |

### 1.2 `v2CharData` — the `data` object (char-data.js lines 50-67)

| Field | Type | Meaning |
|---|---|---|
| `name` | string | Character name (canonical in V2). |
| `description` | string | Description. |
| `personality` | string | Personality summary. |
| `scenario` | string | Scenario. |
| `first_mes` | string | First message / greeting. |
| `mes_example` | string | Example messages. |
| `creator_notes` | string | Notes from the creator; **not** sent to the model by default, but exposed as `{{charCreatorNotes}}`/`{{creatorNotes}}` and scannable by World Info (`match_creator_notes`). |
| `system_prompt` | string | Character-level **Main Prompt override**. Only used if `power_user.prefer_character_prompt` is true. Exposed as `{{charPrompt}}`. Chat-level override: `chat_metadata.system_prompt` wins over it. |
| `post_history_instructions` | string | Character-level **Post-History Instructions / jailbreak override**. Only used if `power_user.prefer_character_jailbreak`. Exposed as `{{charInstruction}}` / `{{charJailbreak}}`. |
| `tags` | string[] | Tags. |
| `creator` | string | Creator name. |
| `character_version` | string | Free-form version string → `{{charVersion}}` / `{{char_version}}` / `{{version}}`. |
| `alternate_greetings` | string[] | Additional greetings (see §2). |
| `character_book` | v2WorldInfoBook | Embedded lorebook: `{ name: string, entries: v2DataWorldInfoEntry[] }`. |
| `extensions` | v2CharDataExtensionInfos | Free-form extension bag (below). |

### 1.3 `v2CharDataExtensionInfos` — `data.extensions` (char-data.js lines 68-85)

| Field | Type | Meaning |
|---|---|---|
| `talkativeness` | number | 0..1, default 0.5. Group auto-speaker weight. |
| `fav` | boolean | Favorite. (Server explicitly resets this in `unsetPrivateFields()` when exporting/sharing.) |
| `world` | string | Name of the linked World Info book (file name on the ST server). |
| `depth_prompt` | object | Character-specific author's note injected at a fixed depth. |
| `depth_prompt.prompt` | string | The injected text. Exposed as `{{charDepthPrompt}}`. |
| `depth_prompt.depth` | number | Injection depth in messages from the end. Default `4` (`depth_prompt_depth_default`, script.js:549). |
| `depth_prompt.role` | `'system'\|'user'\|'assistant'` | Role of the injected message. Default `'system'` (`depth_prompt_role_default`, script.js:550). |
| `regex_scripts` | RegexScriptData[] | Card-scoped regex scripts (id, scriptName, findRegex, replaceString, trimStrings, placement[], disabled, markdownOnly, promptOnly, runOnEdit, substituteRegex, minDepth, maxDepth). |
| `pygmalion_id` | string? | Non-standard, from Pygmalion.chat. |
| `github_repo` | string? | Non-standard. |
| `source_url` | string? | Non-standard. |
| `chub` | `{full_path: string}`? | Chub.ai metadata. |
| `risuai` | `{source: string[]}`? | RisuAI metadata. |
| `sd_character_prompt` | `{positive, negative}`? | Stable-Diffusion prompt hints. |

### 1.4 `character_book` entry model (`v2DataWorldInfoEntry`, char-data.js lines 1-42)

Top-level: `keys[]`, `secondary_keys[]`, `comment`, `content`, `constant`, `selective`, `insertion_order`, `enabled`, `position`, `id`, `extensions`.

`extensions` (`v2DataWorldInfoEntryExtensionInfos`): `position`, `exclude_recursion`, `probability`, `useProbability`, `depth`, `selectiveLogic`, `group`, `group_override`, `group_weight`, `prevent_recursion`, `delay_until_recursion`, `scan_depth`, `match_whole_words`, `use_group_scoring`, `case_sensitive`, `automation_id`, `role`, `vectorized`, `display_index`, plus the scan-target flags `match_persona_description`, `match_character_description`, `match_character_personality`, `match_character_depth_prompt`, `match_scenario`, `match_creator_notes`.

### 1.5 The V2 spec wrapper — how the file is actually written

`src/endpoints/characters.js` → `charaFormatData(data, directories)` (line 565). It starts from `tryParse(data.json_data) || {}` so unknown foreign keys are preserved, then:

```js
_.set(char, 'spec', 'chara_card_v2');
_.set(char, 'spec_version', '2.0');
// V1 mirror
_.set(char, 'name', data.ch_name); _.set(char, 'description', …); _.set(char, 'personality', …);
_.set(char, 'scenario', …); _.set(char, 'first_mes', …); _.set(char, 'mes_example', …);
_.set(char, 'creatorcomment', data.creator_notes || '');
_.set(char, 'talkativeness', data.talkativeness || 0.5);
_.set(char, 'fav', data.fav == 'true');
// V2 payload
_.set(char, 'data.name', …); … _.set(char, 'data.alternate_greetings', getAlternateGreetings(data));
_.set(char, 'data.extensions.talkativeness', data.talkativeness || 0.5);
_.set(char, 'data.extensions.fav', data.fav == 'true');
_.set(char, 'data.extensions.world', data.world || '');
_.set(char, 'data.extensions.depth_prompt.prompt', data.depth_prompt_prompt ?? '');
_.set(char, 'data.extensions.depth_prompt.depth', depth_value);   // default 4
_.set(char, 'data.extensions.depth_prompt.role', role_value);      // default 'system'
```

`getAlternateGreetings(data)` normalizes: array → as-is, string → `[string]`, otherwise `[]`.

`readFromV2(char)` (line 504) does the reverse mirror on load, using `fieldMappings = { name, description, personality, scenario, first_mes, mes_example, talkativeness: 'extensions.talkativeness', fav: 'extensions.fav', tags }`, back-filling `talkativeness=0.5` / `fav=false` when missing, and warning on V1↔V2 mismatch. `char.chat` is defaulted to `` `${char.name} - ${humanizedDateTime()}` ``.

### 1.6 The runtime "card fields" view (`getCharacterCardFields`)

`public/script.js` lines 3295-3435. Typedef `CharacterCardFields`: `system, mesExamples, description, personality, persona, scenario, jailbreak, version, charDepthPrompt, creatorNotes, firstMessage, alternateGreetings[]`.

`getCharacterCardFieldsLazy({chid})` builds **lazy memoized getters** (`createLazyFields`, line 3316) so nothing is macro-processed until read:

```js
persona:        () => baseChatReplace(power_user.persona_description?.trim()),
system:         () => power_user.prefer_character_prompt
                        ? baseChatReplace((chat_metadata.system_prompt || character.data?.system_prompt || '').trim()) : '',
jailbreak:      () => power_user.prefer_character_jailbreak
                        ? baseChatReplace(character.data?.post_history_instructions?.trim()) : '',
version:        () => character?.data?.character_version ?? '',
charDepthPrompt:() => baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim()),
creatorNotes:   () => baseChatReplace(character.data?.creator_notes?.trim()),
// group-overridable:
description:    () => groupCardsLazy ? groupCardsLazy.description : baseChatReplace(character.description?.trim()),
personality:    () => groupCardsLazy ? groupCardsLazy.personality : baseChatReplace(character.personality?.trim()),
scenario:       () => groupCardsLazy ? groupCardsLazy.scenario
                        : baseChatReplace((chat_metadata.scenario || character.scenario || '').trim()),
mesExamples:    () => groupCardsLazy ? groupCardsLazy.mesExamples
                        : baseChatReplace((chat_metadata.mes_example || character.mes_example || '').trim()),
firstMessage:   () => baseChatReplace(character.first_mes?.trim() || ''),
alternateGreetings: () => (character.data?.alternate_greetings ?? []).map(g => baseChatReplace(g?.trim())),
```

`baseChatReplace` (line 3282) is the single normalizer applied to every card field:

```js
export function baseChatReplace(value, name1Override = null, name2Override = null) {
    if (typeof value === 'string' && value.length > 0) {
        value = substituteParams(value, { name1Override, name2Override, replaceCharacterCard: false });
        if (power_user.collapse_newlines) { value = collapseNewlines(value); }
        value = value.replace(/\r/g, '');
    }
    return value;
}
```

`replaceCharacterCard: false` is the recursion guard: while expanding a card field, the card-field macros (`{{description}}`, `{{personality}}`, …) are **not** in the environment, so a description containing `{{description}}` cannot loop.

### 1.7 Where card fields land in the prompt

In `Generate()` (script.js ~4401):
* `description, personality, persona, scenario, mesExamples, system, jailbreak, charDepthPrompt, creatorNotes` are destructured from `getCharacterCardFields()`.
* **Depth prompt**: `removeDepthPrompts()`, then either `getGroupDepthPrompts(...)` (group, non-SWAP modes) each injected with `inject_ids.DEPTH_PROMPT_INDEX(i)`, or the solo `inject_ids.DEPTH_PROMPT` at `depth_prompt.depth` with `depth_prompt.role` (`extension_prompt_types.IN_CHAT`).
* **Story string** (text-completion path) is a Handlebars template rendered with `storyStringParams = { description, personality, persona (only if persona position == IN_PROMPT), scenario, system, char: name2, user: name1, wiBefore, wiAfter, loreBefore, loreAfter, anchorBefore, anchorAfter, mesExamples, mesExamplesRaw }`. Default template (`default/content/presets/context/Default.json`):
  `{{#if anchorBefore}}…{{/if}}{{#if system}}…{{/if}}{{#if wiBefore}}…{{/if}}{{#if description}}…{{/if}}{{#if personality}}…{{/if}}{{#if scenario}}…{{/if}}{{#if wiAfter}}…{{/if}}{{#if persona}}…{{/if}}{{#if anchorAfter}}…{{/if}}{{trim}}` with `example_separator: "***"`, `chat_start: "***"`.
* Card fields also feed World Info scanning via `globalScanData = { personaDescription, characterDescription, characterPersonality, characterDepthPrompt, scenario, creatorNotes, trigger }`.

---

## 2. ALTERNATE GREETINGS

### 2.1 Storage
`characters[chid].data.alternate_greetings: string[]` (V2 only — there is no V1 mirror). During character creation the editor buffers them in the module-level `create_save.alternate_greetings` array (script.js:586).

Serialization to the server is manual because the HTML form can't express arrays: in `createOrEditCharacter` the code does `formData.delete('alternate_greetings')` and then `formData.append('alternate_greetings', value)` once per entry — for the create path from `create_save` (lines 9724-9727) and for the edit path from `characters[chid].data.alternate_greetings` (lines 9815-9820).

### 2.2 Solo chat: greetings become **swipes** on message 0
`getFirstMessage()` (script.js:7651):

```js
function getFirstMessage() {
    const firstMes = characters[this_chid]?.first_mes || '';
    const alternateGreetings = characters[this_chid]?.data?.alternate_greetings;
    const message = { name: name2, is_user: false, is_system: false,
                      send_date: getMessageTimeStamp(),
                      mes: getRegexedString(firstMes, regex_placement.AI_OUTPUT), extra: {} };
    if (Array.isArray(alternateGreetings) && alternateGreetings.length > 0) {
        const swipes = [message.mes, ...alternateGreetings.map(g => getRegexedString(g, regex_placement.AI_OUTPUT))];
        if (!message.mes) { swipes.shift(); message.mes = swipes[0]; }   // empty first_mes → alt #1 becomes the shown one
        message.swipe_id = 0;
        message.swipes = swipes;
        message.swipe_info = swipes.map(_ => ({ send_date: message.send_date, gen_started: void 0, gen_finished: void 0, extra: {} }));
    }
    return message;
}
```

So in a 1-on-1 chat **no random choice happens**: index 0 (`first_mes`) is shown, and the user swipes left/right through `[first_mes, ...alternate_greetings]`. Regex scripts with `AI_OUTPUT` placement are applied to each greeting at this point (but macros are *not* — see next).

`getChatResult()` (7625) pushes that message only when `chat.length === 0`, saves the chat, then emits `CHAT_CHANGED`, `CHAT_CREATED` (if fresh), and for `chat.length === 1` also `MESSAGE_RECEIVED` + `CHARACTER_MESSAGE_RENDERED` with the reason `'first_message'`.

Macro expansion of the greeting is deferred to generation time: in `Generate()`, `if (chat.length) { chat[0].mes = substituteParams(chat[0].mes); }` with the comment *"First message in fresh 1-on-1 chat reacts to user/character settings changes"* (script.js:4430-4432).

### 2.3 Group chat: **one greeting picked at random per member**
`group-chats.js` `getFirstCharacterMessage(character)` (line 578):

```js
let messageText = character.first_mes;
if (Array.isArray(character.data?.alternate_greetings)) {
    const messageTexts = [character.first_mes, ...character.data.alternate_greetings].filter(x => x);
    messageText = messageTexts[Math.floor(Math.random() * messageTexts.length)];
}
const eventArgs = { input: messageText, output: '', character };
await eventSource.emit(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, eventArgs);
if (eventArgs.output) messageText = eventArgs.output;   // extensions may override
…
mes.mes = messageText ? substituteParams(messageText.trim(), { name2Override: character.name }) : '';
```

Note the differences vs solo: uniform random over `[first_mes, ...alts]` (empties filtered), extensions can override through `CHARACTER_FIRST_MESSAGE_SELECTED`, macros are substituted **immediately** with `{{char}}` forced to that member, and **no swipes array is created**. On a fresh group chat, `getGroupChat` (line 283-304) loops over `group.members`, pushes each member's message, and emits `MESSAGE_RECEIVED`/`CHARACTER_MESSAGE_RENDERED` with `'first_message'` per member.

### 2.4 Macro access
`{{charFirstMessage}}` (alias `{{greeting}}`) takes an optional 0-based index: `0` (default) = `first_mes`, `n ≥ 1` = `alternate_greetings[n-1]`, out of range = `''`. Note this macro exists **only in the new engine**; `substituteParamsLegacy` detects `{{greeting|charFirstMessage(::\d+)?}}` in text and triggers the "experimental macro engine" onboarding popup (script.js:2800).

### 2.5 Editor UI
`openAlternateGreetings()` (script.js:9562) clones `#alternate_greetings_template .alternate_grettings` into a wide `Popup`, ensures `characters[chid].data.alternate_greetings` is an array, and calls `addAlternateGreeting()` per entry. Each row (`#alternate_greeting_form_template .alternate_greeting`) has `data-index`, a textarea `#alternate_greeting_{index}` bound with `.on('input')` → `array[index] = value`, a maximize button, a 1-based `.greeting_index` label, delete (confirm popup → `array.splice(index,1)` → close + reopen popup to renumber), and move up/down (swap `array[index]`/`array[newIndex]`, update both textareas). Adding pushes `''` and scrolls to bottom. `onClose` calls `createOrEditCharacter()` to persist (except in `create` mode). `power-user.js:2145` includes `data.alternate_greetings` in fuzzy character search with weight 1.

---

## 3. `mes_example` / DIALOGUE EXAMPLES

### 3.1 Expected format
A card's `mes_example` is a sequence of **blocks separated by the literal token `<START>`**. Inside a block, lines are `Name: text`, where the names are the *runtime* user name (`name1`) and character name (`name2`) — cards typically write `{{user}}:` and `{{char}}:` and rely on macro substitution:

```
<START>
{{user}}: Hi there!
{{char}}: *smiles* Hello. What brings you here?
<START>
{{user}}: Who are you?
{{char}}: I am nobody in particular.
```

### 3.2 Parsing into blocks — `parseMesExamples` (script.js:3442)

```js
export function parseMesExamples(examplesStr, isInstruct) {
    if (!examplesStr || examplesStr.length === 0 || examplesStr === '<START>') return [];
    if (!examplesStr.startsWith('<START>')) examplesStr = '<START>\n' + examplesStr.trim();
    const exampleSeparator = power_user.context.example_separator ? `${substituteParams(power_user.context.example_separator)}\n` : '';
    const blockHeading = (main_api === 'openai' || isInstruct) ? '<START>\n' : exampleSeparator;
    const splitExamples = examplesStr.split(/<START>/gi).slice(1).map(block => `${blockHeading}${block.trim()}\n`);
    return splitExamples;
}
```

Key points: split is case-insensitive and global; `.slice(1)` drops the empty piece before the first `<START>`; each block is trimmed and gets a trailing `\n`. The heading is **kept as literal `<START>\n`** for Chat Completion and Instruct (both consume it later), but for plain text completion it is replaced by `context.example_separator` (default `"***"`, empty in most instruct-oriented presets).

### 3.3 Injection paths (all in `Generate()`, script.js 4557-4970)

1. `let mesExamplesArray = parseMesExamples(mesExamples, isInstruct);`
2. **World Info example entries** are merged in: for each `worldInfoExamples` entry, `baseChatReplace(content)` → `parseMesExamples` → `unshift` if `example.position === wi_anchor_position.before`, else `push`.
3. `const mesExamplesRawArray = [...mesExamplesArray];` — snapshot before instruct wrapping (exposed as `{{mesExamplesRaw}}` in the story string).
4. If instruct: `mesExamplesArray = formatInstructModeExamples(mesExamplesArray, name1, name2)`.
5. Both `mesExamples` (formatted) and `mesExamplesRaw` go into `storyStringParams` for the context template.
6. `if (power_user.strip_examples) mesExamplesArray = [];` — after the story string is rendered.
7. **Pinned vs budgeted**: if `power_user.pin_examples`, `pinExmString = examplesString = mesExamplesArray.join('')` (all examples forced in). Otherwise the loop at 4901-4911 adds examples one at a time while `tokenCount < this_max_context`, counting `count_exm_add`; `setPromptString()` then uses `mesExmString = pinExmString ?? mesExamplesArray.slice(0, count_exm_add).join('')`.

So for **text completion** examples are a *string block* placed before the chat history, not chat messages.

### 3.4 Instruct-mode formatting — `formatInstructModeExamples` (instruct-mode.js:511)
`blockHeading = context.example_separator ? substituteParams(example_separator)+'\n' : ''`. If `power_user.instruct.skip_examples`, it merely replaces the leading `<START>\n` with the block heading. Otherwise it wraps each `name1:`/`name2:` line with the instruct `input_sequence`/`input_suffix` and `output_sequence`/`output_suffix`, applying `{{name}}` substitution (→ `name1` for input, `name2` for output) when `instruct.macro` is on, and defaulting suffixes to `'\n'` when `instruct.wrap`.

### 3.5 Chat Completion — examples become real messages
* `setOpenAIMessageExamples(mesExamplesArray)` (openai.js:652): for each block, `item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm,'')`, then `parseExampleIntoIndividual(replaced, true)`; returns an **array of arrays** (one array of messages per block).
* `parseExampleIntoIndividual(messageExampleString, appendNamesForGroup = true)` (openai.js:725): splits on `\n`, **skips line 0** (the `{Example Dialogue:}` heading), and state-machines through the lines: a line starting with `name1 + ':'` switches to user mode, a line starting with `name2 + ':'` (or any group member name + `':'`, via `getGroupNames()`) switches to bot mode. On each switch it flushes the accumulated lines through `add_msg(name, 'system', system_name)`, which joins with `\n`, strips the leading `"Name:"`, trims, and — **in group chats** — re-prefixes `"${name}: "`. Result objects are `{ role: 'system', content, name: 'example_user' | 'example_assistant' }`. A final flush handles the last speaker in the block.
* `populateDialogueExamples(prompts, chatCompletion, messageExamples)` (openai.js:1097): creates a `MessageCollection('dialogueExamples')` at the prompt-manager index, builds a `newExampleChat` system message from `substituteParams(oai_settings.new_example_chat_prompt)` (default `'[Example Chat]'`, openai.js:109), then per block checks `chatCompletion.canAffordAll([newExampleChat, ...chatMessages])` and `break`s when the budget is exhausted; otherwise inserts the `[Example Chat]` marker followed by the block's messages (each `role: 'system'`, with `name` set to `example_user`/`example_assistant`).

### 3.6 Group-chat example messages
`getGroupCharacterCardsLazy(...).mesExamples` (group-chats.js:568) joins every member's `mes_example`, normalizing each with `x => !x.startsWith('<START>') ? '<START>\n'+x : x` before applying the group join prefix/suffix.

---

## 4. THE MACRO ENGINE

### 4.A Entry points

```js
// script.js:2922 — modern signature
substituteParams(content, {
  name1Override, name2Override, original, groupOverride,
  replaceCharacterCard = true, dynamicMacros = {}, postProcessFn = x => x
})
```
* Non-object second arg → routed to `substituteParamsLegacy.call(this, ...arguments)` (old positional signature `(content, _name1, _name2, _original, _group, _replaceCharacterCard, additionalMacro, postProcessFn)`).
* If `!power_user.experimental_macro_engine` → `substituteParamsLegacy(...)`.
* Else: `MacroEnvBuilder.buildFromRawEnv(ctx)` → `MacroEngine.evaluate(content, env)`.
* `substituteParamsExtended(content, additionalMacro, postProcessFn)` is a deprecated shim over the new signature.

Handlebars bridge (macros.js:19-25): `Handlebars.registerHelper('trim', () => '{{trim}}')` keeps `{{trim}}` alive through story-string compilation, and `helperMissing` re-emits `substituteParams('{{'+macroName+'}}')` so unknown handlebars helpers in a context template fall through to the macro engine.

---

### 4.B LEGACY ENGINE — `evaluateMacros` (macros.js:610-715) — **quoted implementation**

```js
export function evaluateMacros(content, env, postProcessFn) {
    if (!content) { return ''; }
    postProcessFn = typeof postProcessFn === 'function' ? postProcessFn : (x => x);
    const rawContent = content;

    /** Built-ins running BEFORE the env variables */
    const preEnvMacros = [
        { regex: /<USER>/gi,            replace: () => typeof env.user  === 'function' ? env.user()  : env.user },
        { regex: /<BOT>/gi,             replace: () => typeof env.char  === 'function' ? env.char()  : env.char },
        { regex: /<CHAR>/gi,            replace: () => typeof env.char  === 'function' ? env.char()  : env.char },
        { regex: /<CHARIFNOTGROUP>/gi,  replace: () => typeof env.group === 'function' ? env.group() : env.group },
        { regex: /<GROUP>/gi,           replace: () => typeof env.group === 'function' ? env.group() : env.group },
        getDiceRollMacro(),
        ...getInstructMacros(env),
        ...getVariableMacros(),
        { regex: /{{newline}}/gi, replace: () => '\n' },
        { regex: /(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, replace: () => '' },
        { regex: /{{noop}}/gi, replace: () => '' },
        { regex: /{{input}}/gi, replace: () => String($('#send_textarea').val()) },
    ];

    /** Built-ins running AFTER the env variables */
    const postEnvMacros = [
        { regex: /{{maxPrompt}}/gi,   replace: () => String(getMaxPromptTokens()) },
        { regex: /{{maxPromptTokens}}/gi, replace: () => String(getMaxPromptTokens()) },
        { regex: /{{maxContext}}/gi,  replace: () => String(getMaxContextTokens()) },
        { regex: /{{maxContextTokens}}/gi, replace: () => String(getMaxContextTokens()) },
        { regex: /{{maxResponse}}/gi, replace: () => String(getMaxResponseTokens()) },
        { regex: /{{maxResponseTokens}}/gi, replace: () => String(getMaxResponseTokens()) },
        { regex: /{{lastMessage}}/gi, replace: () => getLastMessage() },
        { regex: /{{lastMessageId}}/gi, replace: () => String(getLastMessageId() ?? '') },
        { regex: /{{lastUserMessage}}/gi, replace: () => getLastUserMessage() },
        { regex: /{{lastCharMessage}}/gi, replace: () => getLastCharMessage() },
        { regex: /{{firstIncludedMessageId}}/gi, replace: () => String(getFirstIncludedMessageId() ?? '') },
        { regex: /{{firstDisplayedMessageId}}/gi, replace: () => String(getFirstDisplayedMessageId() ?? '') },
        { regex: /{{lastSwipeId}}/gi, replace: () => String(getLastSwipeId() ?? '') },
        { regex: /{{currentSwipeId}}/gi, replace: () => String(getCurrentSwipeId() ?? '') },
        { regex: /{{allChatRange}}/gi, replace: () => chat.length === 0 ? '' : `0-${chat.length - 1}` },
        { regex: /{{reverse:(.+?)}}/gi, replace: (_, str) => Array.from(str).reverse().join('') },
        { regex: /\{\{\/\/([\s\S]*?)\}\}/gm, replace: () => '' },
        { regex: /{{time}}/gi,    replace: () => moment().format('LT') },
        { regex: /{{date}}/gi,    replace: () => moment().format('LL') },
        { regex: /{{weekday}}/gi, replace: () => moment().format('dddd') },
        { regex: /{{isotime}}/gi, replace: () => moment().format('HH:mm') },
        { regex: /{{isodate}}/gi, replace: () => moment().format('YYYY-MM-DD') },
        { regex: /{{datetimeformat +([^}]*)}}/gi, replace: (_, format) => moment().format(format) },
        { regex: /{{idle_duration}}/gi, replace: () => getTimeSinceLastMessage() },
        { regex: /{{time_UTC([-+]\d+)}}/gi, replace: (_, offset) => moment().utc().utcOffset(parseInt(offset, 10)).format('LT') },
        { regex: /{{outlet::(.+?)}}/gi, replace: (_, key) => getOutletPrompt(key.trim()) || '' },
        getTimeDiffMacro(),
        getBannedWordsMacro(),
        getRandomReplaceMacro(),
        getPickReplaceMacro(rawContent),
    ];

    MacrosParser.populateEnv(env);          // merge globally-registered extension macros into env
    const nonce = uuidv4();
    const envMacros = [];

    for (const varName in env) {
        if (!Object.hasOwn(env, varName)) continue;
        const envRegex = new RegExp(`{{${escapeRegex(varName)}}}`, 'gi');
        const envReplace = () => {
            const param = env[varName];
            const value = MacrosParser.sanitizeMacroValue(typeof param === 'function' ? param(nonce) : param);
            return value;
        };
        envMacros.push({ regex: envRegex, replace: envReplace });
    }

    const macros = [...preEnvMacros, ...envMacros, ...postEnvMacros];

    for (const macro of macros) {
        if (!content) break;                                        // stop if content became empty
        if (!macro.regex.source.startsWith('<') && !content.includes('{{')) break;  // short-circuit
        try {
            content = content.replace(macro.regex, (...args) => postProcessFn(macro.replace(...args)));
        } catch (e) {
            console.warn(`Macro content can't be replaced: ${macro.regex} in ${content}`, e);
        }
    }
    return content;
}
```

**Legacy evaluation ORDER** (this is the whole semantics — there is no parser and no recursion):
1. Legacy angle-bracket markers `<USER> <BOT> <CHAR> <CHARIFNOTGROUP> <GROUP>`.
2. `{{roll…}}`.
3. All `{{instruct*}}` / `{{systemPrompt}}` / `{{defaultSystemPrompt}}` / `{{chatSeparator}}` / `{{chatStart}}` macros.
4. All variable macros (`setvar`, `addvar`, `incvar`, `decvar`, `getvar`, + `*globalvar`).
5. `{{newline}}`, `{{trim}}`, `{{noop}}`, `{{input}}`.
6. **Env macros**, in JS object-key insertion order of `environment` built in `substituteParamsLegacy` (script.js:2805-2899): `original`, then (if `replaceCharacterCard`) `charPrompt`, `charInstruction`/`charJailbreak`, `description`, `personality`, `scenario`, `persona`, `mesExamples`, `mesExamplesRaw`, `charVersion`, `char_version`, `charDepthPrompt`, `creatorNotes`; then `user`, `char`, `group`/`charIfNotGroup`, `groupNotMuted`, `notChar`, `model`; then anything from `additionalMacro`; then everything registered via `MacrosParser.registerMacro` (appended by `populateEnv`).
7. Post-env built-ins: token limits, chat-inspection macros, `{{reverse:…}}`, `{{// comment}}`, time/date, `{{outlet::…}}`, `{{timeDiff::a::b}}`, `{{banned "w"}}`, `{{random…}}`, `{{pick…}}`.

Consequences of this design worth knowing:
* **One pass per macro, in list order.** Nesting is not supported, but *one level of indirection* works by ordering: the code comment at script.js:2889 says *"Must be substituted last so that they're replaced inside `{{description}}`"* — because `{{user}}`/`{{char}}` run after `{{description}}`, a description containing `{{char}}` is expanded correctly. The reverse (a `{{description}}` inside a value produced by `{{user}}`) does not work.
* **Escaping**: there is none. `{{`-less content short-circuits the loop early (perf), and unknown `{{foo}}` is simply left untouched in the output.
* `original` is a **one-shot** function: `environment.original = () => { if (originalSubstituted) return ''; originalSubstituted = true; return _original; }`.
* `postProcessFn` wraps every replacement value (used e.g. to JSON-escape substituted values).
* `MacrosParser.sanitizeMacroValue`: string → as-is; null/undefined → `''`; Promise → warn + `''`; function → warn + `''`; Date → `toISOString()`; object → `JSON.stringify`; else `String(value)`.

**Legacy random/pick/roll implementations:**

```js
// {{random:a,b,c}} or {{random::a::b}}
const randomPattern = /{{random\s?::?([^}]+)}}/gi;
const list = listString.includes('::') ? listString.split('::')
    : listString.replace(/\\,/g, '##<COMMA>##').split(',').map(i => i.trim().replace(/##<COMMA>##/g, ','));
const rng = seedrandom('added entropy.', { entropy: true });
return list[Math.floor(rng() * list.length)];

// {{pick:...}} — deterministic per (chat, content, position)
const pickPattern = /{{pick\s?::?([^}]+)}}/gi;
const combinedSeedString = `${chatIdHash}-${rawContentHash}-${offset}`;  // offset = match position
const finalSeed = getStringHash(combinedSeedString);
const rng = seedrandom(finalSeed);
return list[Math.floor(rng() * list.length)];

// {{roll 1d20}} / {{roll:20}}
const rollPattern = /{{roll[ : ]([^}]+)}}/gi;
if (isDigitsOnly(formula)) formula = `1d${formula}`;
if (!droll.validate(formula)) return '';
return String(droll.roll(formula).total);
```
(`##<COMMA>##` above is a literal placeholder string in the source containing a replacement char; `\,` escapes a comma inside a comma-separated list.) `getChatIdHash()` memoizes `getStringHash(chat_metadata.main_chat ?? getCurrentChatId())` into `chat_metadata.chat_id_hash`, so picks survive branch/rename.

`{{banned "word"}}` (`/{{banned "(.*)"}}/gi`) pushes into `textgenerationwebui_banned_in_macros` when `main_api == 'textgenerationwebui'` and returns `''`.

---

### 4.C NEW ENGINE — `MacroEngine.evaluate` (macros/engine/MacroEngine.js:117)

```js
evaluate(input, env, { contextOffset = 0 } = {}) {
    if (!input) return '';
    const safeEnv = Object.freeze({ ...env });
    const preProcessed = this.#runPreProcessors(input, safeEnv);
    const { cst, lexingErrors, parserErrors } = MacroParser.parseDocument(preProcessed);
    if (lexingErrors?.length) logMacroSyntaxWarning({ phase: 'lexing', input, errors: lexingErrors });
    if (parserErrors?.length) logMacroSyntaxWarning({ phase: 'parsing', input, errors: parserErrors });
    if (!cst || typeof cst !== 'object' || !cst.children) { …; return input; }   // fail-open
    let evaluated;
    try {
        evaluated = MacroCstWalker.evaluateDocument({
            text: preProcessed, contextOffset, cst, env: safeEnv,
            resolveMacro: this.#resolveMacro.bind(this),
            trimContent: this.trimScopedContent.bind(this),
        });
    } catch (error) { logMacroGeneralError(…); return input; }               // fail-open
    return this.#runPostProcessors(evaluated, safeEnv);
}
```

**Pre-processors** (`#registerCorePreProcessors`, priority order):
```js
// p10 — legacy time syntax:  {{time_UTC-10}} => {{time::UTC-10}}
text.replace(/{{time_(UTC[+-]\d+)}}/gi, (_m, off) => `{{time::${off}}}`)
// p20 — legacy non-curly markers
text.replace(/<USER>/gi,'{{user}}').replace(/<BOT>/gi,'{{char}}').replace(/<CHAR>/gi,'{{char}}')
    .replace(/<GROUP>/gi,'{{group}}').replace(/<CHARIFNOTGROUP>/gi,'{{charIfNotGroup}}')
```

**Post-processors**:
```js
// p10 — unescape braces:  \{ -> {   \} -> }   (\{\{ never lexes as MacroStart, so it survives as plain text)
text.replace(/\\([{}])/g, '$1')
// p20 — legacy {{trim}} semantics: eat the macro AND the newlines around it
text.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, '')
// p30 — strip any stray ELSE_MARKER
text.replaceAll(ELSE_MARKER, '')
```
`ELSE_MARKER = ' ELSE '` (core-macros.js:20).

**Resolution order in the new engine is structural, not list-based**: `MacroCstWalker` walks the document, and for each macro node it first evaluates the argument nodes and the scoped content (recursively re-entering the engine through `#evaluateArgumentNode` / `#evaluateScopedContent`), then calls the handler — i.e. **inside-out / depth-first**, so `{{if {{getvar::x}}}}` works natively. `delayArgResolution: true` (used by `{{if}}`) opts out: the handler receives *raw* text and calls `resolve(text, {offsetDelta})` itself, which re-enters `MacroEngine.evaluate` with `contextOffset = call.globalOffset + offsetDelta`.

`#resolveMacro(call)` precedence: **dynamicMacros (per-call, keys lowercased) → registered macros → unknown**. Unknown macros return `` `{{${call.rawInner}}}` `` — i.e. the braces are preserved but any nested macros inside have already been resolved. Dynamic macro values may be a string, a handler function, or a full `MacroDefinitionOptions` object with `handler`. Handler results are passed through `env.functions.postProcess`. Runtime errors log a warning and return the raw macro text (fail-open).

**Syntax** (MacroLexer.js):
* Delimiters `{{` `}}`; a single `{` immediately before `{{` is lexed as plaintext (`Plaintext.OpenBrace`).
* Argument separators: `::` (preferred) or a single `:`; whitespace after the identifier also ends it. `=` and `"` are recognized inside args (named args reserved for the future).
* **Flags** between `{{` and the identifier, whitespace allowed: `!` immediate (**not implemented**), `?` delayed (**not implemented**), `~` re-evaluate (**not implemented**), `>` filter/pipe (parsed only), `/` closing block (implemented), `#` preserve whitespace (implemented; also gives backwards compat with handlebars `{{#if …}}`).
* **Scoped macros**: `{{name::args}}content{{/name}}`. The content becomes the **last unnamed argument**; it is auto-trimmed and dedented by `trimScopedContent` unless `#` is set.
* **Variable shorthands**: `.name` (local) and `$name` (global) with operators `++ -- ??= ?? ||= || += -= == != >= > <= < =`.
* Identifiers: `/^[a-zA-Z][\w-_]*$/`.
* Escaping: `\{` / `\}` pass through the lexer as plain text and are unescaped in post-processing.

`trimScopedContent(content, {trimIndent=true})` trims, then measures the indentation of the first non-empty line and removes exactly that many leading spaces/tabs from every line — so a nicely indented `{{if}}` block produces unindented output.

---

### 4.D FULL MACRO INVENTORY (new engine registry; legacy equivalents noted)

**Names (`MacroCategory.NAMES`)** — env-macros.js
| Macro | Resolves to |
|---|---|
| `{{user}}` | `env.names.user` = `name1Override ?? name1` (persona name). Legacy `<USER>`. |
| `{{char}}` | `env.names.char` = `name2Override ?? name2`. Legacy `<BOT>`/`<CHAR>`. See §5. |
| `{{group}}` / `{{charIfNotGroup}}` (hidden alias) | Comma-joined member names **including muted**; in solo chat = the char name. Legacy `<GROUP>`/`<CHARIFNOTGROUP>`. |
| `{{groupNotMuted}}` | Same, excluding `group.disabled_members`. |
| `{{notChar}}` | All participants except the current speaker (group members minus `{{char}}`, plus the user); in solo chat = the user name. |

**Character card (`CHARACTER`)** — env-macros.js
`{{charPrompt}}`, `{{charInstruction}}` (legacy also `{{charJailbreak}}`), `{{charDescription}}`/`{{description}}`, `{{charPersonality}}`/`{{personality}}`, `{{charScenario}}`/`{{scenario}}`, `{{persona}}`, `{{mesExamplesRaw}}`, `{{mesExamples}}`, `{{charDepthPrompt}}`, `{{charCreatorNotes}}`/`{{creatorNotes}}`, `{{charFirstMessage}}`/`{{greeting}}` (optional 0-based index arg), `{{charVersion}}` (+hidden aliases `{{version}}`, `{{char_version}}`), `{{original}}` (one-shot).

`{{mesExamples}}` handler:
```js
const raw = env.character.mesExamplesRaw ?? '';
if (!raw) return '';
const isInstruct = !!power_user?.instruct?.enabled && main_api !== 'openai';
const parsed = parseMesExamples(raw, isInstruct);
if (!isInstruct) return parsed.join('');
return formatInstructModeExamples(parsed, env.names.user, env.names.char).join('');
```

**Utility (`UTILITY`)** — core-macros.js
`{{space[::count]}}`, `{{newline[::count]}}`, `{{noop}}`, `{{trim}}` (non-scoped → emits the literal `{{trim}}` marker consumed by the post-processor that eats surrounding newlines; scoped `{{trim}}…{{/trim}}` returns auto-trimmed content), `{{if cond}}…{{else}}…{{/if}}` (`!` prefix inverts; bare macro names and `.var`/`$var` shorthands are auto-resolved; falsy = `''` or `isFalseBoolean` → `"false"`/`"off"`/`"0"`; `#` preserves whitespace), `{{else}}`, `{{input}}`, `{{reverse::str}}`, `{{// comment}}` (hidden alias `{{comment}}`, `list: true`, `strictArgs: false`), `{{banned::word}}`, `{{outlet::key}}`.

**Random (`RANDOM`)** — core-macros.js
* `{{random::a::b::c}}` / `{{random:a,b,c}}` — `seedrandom('added entropy.', {entropy:true})`, re-rolled on every evaluation. Legacy single-arg lists are re-split by `readSingleArgsRandomList` (`::` wins over `,`; `\,` escapes a comma).
* `{{pick::a::b}}` — stable per chat + content + position: `seed = getStringHash([chatIdHash, env.contentHash, globalOffset, chat_metadata.pick_reroll_seed].filter(x => x !== null).join('-'))`. Resettable per chat with the `/reroll-pick` slash command.
* `{{roll::1d20}}` / `{{roll::6}}` (bare digits → `1dN`) via `droll`.

**State (`STATE`)** — core/env/state macros
`{{maxPrompt}}`/`{{maxPromptTokens}}`, `{{maxContext}}`/`{{maxContextTokens}}`, `{{maxResponse}}`/`{{maxResponseTokens}}`, `{{model}}`, `{{isMobile}}`, `{{lastGenerationType}}`, `{{hasExtension::name}}`.

**Chat (`CHAT`)** — chat-macros.js
`{{lastMessage}}`, `{{lastMessageId}}`, `{{lastUserMessage}}`, `{{lastCharMessage}}`, `{{firstIncludedMessageId}}`, `{{firstDisplayedMessageId}}`, `{{lastSwipeId}}`, `{{currentSwipeId}}`, `{{allChatRange}}`.

**Time (`TIME`)** — time-macros.js
`{{time}}` / `{{time::UTC±n}}` (legacy `{{time_UTC-10}}` rewritten by a pre-processor), `{{date}}`, `{{weekday}}`, `{{isotime}}`, `{{isodate}}`, `{{datetimeformat::<moment fmt>}}`, `{{idleDuration}}`/`{{idle_duration}}`, `{{timeDiff::left::right}}`.

**Variables (`VARIABLE`)** — variable-macros.js (new) / variables.js:238 (legacy)
`{{setvar::name::value}}`, `{{addvar::name::value}}`, `{{incvar::name}}`, `{{decvar::name}}`, `{{getvar::name}}`, `{{hasvar::name}}`/`{{varexists}}`, `{{deletevar::name}}`/`{{flushvar}}`, and the `…globalvar` equivalents (`setglobalvar`, `addglobalvar`, `incglobalvar`, `decglobalvar`, `getglobalvar`, `hasglobalvar`/`globalvarexists`, `deleteglobalvar`/`flushglobalvar`). Legacy regexes (note the `[^:]+` name group means names cannot contain `:`):
```js
{ regex: /{{setvar::([^:]+)::([^}]*)}}/gi, replace: (_, n, v) => { setLocalVariable(n.trim(), v); return ''; } },
{ regex: /{{getvar::([^}]+)}}/gi,          replace: (_, n) => getLocalVariable(n.trim()) },
```

**Instruct / prompt templates** — instruct-mode.js `getInstructMacros(env)` builds regexes from `{{(key)}}` where `key` may be a `|`-alternation:
`instructStoryStringPrefix`, `instructStoryStringSuffix`, `instructInput|instructUserPrefix`, `instructUserSuffix`, `instructOutput|instructAssistantPrefix`, `instructSeparator|instructAssistantSuffix`, `instructSystemPrefix`, `instructSystemSuffix`, `instructFirstOutput|instructFirstAssistantPrefix`, `instructLastOutput|instructLastAssistantPrefix`, `instructStop`, `instructUserFiller`, `instructSystemInstructionPrefix`, `instructFirstInput|instructFirstUserPrefix`, `instructLastInput|instructLastUserPrefix`, `systemPrompt` (character override when `prefer_character_prompt`), `defaultSystemPrompt|instructSystem|instructSystemPrompt`, `chatSeparator` (= `context.example_separator`), `chatStart` (= `context.chat_start`). All resolve to `''` when the corresponding feature is disabled.

`MacroCategory` enum values: `utility, random, names, character, chat, time, variable, prompts, state, misc, uncategorized`. `MacroValueType`: `string, integer, number, boolean`.

---

## 5. `{{char}}` IN GROUP vs SOLO CHAT

`{{char}}` is always `name2Override ?? name2` — the **global "current speaker" name**, never "the group".

**Solo chat.** `getChatResult()` sets `name2 = characters[this_chid].name` (script.js:7626) when a character's chat is opened. So `{{char}}` = that character for the whole session. With no character selected, `name2` falls back to `neutralCharacterName` (`'Assistant'`) or `systemUserName` (`'SillyTavern System'`) — script.js:404-408, 7034.

**Group chat.** `generateGroupWrapper` in group-chats.js:
```js
setCharacterName('');            // line 983 — before the turn starts
setCharacterId(undefined);
…
for (const chId of activatedMembers) {
    setCharacterId(chId);
    setCharacterName(characters[chId].name);   // line 1055 — {{char}} == the member about to speak
    … await Generate(…) …
}
setCharacterName('');            // line 1085 — after the turn
```
So:
* **During generation for member X, `{{char}}` == X's name**, and `this_chid` == X, so `{{description}}`, `{{personality}}`, `{{charDepthPrompt}}`, `{{charPrompt}}` etc. also resolve to X's card — *unless* the group's `generation_mode` is APPEND (1) or APPEND_DISABLED (2), in which case `getGroupCharacterCardsLazy` overrides `description/personality/scenario/mesExamples` with **all members' fields joined** (each wrapped with `generation_mode_join_prefix` / `generation_mode_join_suffix`, where `<FIELDNAME>` is replaced by `Description`/`Personality`/`Scenario`/`Example Messages` and `baseChatReplace(value, null, character.name)` is applied so nested `{{char}}` inside a member's own field resolves to *that member*). `generation_mode === SWAP (0)` returns `null` → per-speaker cards.
* **Outside generation** (e.g. a slash command typed by the user, or UI-time substitution) `{{char}}` in a group is `''`.
* To name the whole cast, use `{{group}}` (all members, muted included), `{{groupNotMuted}}`, or `{{notChar}}` (everyone but the speaker, plus the user). `{{charIfNotGroup}}` is a **hidden alias of `{{group}}`** — despite the name, in a group it returns the member list, and in a solo chat it returns the character name.
* The group name-resolution helper (`MacroEnvBuilder.getGroupValue`) maps `group.members` (avatar filenames) → `characters.find(c => c.avatar === m).name`, filters by `disabled_members` when `includeMuted` is false, filters out `currentChar` when `filterOutChar`, and appends the user name for `notChar`. `groupOverride` (the `_group` legacy arg) short-circuits all of it. Legacy `getNotCharValue()` (script.js:2838) is the equivalent in the old engine.
* Group depth prompts: `getGroupDepthPrompts(groupId, characterId)` returns `[]` for SWAP mode; otherwise it collects every non-disabled member's `depth_prompt` (with `baseChatReplace(text, null, character.name)`) and `Generate()` injects each with its own `inject_ids.DEPTH_PROMPT_INDEX(i)`.
* Example-message parsing is group-aware too: `parseExampleIntoIndividual` recognizes any group member's `Name:` prefix as a bot turn and re-prefixes the content with `"${name}: "` so the model can tell who is speaking.

## Reusable
## COPY (nearly verbatim)

**1. The card data model.** Port `v1CharData` / `v2CharData` / `v2CharDataExtensionInfos` straight into TS interfaces — they are already JSDoc typedefs in `char-data.js` and translate 1:1. Keep the V2 `data` nesting and the `spec`/`spec_version` wrapper if you ever want to import/export real ST or Chub cards. In IndexedDB, store the whole card object as one record keyed by a UUID (do NOT reuse ST's `avatar`-filename-as-primary-key hack — that is a filesystem artifact); keep `avatar` as a blob/objectURL reference field instead.

**2. `baseChatReplace` + lazy card fields.** This pattern is excellent and cheap to port: one function that runs macro substitution with `replaceCharacterCard: false` (recursion guard) + optional newline collapsing + `\r` stripping, wrapped in lazily-memoized getters so unused fields are never processed. In Vue this maps naturally to a Pinia store with `computed()` per field — you get the memoization for free.

**3. `parseMesExamples`.** ~12 lines, no dependencies beyond a settings value. Copy it as-is including the `<START>` normalization (`if (!startsWith('<START>')) prepend '<START>\n'`), the case-insensitive split, `.slice(1)`, and the per-block trim + trailing newline. Also copy `parseExampleIntoIndividual` if you target a chat-completion API — it is the piece that turns example blocks into `example_user`/`example_assistant` messages.

**4. Alternate greetings as swipes.** `getFirstMessage()` is the whole feature: `swipes = [first_mes, ...alternate_greetings]`, `swipe_id = 0`, parallel `swipe_info[]`. Copy the "if `first_mes` is empty, shift and promote alt #1" edge case — cards in the wild do rely on it. For a group/multi-char mode, copy the *other* strategy (uniform random pick per member, no swipes).

**5. Depth-prompt injection semantics.** `{prompt, depth, role}` with defaults `depth=4`, `role='system'` is a small, high-value feature: inject the text as a message `depth` positions from the end of the history. Worth porting even if you skip World Info.

**6. The macro name set.** Support at minimum: `{{user}} {{char}} {{persona}} {{description}} {{personality}} {{scenario}} {{mesExamples}} {{mesExamplesRaw}} {{charVersion}} {{charDepthPrompt}} {{creatorNotes}} {{original}} {{newline}} {{noop}} {{trim}} {{// comment}} {{random}} {{pick}} {{roll}} {{time}} {{date}} {{isotime}} {{isodate}} {{weekday}} {{datetimeformat}} {{idleDuration}} {{lastMessage}} {{lastUserMessage}} {{lastCharMessage}} {{getvar}} {{setvar}} {{addvar}} {{incvar}} {{decvar}}` + global variants. Copy the `{{pick}}` seeding formula verbatim (`hash(chatIdHash-contentHash-offset[-rerollSeed])` fed to seedrandom) — deterministic-but-stable picks are the kind of thing users notice immediately when it regresses.

## ADAPT (don't copy literally)

**7. Substitution implementation — pick one engine, and pick the new one's *shape*, not its size.** Do not port the legacy ordered-regex-array approach: its "nesting works only if you order the list right" property is a trap, and the two-engine feature-flag split in this codebase exists purely for migration. But also do not port the full chevrotain lexer/parser (~150 KB across MacroLexer/MacroParser/MacroCstWalker/MacroRegistry) unless you need `{{if}}`, scoped macros, and variable shorthands on day one.

A right-sized TS design that preserves the important semantics:
* A `MacroRegistry: Map<string, {handler(ctx), minArgs, maxArgs, list?, delayArgs?}>` with case-insensitive lookup and aliases.
* A single recursive tokenizer that scans for `{{`, finds the matching `}}` while tracking nesting depth, resolves the **innermost** macro first (depth-first), then re-scans. That gives you `{{if {{getvar::x}}}}` and `{{random::{{char}}::{{user}}}}` for ~80 lines instead of a parser generator.
* Argument split on `::` (fall back to a single `:` / first whitespace for legacy card compatibility).
* Copy the fail-open policy: unknown macro → leave the braces intact; handler throws → log and leave raw text. Never let a bad card break generation.
* Copy the `\{` / `\}` unescape post-processor and the `{{trim}}` "eat surrounding newlines" post-processor — both are one-line regexes with real user-visible behavior.

**8. `{{char}}` in groups.** Do not copy the global-mutable-`name2` + `setCharacterName('')` pattern — it is the source of the "`{{char}}` is empty outside generation" wart. In Pinia, make the macro env an explicit parameter: `resolveMacros(text, { user, char, chat, cardFields })` where `char` is passed in per generation turn. Keep the *semantic* (in a multi-char chat `{{char}}` = the member currently speaking; `{{group}}` = all members; `{{notChar}}` = everyone else + user) but make it an argument, not ambient state.

**9. Group card joining (APPEND modes).** The `<FIELDNAME>` prefix/suffix templating in `getGroupCharacterCardsLazy` is a reasonable idea but over-engineered. If you support multi-char, a simpler `members.map(m => `### ${m.name}\n${m.description}`).join('\n\n')` covers 95% of it.

**10. Example injection budget.** The pinned-vs-token-budgeted loop (`pin_examples` → all, else add-while-under-limit counting `count_exm_add`) is worth keeping as a concept, but implement it as a clean `fitWithinBudget(blocks, tokenizer, limit)` helper rather than the interleaved mutation of `examplesString` / `count_exm_add` / `pinExmString` that `Generate()` does.

## DO NOT PORT

* `MacrosParser` (the entire deprecated class, its bridging to the new engine, and `#logDeprecated`) — it exists only for extension back-compat.
* The dual-engine `power_user.experimental_macro_engine` branching and `substituteParamsLegacy` / `substituteParamsExtended` / `onboardingExperimentalMacroEngine` shims.
* Legacy angle-bracket markers `<USER> <BOT> <CHAR> <GROUP> <CHARIFNOTGROUP>` — unless you want to import very old cards, in which case a single pre-processor `replace()` chain (5 lines, copied verbatim from `#registerCorePreProcessors`) is enough.
* The Handlebars `helperMissing` / `trim` helper bridge — only needed because ST's context templates are Handlebars.
* The unimplemented macro flags `!` `?` `~` `>` (immediate/delayed/reevaluate/filter). `MacroFlags.js` marks all four `implemented: false`. Ship only `/` (closing block) and `#` (preserve whitespace), and only if you implement scoped macros at all.
* The whole `MacroBrowser.js` / `MacroDiagnostics.js` / autocomplete-support surface (~60 KB) — that is IDE tooling for prompt authors, not runtime.
* jQuery-coupled macros as written: `{{input}}` reads `#send_textarea` directly. Re-implement against your store.
* `{{banned}}` (textgenerationwebui-specific), `{{outlet::key}}` (World Info outlets), and the `{{instruct*}}` family — all tied to ST subsystems you probably are not porting.
* Server-side `charaFormatData` / `readFromV2` V1↔V2 mirroring — only needed if you read/write PNG-embedded ST card files. If you do, note the two gotchas: `fav` is compared as the string `'true'`, and `json_data` is round-tripped to preserve unknown foreign keys.
* `group_only_greetings` and anything else V3 — not present in this codebase, so there is no reference implementation here to copy.