# SillyTavern World Info — positioning / insertion system (world_info_position enum, atDepth injection, timed effects, inclusion groups, token budget, prompt hand-off)

## Key files
- D:\tauriApp\SillyTavern\public\scripts\world-info.js — Owns the whole WI subsystem: world_info_position / wi_anchor_position / world_info_logic / scan_state enums, WorldInfoBuffer (scan text + scoring), WorldInfoTimedEffects (sticky/cooldown/delay), checkWorldInfo() scan loop, inclusion-group filtering, token budget enforcement, and the final bucket-and-join step that produces worldInfoBefore/After/EM/AN/Depth/Outlet.
- D:\tauriApp\SillyTavern\public\script.js — Consumer side. Line 4576 calls getWorldInfoPrompt(); 4580-4596 splices EM entries into mesExamplesArray; 4605-4619 flushWIInjections() + setExtensionPrompt() for depth/outlet entries; 4644-4663 feeds wiBefore/wiAfter into the story-string Handlebars template; 5569-5617 doChatInject() materializes IN_CHAT prompts as fake chat messages; 8866 setExtensionPrompt(); 483-499 extension_prompt_types / extension_prompt_roles enums; 499 MAX_INJECTION_DEPTH=10000.
- D:\tauriApp\SillyTavern\public\scripts\constants.js — inject_ids (lines 48-56): CUSTOM_WI_DEPTH='customDepthWI', CUSTOM_WI_DEPTH_ROLE=(depth,role)=>`customDepthWI_${depth}_${role}`, CUSTOM_WI_OUTLET=(key)=>`customWIOutlet_${key}`, STORY_STRING, QUIET_PROMPT, DEPTH_PROMPT.
- D:\tauriApp\SillyTavern\public\scripts\openai.js — Chat-completion consumer: formatWorldInfo() (785) wraps WI in oai_settings.wi_format; preparePromptsForChatCompletion() (1363-1373) makes worldInfoBefore/worldInfoAfter system prompt markers; populationInjectionPrompts() (806-871) is the OAI analogue of doChatInject for IN_CHAT depth prompts.
- D:\tauriApp\SillyTavern\public\scripts\authors-note.js — Author's Note module '2_floating_prompt'; exports shouldWIAddPrompt and metadata_keys {prompt, interval, depth, position, role} that WI reuses when re-emitting the AN with ANTop/ANBottom entries wrapped around it.
- D:\tauriApp\SillyTavern\public\index.html — Lines 7175-7206: the position <select> whose <option value>/data-role pairs encode the enum, including three separate value="4" options carrying data-role 0/1/2 for at-Depth System/User/Assistant.
- D:\tauriApp\SillyTavern\default\content\presets\context\Default.json — Default story_string Handlebars template showing exactly where {{wiBefore}} and {{wiAfter}} land relative to system / description / personality / scenario / persona.

## Report
# SillyTavern World Info — Positioning & Insertion, exhaustive spec

All line numbers are from the checked-out copy at `D:\tauriApp\SillyTavern\public\`.

---

## 0. Pipeline overview

```
script.js:4576
  const { worldInfoString, worldInfoBefore, worldInfoAfter,
          worldInfoExamples, worldInfoDepth, outletEntries }
      = await getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData);
```

`chatForWI` (script.js:4565) is `coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse()` — i.e. **newest message first**, system messages already filtered out at 4437 (`chat.filter(x => !x.is_system || ...)`).

`getWorldInfoPrompt` (world-info.js:892-915) is a thin wrapper over `checkWorldInfo`:

```js
const activatedWorldInfo = await checkWorldInfo(chat, maxContext, isDryRun, globalScanData);
worldInfoBefore = activatedWorldInfo.worldInfoBefore;
worldInfoAfter  = activatedWorldInfo.worldInfoAfter;
worldInfoString = worldInfoBefore + worldInfoAfter;   // note: no separator
...
return {
    worldInfoString, worldInfoBefore, worldInfoAfter,
    worldInfoExamples: activatedWorldInfo.EMEntries ?? [],
    worldInfoDepth:    activatedWorldInfo.WIDepthEntries ?? [],
    anBefore:          activatedWorldInfo.ANBeforeEntries ?? [],
    anAfter:           activatedWorldInfo.ANAfterEntries ?? [],
    outletEntries:     activatedWorldInfo.outletEntries ?? {},
};
```

Note `anBefore`/`anAfter` are returned but **not destructured** by script.js:4576 — the AN merge is done as a side effect inside `checkWorldInfo` itself (see §1.4).

---

## 1. `world_info_position` — every member, numeric value, final landing spot

world-info.js:855-869:

```js
export const world_info_position = {
    before:   0,
    after:    1,
    ANTop:    2,
    ANBottom: 3,
    atDepth:  4,
    EMTop:    5,
    EMBottom: 6,
    outlet:   7,
};

export const wi_anchor_position = {
    before: 0,
    after:  1,
};
```

Entry default is `position: { default: 0, type: 'number' }` (world-info.js:4013), i.e. **`before` (0)**.

The UI `<select name="position">` (index.html:7175-7206) lists them in a *display* order different from numeric order, and encodes at-Depth role as a `data-role` attribute on three options that all carry `value="4"`:

| option value | data-role | label | meaning |
|---|---|---|---|
| 0 | "" | ↑Char | Before Character Definitions |
| 1 | "" | ↓Char | After Character Definitions |
| 5 | "" | ↑EM | Before Example Messages |
| 6 | "" | ↓EM | After Example Messages |
| 2 | "" | ↑AN | Before Author's Note |
| 3 | "" | ↓AN | After Author's Note |
| 4 | 0 | @D ⚙️ | at Depth, role SYSTEM |
| 4 | 1 | @D 👤 | at Depth, role USER |
| 4 | 2 | @D 🤖 | at Depth, role ASSISTANT |
| 7 | "" | ➡️ Outlet | named outlet, rendered via `{{outlet::name}}` |

Short labels used in slash-command enums (world-info.js:1591-1602):

```js
function getWiPositionString(entry) {
    switch (entry.position) {
        case world_info_position.before:   return '↑Char';
        case world_info_position.after:    return '↓Char';
        case world_info_position.EMTop:    return '↑EM';
        case world_info_position.EMBottom: return '↓EM';
        case world_info_position.ANTop:    return '↑AT';
        case world_info_position.ANBottom: return '↓AT';
        case world_info_position.atDepth:  return `@D${enumIcons.getRoleIcon(entry.role)}`;
        default: return '<Unknown>';
    }
}
```
(no case for `outlet` — falls through to `<Unknown>`.)

### 1.1 The bucketing switch (world-info.js:5070-5144)

This is the single place where position is turned into placement. It runs **once, after the whole scan loop is done**, over the union of all activated entries:

```js
// Forward-sorted list of entries for joining
const WIBeforeEntries = [];
const WIAfterEntries  = [];
const EMEntries       = [];
const ANTopEntries    = [];
const ANBottomEntries = [];
const WIDepthEntries  = [];
/** @type {{[key: string]: string[]}} */
const WIOutletEntries = {};

// Appends from insertion order 999 to 1. Use unshift for this purpose
[...allActivatedEntries.values()].sort(sortFn).forEach((entry) => {
    const regexDepth = entry.position === world_info_position.atDepth ? (entry.depth ?? DEFAULT_DEPTH) : null;
    const content = getRegexedString(entry.content, regex_placement.WORLD_INFO,
                                     { depth: regexDepth, isMarkdown: false, isPrompt: true });

    if (!content) {
        console.debug(`[WI] Entry ${entry.uid}`, 'skipped adding to prompt due to empty content', entry);
        return;
    }

    switch (entry.position) {
        case world_info_position.before:   WIBeforeEntries.unshift(content); break;
        case world_info_position.after:    WIAfterEntries.unshift(content);  break;
        case world_info_position.EMTop:
            EMEntries.unshift({ position: wi_anchor_position.before, content: content });
            break;
        case world_info_position.EMBottom:
            EMEntries.unshift({ position: wi_anchor_position.after, content: content });
            break;
        case world_info_position.ANTop:    ANTopEntries.unshift(content);    break;
        case world_info_position.ANBottom: ANBottomEntries.unshift(content); break;
        case world_info_position.atDepth: { /* see §2 */ }
        case world_info_position.outlet:  { /* see §1.5 */ }
        default: break;
    }
});
```

**Ordering semantics.** `sortFn` is world-info.js:88:

```js
const sortFn = (a, b) => b.order - a.order;   // descending by `order`
```

`order` defaults to `100` (world-info.js:4012), UI range 0-9999. Because the loop iterates **descending order** but uses `unshift`, each bucket ends up **ascending by order**: lowest `order` first in the string, highest `order` last (nearest the character definitions). This matches the comment "Appends from insertion order 999 to 1."

**Exception — outlet uses `push`, not `unshift`** (line 5135), so outlet buckets end up in *descending* order (highest `order` first). This is an inconsistency in the codebase, not a documented feature.

Empty-content entries are dropped here **after** they have already consumed token budget during the scan (§5).

### 1.2 `before` (0) and `after` (1)

```js
const worldInfoBefore = WIBeforeEntries.length ? WIBeforeEntries.join('\n') : '';
const worldInfoAfter  = WIAfterEntries.length  ? WIAfterEntries.join('\n')  : '';
```
(world-info.js:5146-5147)

Joined with `'\n'`. These two strings are handed to the story-string template as `wiBefore` / `wiAfter` (and aliases `loreBefore` / `loreAfter`) — script.js:4644-4660:

```js
const storyStringParams = {
    description, personality,
    persona: power_user.persona_description_position == persona_description_positions.IN_PROMPT ? persona : '',
    scenario, system, char: name2, user: name1,
    wiBefore:   worldInfoBefore,
    wiAfter:    worldInfoAfter,
    loreBefore: worldInfoBefore,
    loreAfter:  worldInfoAfter,
    anchorBefore: beforeScenarioAnchor.trim(),
    anchorAfter:  afterScenarioAnchor.trim(),
    mesExamples: mesExamplesArray.join(''),
    mesExamplesRaw: mesExamplesRawArray.join(''),
};
const storyString = renderStoryString(storyStringParams);
```

The default context template (`default/content/presets/context/Default.json`) makes the actual landing spot explicit:

```
{{#if anchorBefore}}{{anchorBefore}}\n{{/if}}
{{#if system}}{{system}}\n{{/if}}
{{#if wiBefore}}{{wiBefore}}\n{{/if}}
{{#if description}}{{description}}\n{{/if}}
{{#if personality}}{{personality}}\n{{/if}}
{{#if scenario}}{{scenario}}\n{{/if}}
{{#if wiAfter}}{{wiAfter}}\n{{/if}}
{{#if persona}}{{persona}}\n{{/if}}
{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}
{{trim}}
```

So: **before = between the system prompt and the character description; after = between the scenario and the persona description.** "Char defs" = description + personality + scenario.

For chat-completion APIs the story string is not used; instead openai.js:1372-1373 creates two system prompt markers:

```js
{ role: 'system', content: formatWorldInfo(worldInfoBefore), identifier: 'worldInfoBefore' },
{ role: 'system', content: formatWorldInfo(worldInfoAfter),  identifier: 'worldInfoAfter'  },
```
and openai.js:1208-1214 fixes their relative slot:
```js
await addToChatCompletion('worldInfoBefore');
await addToChatCompletion('main');
await addToChatCompletion('worldInfoAfter');
await addToChatCompletion('charDescription');
await addToChatCompletion('charPersonality');
await addToChatCompletion('scenario');
await addToChatCompletion('personaDescription');
```
`formatWorldInfo` (openai.js:785-797) wraps the string with `oai_settings.wi_format` via `stringFormat`, returning `''` for falsy input and the raw value if the format is blank.

### 1.3 `EMTop` (5) / `EMBottom` (6) — example messages

Both go into the **same** `EMEntries` array, tagged with `wi_anchor_position.before` (0) or `.after` (1). Consumed at script.js:4580-4596:

```js
for (const example of worldInfoExamples) {
    const exampleMessage = example.content;
    if (exampleMessage.length === 0) continue;
    const formattedExample = baseChatReplace(exampleMessage);
    const cleanedExample = parseMesExamples(formattedExample, isInstruct);

    // Insert depending on before or after position
    if (example.position === wi_anchor_position.before) {
        mesExamplesArray.unshift(...cleanedExample);
    } else {
        mesExamplesArray.push(...cleanedExample);
    }
}
```

So EM entries are parsed as *example dialogue blocks* (`parseMesExamples`) and prepended/appended to the character's own example messages, **before** instruct formatting (4601-4603) and before `mesExamplesRawArray` is snapshotted (4599).

### 1.4 `ANTop` (2) / `ANBottom` (3) — Author's Note

Handled as a side effect inside `checkWorldInfo` (world-info.js:5149-5153):

```js
if (shouldWIAddPrompt) {
    const originalAN = context.extensionPrompts[NOTE_MODULE_NAME].value;
    const ANWithWI = `${ANTopEntries.join('\n')}\n${originalAN}\n${ANBottomEntries.join('\n')}`
                        .replace(/(^\n)|(\n$)/g, '');
    context.setExtensionPrompt(NOTE_MODULE_NAME, ANWithWI,
        chat_metadata[metadata_keys.position],
        chat_metadata[metadata_keys.depth],
        extension_settings.note.allowWIScan,
        chat_metadata[metadata_keys.role]);
}
```

- `NOTE_MODULE_NAME === '2_floating_prompt'` (authors-note.js:26 — "Deliberate, for sorting lower than memory", because `getExtensionPrompt` sorts by key name).
- `shouldWIAddPrompt` (authors-note.js:28, 362) is true only when the AN insertion interval fires this turn (`messagesTillInsertion == 0`). **If the AN is not scheduled to fire, ANTop/ANBottom entries are silently discarded.**
- The AN keeps its *own* position/depth/role from `chat_metadata` keys `note_position`, `note_depth`, `note_role` (authors-note.js:30-36) — WI only sandwiches text around it.
- The `.replace(/(^\n)|(\n$)/g, '')` strips exactly one leading and one trailing newline, so an empty `originalAN` with only ANTop entries yields `"top\n"` → `"top"`.

### 1.5 `outlet` (7) — named injection points

```js
case world_info_position.outlet: {
    if (!entry.outletName) {
        console.warn(`[WI] Entry ${entry.uid} has position 'outlet' but no outlet name. Skipping.`);
        break;
    }
    if (Array.isArray(WIOutletEntries[entry.outletName])) {
        WIOutletEntries[entry.outletName].push(content);
    } else {
        WIOutletEntries[entry.outletName] = [content];
    }
    break;
}
```
(world-info.js:5129-5140)

Consumed at script.js:4615-4619 with `extension_prompt_types.NONE` (-1) so it is never auto-injected anywhere:

```js
Object.entries(outletEntries).forEach(([key, value]) => {
    setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(key), value.join('\n'), extension_prompt_types.NONE, 0);
});
```

Retrieval is purely by macro — macros.js:597-600 and core-macros.js:463-467:

```js
const value = extension_prompts[inject_ids.CUSTOM_WI_OUTLET(outlet)]?.value;
return value || '';
```
Usage: `{{outlet::character-achievements}}`. Key format: `customWIOutlet_${key}` (constants.js:55).

---

## 2. `atDepth` (4) — depth injection

### 2.1 The role enum

script.js:483-499:

```js
export const extension_prompt_types = {
    NONE:          -1,
    IN_PROMPT:      0,
    IN_CHAT:        1,
    BEFORE_PROMPT:  2,
};

/** @enum {number} Extension prompt roles */
export const extension_prompt_roles = {
    SYSTEM:    0,
    USER:      1,
    ASSISTANT: 2,
};

export const MAX_INJECTION_DEPTH = 10000;
```

Name→number mapping (script.js:8882-8899):

```js
export function getExtensionPromptRoleByName(roleName) {
    if (typeof roleName === 'number' && Object.values(extension_prompt_roles).includes(roleName)) return roleName;
    switch (roleName) {
        case 'system':    return extension_prompt_roles.SYSTEM;
        case 'user':      return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
    }
    return extension_prompt_roles.SYSTEM;   // fallback
}
```

### 2.2 Depth field

- `DEFAULT_DEPTH = 4` (world-info.js:96); `MAX_SCAN_DEPTH = 1000` (98).
- Entry field: `depth: { default: DEFAULT_DEPTH, type: 'number' }` (4027); `role: { default: 0, type: 'enum' }` (4037).
- UI (world-info.js:3327-3331): depth input `min: 0, max: MAX_SCAN_DEPTH, clamp: false`. The HTML input itself has `min="0" max="9999"` (index.html:7210).
- UI (3338-3358): the depth input is only enabled when position === 4; otherwise **`data.entries[uid].role = null`** is written. So a non-atDepth entry has `role === null`, and `entry.role ?? extension_prompt_roles.SYSTEM` resolves it back to 0.

### 2.3 Grouping by (depth, role)

world-info.js:5116-5128:

```js
case world_info_position.atDepth: {
    const existingDepthIndex = WIDepthEntries.findIndex((e) =>
        e.depth === (entry.depth ?? DEFAULT_DEPTH) &&
        e.role  === (entry.role  ?? extension_prompt_roles.SYSTEM));
    if (existingDepthIndex !== -1) {
        WIDepthEntries[existingDepthIndex].entries.unshift(content);
    } else {
        WIDepthEntries.push({
            depth: entry.depth,                                  // <-- NOT `?? DEFAULT_DEPTH`
            entries: [content],
            role: entry.role ?? extension_prompt_roles.SYSTEM,
        });
    }
    break;
}
```

Latent bug worth noting when porting: the **lookup** normalizes `depth` with `?? DEFAULT_DEPTH` but the **push** stores the raw `entry.depth`. If an entry has `depth === undefined`, a bucket is created with `depth: undefined`, and a later entry with the same undefined depth will fail the `e.depth === 4` match and create a *second* bucket — and downstream `setExtensionPrompt(..., depth=undefined)` becomes `Number(undefined) === NaN`.

Within a bucket, entries are `unshift`ed while iterating descending-by-`order`, so **within one (depth, role) group the content is ascending by `order`** — same rule as §1.1.

### 2.4 Handing depth entries to the prompt builder

script.js:4605-4614:

```js
if (skipWIAN !== true) {
    console.log('skipWIAN not active, adding WIAN');
    // Add all depth WI entries to prompt
    flushWIInjections();
    if (Array.isArray(worldInfoDepth)) {
        worldInfoDepth.forEach((e) => {
            const joinedEntries = e.entries.join('\n');
            setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role),
                joinedEntries, extension_prompt_types.IN_CHAT, e.depth, false, e.role);
        });
    }
    ...
}
```

- Bucket contents joined with `'\n'`.
- Injection key: `customDepthWI_${depth}_${role}` (constants.js:54) — one extension prompt per (depth, role) pair.
- `scan = false` → depth-injected WI text is **not** re-scanned as WI source next turn.
- `flushWIInjections()` (script.js:5619-5627) clears stale ones each generation:

```js
function flushWIInjections() {
    const depthPrefix  = inject_ids.CUSTOM_WI_DEPTH;        // 'customDepthWI'
    const outletPrefix = inject_ids.CUSTOM_WI_OUTLET('');   // 'customWIOutlet_'
    for (const key of Object.keys(extension_prompts)) {
        if (key.startsWith(depthPrefix) || key.startsWith(outletPrefix)) {
            delete extension_prompts[key];
        }
    }
}
```
(also called on chat change, script.js:5644).

`setExtensionPrompt` itself (script.js:8866-8875):

```js
export function setExtensionPrompt(key, value, position, depth, scan = false, role = extension_prompt_roles.SYSTEM, filter = null) {
    extension_prompts[key] = {
        value: String(value),
        position: Number(position),
        depth: Number(depth),
        scan: !!scan,
        role: Number(role ?? extension_prompt_roles.SYSTEM),
        filter: filter,
    };
}
```

### 2.5 How IN_CHAT prompts become messages (text-completion path)

script.js:5569-5617:

```js
async function doChatInject(messages, isContinue) {
    const injectedMessages = [];
    let totalInsertedMessages = 0;
    messages.reverse();                            // now newest-first

    const maxDepth = getExtensionPromptMaxDepth(); // == MAX_INJECTION_DEPTH == 10000
    for (let i = 0; i <= maxDepth; i++) {
        // Order of priority (most important go lower)
        const roles = [extension_prompt_roles.SYSTEM, extension_prompt_roles.USER, extension_prompt_roles.ASSISTANT];
        const names = {
            [extension_prompt_roles.SYSTEM]: '',
            [extension_prompt_roles.USER]: name1,
            [extension_prompt_roles.ASSISTANT]: name2,
        };
        const roleMessages = [];
        const separator = '\n';
        const wrap = false;

        for (const role of roles) {
            const extensionPrompt = String(await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, role, wrap)).trimStart();
            const isNarrator = role === extension_prompt_roles.SYSTEM;
            const isUser     = role === extension_prompt_roles.USER;
            const name = names[role];
            if (extensionPrompt) {
                roleMessages.push({
                    name, is_user: isUser, mes: extensionPrompt,
                    extra: { type: isNarrator ? system_message_types.NARRATOR : null },
                });
            }
        }

        if (roleMessages.length) {
            const depth = isContinue && i === 0 ? 1 : i;
            const injectIdx = Math.min(depth + totalInsertedMessages, messages.length);
            messages.splice(injectIdx, 0, ...roleMessages);
            totalInsertedMessages += roleMessages.length;
            injectedMessages.push(...roleMessages);
        }
    }

    const injectedIndices = injectedMessages.map(msg => messages.indexOf(msg));
    messages.reverse();
    return injectedIndices;
}
```

Semantics of the depth number, precisely:
- Array is reversed to newest-first, so index `0` = the position **after the last message** (i.e. closest to the model's turn). **depth = number of chat messages that come after the injected block.**
- `depth 0` = at the very end of the chat, after the newest message. `depth 1` = before the newest message. Etc.
- `isContinue && i === 0` bumps depth-0 to 1 so a continuation isn't broken by an injection between the partial reply and the model.
- `totalInsertedMessages` keeps already-injected pseudo-messages from shifting later depths.
- `Math.min(..., messages.length)` clamps a depth larger than the chat.
- Within one depth, role order is **SYSTEM, then USER, then ASSISTANT** — "most important go lower", i.e. ASSISTANT ends up nearest the model.
- Among multiple extension prompts sharing the same (position, depth, role), `getExtensionPrompt` (script.js:3242-3270) orders them by **lexicographic sort of the extension-prompt key** (`Object.keys(extension_prompts).sort()`) and joins with `separator`. WI keys are `customDepthWI_<depth>_<role>`, the AN is `2_floating_prompt`, memory is `1_memory`, vectors `3_vectors`, etc.

Called at script.js:4684-4687, only for non-OAI APIs:
```js
let injectedIndices = [];
if (main_api !== 'openai') {
    injectedIndices = await doChatInject(coreChat, isContinue);
}
```
The indices are then tracked/shifted (4700-4703, 4810-4811, 4880-4892) so that injected pseudo-messages don't count toward `setInContextMessages(arrMes.length - injectedIndices.length, type)` (4895) and are flagged `item.injected` on `finalMesSend` (5147-5149).

For chat completion, openai.js:806-871 `populationInjectionPrompts` does the equivalent, additionally grouping by `prompt.injection_order` (default 100, sorted high→low) and only pulling `getExtensionPrompt(IN_CHAT, i, ...)` into the `order === '100'` group.

---

## 3. Timed effects — sticky / cooldown / delay

### 3.1 Fields and storage

Entry fields (world-info.js:4038-4040), all default `null` = disabled, UI `min: 1, max: 10000, clamp: false` (3677-3689):

```js
sticky:   { default: null, type: 'number?' },
cooldown: { default: null, type: 'number?' },
delay:    { default: null, type: 'number?' },
```

Character-card round-trip keys (world-info.js:2639-2641): `extensions.sticky`, `extensions.cooldown`, `extensions.delay`.

**State lives in chat metadata**, not in the lorebook:

```js
chat_metadata.timedWorldInfo = {
    sticky:   { [`${world}.${uid}`]: WITimedEffect },
    cooldown: { [`${world}.${uid}`]: WITimedEffect },
}
```

`delay` has **no persisted state at all** — it is recomputed from chat length every scan.

`WITimedEffect` typedef (world-info.js:140-145):

```js
/**
 * @typedef {object} WITimedEffect Timed effect for world info
 * @property {number} hash Hash of the entry that triggered the effect
 * @property {number} start The chat index where the effect starts
 * @property {number} end The chat index where the effect ends
 * @property {boolean} protected The protected effect can't be removed if the chat does not advance
 */
```

Built by `#getEntryTimedEffect` (604-611):

```js
#getEntryTimedEffect(type, entry, isProtected) {
    return {
        hash: this.#getEntryHash(entry),
        start: this.#chat.length,
        end: this.#chat.length + Number(entry[type]),
        protected: !!isProtected,
    };
}
```

`this.#chat` is `chatForWI` → **`chat.length` = number of non-system chat messages at scan time**. The unit of sticky/cooldown/delay is therefore "messages".

Key: `#getEntryKey(entry) => `${entry.world}.${entry.uid}`` (593-595).
Hash: `#getEntryHash(entry) => entry.hash` (584-586), where `hash` is computed in `getSortedEntries` (4516-4522) as `getStringHash(JSON.stringify(entry))` **after** decorator parsing, so editing an entry invalidates its running effects.

### 3.2 Per-scan evaluation

`checkWorldInfo` line 4633-4635:

```js
const sortedEntries = await getSortedEntries();
const timedEffects = new WorldInfoTimedEffects(chat, sortedEntries, isDryRun);
timedEffects.checkTimedEffects();
```

```js
checkTimedEffects() {
    if (!this.#isDryRun) {
        this.#checkTimedEffectOfType('sticky',   this.#buffer.sticky,   this.#onEnded.sticky.bind(this));
        this.#checkTimedEffectOfType('cooldown', this.#buffer.cooldown, this.#onEnded.cooldown.bind(this));
    }
    this.#checkDelayEffect(this.#buffer.delay);
}
```
(682-688) — **on a dry run, sticky/cooldown are not evaluated at all; only delay is.**

`#checkTimedEffectOfType` (619-660), evaluated per stored metadata record, in this exact order:

```js
const effects = Object.entries(chat_metadata.timedWorldInfo[type]);
for (const [key, value] of effects) {
    const entry = this.#entries.find(x => String(this.#getEntryHash(x)) === String(value.hash));

    // 1. chat did not advance since the effect started -> drop it (unless protected)
    if (this.#chat.length <= Number(value.start) && !value.protected) {
        delete chat_metadata.timedWorldInfo[type][key];
        continue;
    }

    // 2. entry no longer present (e.g. another character's lorebook): drop once the interval passed
    if (!entry) {
        if (this.#chat.length >= Number(value.end)) delete chat_metadata.timedWorldInfo[type][key];
        continue;
    }

    // 3. entry no longer configured for this effect -> drop
    if (!entry[type]) {
        delete chat_metadata.timedWorldInfo[type][key];
        continue;
    }

    // 4. interval elapsed -> drop + fire onEnded
    if (this.#chat.length >= Number(value.end)) {
        delete chat_metadata.timedWorldInfo[type][key];
        if (typeof onEnded === 'function') onEnded(entry);
        continue;
    }

    // 5. still running -> mark active for this scan
    buffer.push(entry);
}
```

Rule 1 is the swipe/regeneration guard: if you regenerate without adding a message, a freshly-set sticky is removed rather than double-counted. `protected: true` opts out — and the only place it is set is the sticky→cooldown handoff.

`#checkDelayEffect` (666-677):

```js
for (const entry of this.#entries) {
    if (!entry.delay) continue;
    if (this.#chat.length < entry.delay) {
        buffer.push(entry);   // active == suppressed
    }
}
```
So `delay = N` means "this entry cannot activate until the chat has at least N messages."

`isEffectActive` (777-783):
```js
isEffectActive(type, entry) {
    if (!this.isValidEffectType(type)) return false;
    return this.#buffer[type]?.some(x => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false;
}
```
`isValidEffectType` accepts only `'sticky' | 'cooldown' | 'delay'` (case-insensitive, trimmed).

### 3.3 sticky → cooldown handoff

world-info.js:512-541:

```js
#onEnded = {
    'sticky': (entry) => {
        if (!entry.cooldown) return;
        const key = this.#getEntryKey(entry);
        const effect = this.#getEntryTimedEffect('cooldown', entry, true);   // protected = true
        chat_metadata.timedWorldInfo.cooldown[key] = effect;
        console.log(`[WI] Adding cooldown entry ${key} on ended sticky: ...`);
        // Set the cooldown immediately for this evaluation
        this.#buffer.cooldown.push(entry);
    },
    'cooldown': (entry) => { console.debug('[WI] Cooldown ended for entry', entry.uid); },
    'delay': () => { },
};
```

The moment a sticky expires, a **protected** cooldown starts at the *current* chat length and is active for the very same scan (pushed into the buffer, not just persisted). `protected` prevents rule 1 from deleting it if the user swipes immediately.

### 3.4 Where the effects gate activation

Inside the per-entry activation loop (world-info.js:4733-4791), in exactly this order:

```js
const isSticky   = timedEffects.isEffectActive('sticky', entry);
const isCooldown = timedEffects.isEffectActive('cooldown', entry);
const isDelay    = timedEffects.isEffectActive('delay', entry);

if (isDelay) { log('suppressed by delay'); continue; }

if (isCooldown && !isSticky) { log('suppressed by cooldown'); continue; }

// Only use checks for recursion flags if the scan step was activated by recursion
if (scanState !== scan_state.RECURSION && entry.delayUntilRecursion && !isSticky) { ... continue; }
if (scanState === scan_state.RECURSION && entry.delayUntilRecursion && entry.delayUntilRecursion > currentRecursionDelayLevel && !isSticky) { ... continue; }
if (scanState === scan_state.RECURSION && world_info_recursive && entry.excludeRecursion && !isSticky) { ... continue; }

if (entry.decorators.includes('@@activate'))      { activatedNow.add(entry); continue; }
if (entry.decorators.includes('@@dont_activate')) { continue; }
if (buffer.getExternallyActivated(entry))         { activatedNow.add(...); continue; }
if (entry.constant)                                { activatedNow.add(entry); continue; }
if (isSticky) { log('activated because active sticky'); activatedNow.add(entry); continue; }
// ...then keyword matching
```

Key points:
- **delay outranks everything**, including sticky and `constant`.
- **sticky beats cooldown** and overrides `delayUntilRecursion` / `excludeRecursion`.
- sticky auto-activates the entry with **no keyword check**, but it sits *below* the decorators, external activation and `constant` in the chain (they short-circuit first anyway with the same outcome).
- Sticky entries also skip the probability re-roll (4916-4920): `if (isSticky) { ...does not need to re-roll probability...; return true; }`.
- Sticky entries are sorted to the **front** of `newEntries` (4882-4887), so they get first claim on the token budget:
```js
const newEntries = [...activatedNow].sort((a, b) => {
    const isASticky = timedEffects.isEffectActive('sticky', a) ? 1 : 0;
    const isBSticky = timedEffects.isEffectActive('sticky', b) ? 1 : 0;
    return isBSticky - isASticky || sortedEntries.indexOf(a) - sortedEntries.indexOf(b);
});
```

### 3.5 Committing effects

After the prompt is built (world-info.js:5155-5157):

```js
timedEffects.setTimedEffects(Array.from(allActivatedEntries.values()));
buffer.resetExternalEffects();
timedEffects.cleanUp();
```

```js
setTimedEffects(activatedEntries) {
    if (this.#isDryRun) return;
    for (const entry of activatedEntries) {
        this.#setTimedEffectOfType('sticky', entry);
        this.#setTimedEffectOfType('cooldown', entry);
    }
}

#setTimedEffectOfType(type, entry) {
    if (!entry[type]) return;
    const key = this.#getEntryKey(entry);
    if (!chat_metadata.timedWorldInfo[type][key]) {          // do not restart a running effect
        const effect = this.#getEntryTimedEffect(type, entry, false);
        chat_metadata.timedWorldInfo[type][key] = effect;
    }
}
```
(730-736, 710-724)

So: **an entry that activates and has a cooldown starts its cooldown on the same turn it fires** (not after it stops firing) — unless it also has sticky, in which case a cooldown record already exists and the sticky-end handler re-arms a protected one later. `cleanUp()` (788-792) empties the three in-memory buffers.

Manual override (`/wi-set-timed-effect`, world-info.js:744-760): `setTimedEffect(type, entry, newState)` deletes then optionally re-creates the record; it is a no-op during dry runs except for `delay`. `/wi-get-timed-effect` with `format=number` returns `data.end - chat.length` (remaining messages) or `0` (1486).

Structural repair on construction (`#ensureChatMetadata`, 559-577) creates `chat_metadata.timedWorldInfo` and its `sticky`/`cooldown` sub-objects and prunes non-object values.

---

## 4. Inclusion groups

### 4.1 Fields

world-info.js:4029-4035:

```js
group:           { default: '',            type: 'string'   },
groupOverride:   { default: false,         type: 'boolean'  },
groupWeight:     { default: DEFAULT_WEIGHT /* 100 */, type: 'number' },
useGroupScoring: { default: null,          type: 'boolean?' },  // null = inherit global
```
Global setting: `world_info_use_group_scoring` (default `false`, world-info.js:940-952).
Card keys: `extensions.group`, `extensions.group_override`, `extensions.group_weight`, `extensions.use_group_scoring` (5529-5535).

### 4.2 Entry point

Called once per scan loop iteration, on the entries newly activated *this* iteration (world-info.js:4893):

```js
filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);
```

### 4.3 The algorithm (world-info.js:5269-5356), step by step

**Step 0 — bucket.** An entry's `group` string is **comma-separated**; an entry can belong to multiple groups simultaneously:

```js
const grouped = newEntries.filter(x => x.group).reduce((acc, item) => {
    item.group.split(/,\s*/).filter(x => x).forEach(group => {
        if (!acc[group]) acc[group] = [];
        acc[group].push(item);
    });
    return acc;
}, {});
if (Object.keys(grouped).length === 0) return;
```

`removeEntry` mutates the shared `newEntries` array — so eliminating an entry from one group removes it from consideration entirely:
```js
const removeEntry = (entry) => newEntries.splice(newEntries.indexOf(entry), 1);
function removeAllBut(group, chosen, logging = true) {
    for (const entry of group) {
        if (entry === chosen) continue;
        if (logging) console.debug(...);
        removeEntry(entry);
    }
}
```

**Step 1 — timed-effect filter** (`filterGroupsByTimedEffects`, 5218-5259):

```js
for (const [key, group] of Object.entries(groups)) {
    hasStickyMap.set(key, false);

    // If the group has any sticky entries, leave only the sticky entries
    const stickyEntries = group.filter(x => timedEffects.isEffectActive('sticky', x));
    if (stickyEntries.length) {
        for (const entry of group) {
            if (stickyEntries.includes(entry)) continue;
            removeEntry(entry);        // "removed as a non-sticky loser"
        }
        hasStickyMap.set(key, true);
    }

    const cooldownEntries = group.filter(x => timedEffects.isEffectActive('cooldown', x));
    if (cooldownEntries.length) { for (const entry of cooldownEntries) removeEntry(entry); }

    const delayEntries = group.filter(x => timedEffects.isEffectActive('delay', x));
    if (delayEntries.length) { for (const entry of delayEntries) removeEntry(entry); }
}
```
Note: sticky wins are **not** narrowed to one — *all* sticky members survive. The cooldown/delay sweeps are belt-and-braces (the comment at 5240 says as much: "It should not be possible for an entry on cooldown/delay to even get into the grouping phase but @Wolfsblvt told me to leave it here.").

**Step 2 — scoring filter** (`filterGroupsByScoring`, 5173-5209):

```js
for (const [key, group] of Object.entries(groups)) {
    // Group scoring is disabled both globally and for the group entries
    if (!world_info_use_group_scoring && !group.some(x => x.useGroupScoring)) continue;

    // If the group has any sticky entries, the rest are already removed by the timed effects filter
    if (hasStickyMap.get(key)) continue;

    const scores = group.map(entry => buffer.getScore(entry, scanState));
    const maxScore = Math.max(...scores);

    for (let i = 0; i < group.length; i++) {
        const isScored = group[i].useGroupScoring ?? world_info_use_group_scoring;
        if (!isScored) continue;                     // per-entry opt-out survives regardless of score
        if (scores[i] < maxScore) {
            removeEntry(group[i]);                   // "removed as score loser"
            group.splice(i, 1); scores.splice(i, 1); i--;
        }
    }
}
```

Scoring is "how many of my keys matched", `WorldInfoBuffer.getScore` (world-info.js:428-473):

```js
getScore(entry, scanState) {
    const bufferState = this.get(entry, scanState);
    let numberOfPrimaryKeys = 0, numberOfSecondaryKeys = 0, primaryScore = 0, secondaryScore = 0;

    if (Array.isArray(entry.key)) {
        numberOfPrimaryKeys = entry.key.length;
        for (const key of entry.key) if (this.matchKeys(bufferState, key, entry)) primaryScore++;
    }
    if (Array.isArray(entry.keysecondary)) {
        numberOfSecondaryKeys = entry.keysecondary.length;
        for (const key of entry.keysecondary) if (this.matchKeys(bufferState, key, entry)) secondaryScore++;
    }

    if (!numberOfPrimaryKeys) return 0;   // No keys == no score (constant/sticky entries score 0)

    // Only positive logic influences the score
    if (numberOfSecondaryKeys > 0) {
        switch (entry.selectiveLogic) {
            case world_info_logic.AND_ANY: return primaryScore + secondaryScore;
            case world_info_logic.AND_ALL:
                return secondaryScore === numberOfSecondaryKeys ? primaryScore + secondaryScore : primaryScore;
        }
    }
    return primaryScore;
}
```
(`world_info_logic = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 }`, world-info.js:33-38. NOT_ALL and NOT_ANY contribute nothing beyond `primaryScore`.)

**Step 3 — per-group winner selection** (5302-5355), in order:

```js
for (const [key, group] of Object.entries(grouped)) {
    // (a) sticky already decided it
    if (hasStickyMap.get(key)) continue;

    // (b) group already has a winner from a previous scan loop
    if (Array.from(allActivatedEntries.values()).some(x => x.group === key)) {
        removeAllBut(group, null, false);   // kill the whole group, silently
        continue;
    }

    // (c) nothing to decide
    if (!Array.isArray(group) || group.length <= 1) continue;

    // (d) priority override wins
    const prios = group.filter(x => x.groupOverride).sort(sortFn);   // sortFn = descending `order`
    if (prios.length) { removeAllBut(group, prios[0]); continue; }

    // (e) weighted random
    const totalWeight = group.reduce((acc, item) => acc + (item.groupWeight ?? DEFAULT_WEIGHT), 0);
    const rollValue = Math.random() * totalWeight;
    let currentWeight = 0, winner = null;
    for (const entry of group) {
        currentWeight += (entry.groupWeight ?? DEFAULT_WEIGHT);
        if (rollValue <= currentWeight) { winner = entry; break; }
    }
    if (!winner) continue;                  // group fully fails, nobody removed
    removeAllBut(group, winner);
}
```

Notes / gotchas for a reimplementation:
- (b) compares `x.group === key` with **strict string equality on the whole `group` field**, whereas bucketing splits on commas. A previously-activated entry whose `group` is `"a, b"` will NOT match key `"a"`. Multi-group entries therefore leak past the "already activated" guard.
- (d) `groupOverride` among several: highest `order` wins (`sortFn` is descending by `order`). No randomness.
- (e) The roll iterates the group in **`newEntries` order** (sticky-first, then `sortedEntries` index = order-descending within lore-source strategy), not sorted by weight. `groupWeight` 0 makes an entry unwinnable only if it isn't first-with-rollValue-0.
- `useGroupScoring` per entry is tri-state: `true` = force scoring for that entry, `false` = exempt that entry from being score-culled even if the group is scored, `null` = follow the global flag.

---

## 5. Token budget enforcement and drop order

### 5.1 Budget computation (world-info.js:4624-4631)

```js
let budget = Math.round(world_info_budget * maxContext / 100) || 1;

if (world_info_budget_cap > 0 && budget > world_info_budget_cap) {
    console.debug(`[WI] Budget ${budget} exceeds cap ${world_info_budget_cap}, using cap`);
    budget = world_info_budget_cap;
}
```
- `world_info_budget` default `25` (percent), migrated down to 25 if a stored value exceeds 100 (946-948).
- `world_info_budget_cap` is an absolute token cap; `0` = no cap.
- `|| 1` guarantees at least 1 token.
- `maxContext` is `this_max_context` from the caller.

### 5.2 The enforcement loop (world-info.js:4890-4958)

```js
let newContent = '';
const textToScanTokens = await getTokenCountAsync(allActivatedText);

filterByInclusionGroups(newEntries, allActivatedEntries, buffer, scanState, timedEffects);

let ignoresBudget = newEntries.filter(e => e.ignoreBudget).length;

for (const entry of newEntries) {
    ignoresBudget -= (entry.ignoreBudget ? 1 : 0);
    if (token_budget_overflowed && !entry.ignoreBudget) {
        if (ignoresBudget > 0) {
            continue;        // still more ignoreBudget entries down the list -> keep scanning
        }
        break;               // nothing left that could be admitted -> stop
    }

    function verifyProbability() {
        if (!entry.useProbability || entry.probability === 100) return true;
        const isSticky = timedEffects.isEffectActive('sticky', entry);
        if (isSticky) return true;                       // sticky never re-rolls
        const rollValue = Math.random() * 100;
        if (rollValue <= entry.probability) return true;
        failedProbabilityChecks.add(entry);
        return false;
    }

    const success = verifyProbability();
    if (!success) continue;

    // Substitute macros inline, for both this checking and also future processing
    entry.content = substituteParams(entry.content);
    newContent += `${entry.content}\n`;

    if (!entry.ignoreBudget && (textToScanTokens + (await getTokenCountAsync(newContent))) >= budget) {
        if (!token_budget_overflowed) {
            if (world_info_overflow_alert) {
                console.warn(`[WI] budget of ${budget} reached, stopping after ${allActivatedEntries.size} entries`);
                toastr.warning(`World info budget reached after ${allActivatedEntries.size} entries.`, 'World Info');
            }
            token_budget_overflowed = true;
        }
        continue;            // this entry is DROPPED
    }

    allActivatedEntries.set(`${entry.world}.${entry.uid}`, entry);
}
```

Exact semantics:
- **Order entries are dropped**: `newEntries` order, which is (world-info.js:4882-4887) `sticky-first, then ascending index in sortedEntries`. `sortedEntries` (from `getSortedEntries`, 4478-4527) is built per `world_info_character_strategy`:
  ```js
  world_info_insertion_strategy = { evenly: 0, character_first: 1, global_first: 2 };
  // evenly:          [...globalLore, ...characterLore].sort(sortFn)
  // character_first: [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)]
  // global_first:    [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)]
  // then: entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];
  ```
  So the **survival priority** is: sticky > chat lore > persona lore > (strategy-dependent global/character interleave) > within each block, **higher `order` first**. Once the running total hits the budget, everything after that point is dropped **except** entries with `ignoreBudget: true`, which are always admitted.
- The overflowing entry itself is dropped, but its content **stays in `newContent`**, so it still counts against every later `ignoreBudget`-exempt evaluation in the same loop.
- `textToScanTokens` is the token count of `allActivatedText`, the accumulated content admitted in *previous* recursion iterations (4622, 5024). So the budget is cumulative across recursion levels.
- The comparison is `>= budget` — reaching the budget exactly counts as overflow.
- Once `token_budget_overflowed` is true, recursion halts (4978, 4985) and min-activations expansion halts (4992).
- **Subtlety**: `successfulNewEntries = newEntries.filter(x => !failedProbabilityChecks.has(x))` (4960) — budget-dropped entries are still "successful" for logging and for the `WORLDINFO_SCAN_DONE` event payload, though they are not in `allActivatedEntries`.
- Second, later filter: entries whose regexed content is empty are dropped during the bucketing pass at 5088-5091, **after** they have consumed budget.

`ignoreBudget` default `false` (4015). `probability` default `100`, `useProbability` default `true` (4025-4026).

### 5.3 There is no per-position budget

All positions share one budget, spent in a single pass before positions are ever considered. An `atDepth` entry and a `before` entry compete on equal terms.

---

## 6. Full hand-off of the result strings

`checkWorldInfo` returns (world-info.js:5162):

```js
return {
    worldInfoBefore, worldInfoAfter,
    EMEntries, WIDepthEntries,
    ANBeforeEntries: ANTopEntries,
    ANAfterEntries: ANBottomEntries,
    outletEntries: WIOutletEntries,
    allActivatedEntries: new Set(allActivatedEntries.values()),
};
```
Early-out when there are no entries at all (4637-4639) returns the same shape with empties.

Consumption summary:

| Result | Consumer | Mechanism |
|---|---|---|
| `worldInfoBefore` | script.js:4652-4655 | `storyStringParams.wiBefore` / `.loreBefore` → `renderStoryString` → `combinedStoryString` → `combine()` at 5133-5138 |
| `worldInfoAfter` | script.js:4653-4655 | `storyStringParams.wiAfter` / `.loreAfter` |
| both (OAI) | script.js:5231-5232 → openai.js:1372-1373 | `formatWorldInfo()` → `worldInfoBefore` / `worldInfoAfter` prompt identifiers, positioned around `main` at openai.js:1208-1210 |
| `worldInfoExamples` (EM) | script.js:4580-4596 | `mesExamplesArray.unshift/push(...parseMesExamples(...))` |
| `worldInfoDepth` | script.js:4609-4613 | `setExtensionPrompt('customDepthWI_<d>_<r>', joined, IN_CHAT(1), d, false, r)` → `doChatInject` / `populationInjectionPrompts` |
| `outletEntries` | script.js:4615-4619 | `setExtensionPrompt('customWIOutlet_<key>', joined, NONE(-1), 0)` → `{{outlet::key}}` macro |
| AN entries | world-info.js:5149-5153 (side effect) | re-`setExtensionPrompt('2_floating_prompt', ...)` wrapping the existing AN value |
| `allActivatedEntries` | world-info.js:900-903 | `eventSource.emit(event_types.WORLD_INFO_ACTIVATED, arg)` (skipped on dry run) |

The whole depth/outlet block is gated on `skipWIAN !== true` (script.js:4605); when skipped, `flushWIInjections()` is not even called, so stale injections from the previous generation persist.

Final text-completion assembly (script.js:5133-5144):

```js
let combinedPrompt = [
    combinedStoryString,
    mesExmString,
    mesSendString,
    generatedPromptCache,
].join('').replace(/\r/gm, '');
if (power_user.collapse_newlines) combinedPrompt = collapseNewlines(combinedPrompt);
```
`mesSendString` already contains the depth-injected pseudo-messages, because `doChatInject` spliced them into `coreChat` at 4686 before message assembly.

If `power_user.context.story_string_position === extension_prompt_types.IN_CHAT`, the entire story string (WI before/after included) is itself turned into a depth injection (script.js:4667-4676) using `inject_ids.STORY_STRING` at `power_user.context.story_string_depth ?? 1` with role `story_string_role ?? SYSTEM`, and `combinedStoryString` is blanked to avoid duplication.

---

## 7. Reference enum table (all numeric values in one place)

```js
// world-info.js:855
world_info_position       = { before:0, after:1, ANTop:2, ANBottom:3, atDepth:4, EMTop:5, EMBottom:6, outlet:7 }
// world-info.js:866
wi_anchor_position        = { before:0, after:1 }
// world-info.js:27
world_info_insertion_strategy = { evenly:0, character_first:1, global_first:2 }
// world-info.js:33
world_info_logic          = { AND_ANY:0, NOT_ALL:1, NOT_ANY:2, AND_ALL:3 }
// world-info.js:43
scan_state                = { NONE:0, INITIAL:1, RECURSION:2, MIN_ACTIVATIONS:3 }
// script.js:483
extension_prompt_types    = { NONE:-1, IN_PROMPT:0, IN_CHAT:1, BEFORE_PROMPT:2 }
// script.js:493
extension_prompt_roles    = { SYSTEM:0, USER:1, ASSISTANT:2 }
// script.js:499
MAX_INJECTION_DEPTH       = 10000
// world-info.js:96-99
DEFAULT_DEPTH = 4; DEFAULT_WEIGHT = 100; MAX_SCAN_DEPTH = 1000; MAX_COMMENT_LENGTH = 100
KNOWN_DECORATORS = ['@@activate', '@@dont_activate']
// authors-note.js:38
chara_note_position       = { replace:0, before:1, after:2 }
```

Relevant entry-schema defaults (world-info.js:4002-4045):
`order:100`, `position:0`, `depth:4`, `role:0`, `probability:100`, `useProbability:true`, `selective:true`, `selectiveLogic:0`, `constant:false`, `ignoreBudget:false`, `excludeRecursion:false`, `preventRecursion:false`, `delayUntilRecursion:0`, `group:''`, `groupOverride:false`, `groupWeight:100`, `useGroupScoring:null`, `sticky:null`, `cooldown:null`, `delay:null`, `outletName:''`, `vectorized:false`, `disable:false`, `triggers:[]`.

## Reusable
## Copy essentially verbatim (pure logic, no DOM, no jQuery)

1. **The enums** — `world_info_position`, `wi_anchor_position`, `extension_prompt_types`, `extension_prompt_roles`, `world_info_logic`, `scan_state`, and the constants (`DEFAULT_DEPTH=4`, `DEFAULT_WEIGHT=100`, `MAX_INJECTION_DEPTH=10000`). Put them in a `src/constants/wi.ts` as `const` objects with `as const` + derived union types. Keeping the *numeric* values identical is what buys you SillyTavern lorebook/character-card import compatibility — do not renumber.

2. **The bucketing switch** (world-info.js:5084-5147). It is ~60 lines of pure function: `(activatedEntries: WIEntry[]) => { before: string; after: string; em: {position, content}[]; anTop: string[]; anBottom: string[]; depth: {depth, role, entries}[]; outlets: Record<string, string[]> }`. Port it as-is; fix the two known defects while you do: (a) use `entry.depth ?? DEFAULT_DEPTH` in the `WIDepthEntries.push` branch, not the raw value; (b) make the outlet branch `unshift` like every other branch so ordering is consistent.

3. **`filterByInclusionGroups` + `filterGroupsByTimedEffects` + `filterGroupsByScoring`** (world-info.js:5173-5356) and **`getScore`** (428-473). Pure functions over arrays. Port whole. Fix the multi-group leak in step (b): compare `x.group.split(/,\s*/).includes(key)` instead of `x.group === key`.

4. **`WorldInfoTimedEffects`** (world-info.js:479-793). The class is already storage-agnostic apart from three references to the global `chat_metadata`. Change `#ensureChatMetadata` / all `chat_metadata.timedWorldInfo[...]` accesses to take an injected store object, then the class ports unchanged. In Pinia: keep `timedWorldInfo: { sticky: Record<string, WITimedEffect>, cooldown: Record<string, WITimedEffect> }` on the **chat** store (it is per-chat state, must be persisted alongside the chat in IndexedDB, and must be cloned/branched when a chat is branched). `delay` needs no persistence.

5. **The budget loop** (world-info.js:4890-4958) including the `ignoresBudget` counter trick and the `>= budget` comparison. The only external dependency is an async `getTokenCount(text)`; wire that to whatever tokenizer you use (a wasm tiktoken or a heuristic).

6. **`doChatInject`** (script.js:5569-5617). This is the entire "insert at depth N with role R" mechanic and it is 45 lines. Keep the reverse → splice → reverse structure and the `totalInsertedMessages` accumulator; both are load-bearing.

## Adapt

- **`getExtensionPrompt`'s key-sort ordering** (script.js:3250-3256, `Object.keys(extension_prompts).sort()`). SillyTavern uses lexicographic key names (`1_memory`, `2_floating_prompt`, `3_vectors`, `customDepthWI_*`) as an implicit priority system. In a fresh app, make this explicit: give each injection source a numeric `priority` field and sort by it. Keep the *relative* result (memory < AN < vectors < WI-depth) if you want familiar behavior.
- **`MAX_INJECTION_DEPTH = 10000` with a `for (let i = 0; i <= maxDepth; i++)` loop** is a 10,001-iteration loop per generation doing async work each pass. Replace with: bucket the injections into a `Map<depth, Injection[]>`, sort the keys ascending, iterate only the occupied depths. Same output, 4 orders of magnitude cheaper.
- **Store the position/role as an entry field pair, but drive the UI from a flattened list.** SillyTavern's `<select>` hack — three `<option value="4">` differing only by `data-role` — exists because HTML selects need unique display rows. In Vue, model the UI value as a string key like `'atDepth:1'` and split it in a computed setter; store `{position: 4, role: 1}`.
- **Author's Note coupling.** The `shouldWIAddPrompt` side-effect write-back at world-info.js:5149-5153 reaches out of the WI module into another module's extension prompt. In a Pinia app, return `anTop`/`anBottom` as data from the WI action and let the prompt-assembly action compose them with the AN. Don't reproduce the cross-store mutation.
- **`chat.length` as the timed-effect clock.** Decide once what your message-count unit is (SillyTavern uses *non-system* messages, `chat.filter(x => !x.is_system)`) and use exactly that everywhere — `start`, `end`, and the delay comparison. Mismatches here produce effects that never expire.
- **The `hash` for timed effects** is `getStringHash(JSON.stringify(entry))` over the whole entry after decorator parsing (world-info.js:4520). This means *any* edit to an entry orphans its running sticky/cooldown. If that's undesirable, hash a stable subset (`world + uid + content`) instead — but then you lose SillyTavern's implicit "edited entry restarts its timers" behavior. Pick deliberately.

## Do NOT bother porting

- Everything between roughly world-info.js:1000-4000: the jQuery entry editor, `WI_ENTRY_HEADER_TEMPLATE`/`WI_ENTRY_EDIT_TEMPLATE`, all the `handleNumberInputHelper` / `handleProbabilityInputHelper` / `updatePosOrdDisplayHelper` DOM plumbing, drag-sort, the ~40 slash commands and their `SlashCommandEnumValue` providers, `enumIcons`, i18n title strings.
- `convertAgnaiMemoryBook` / `convertRisuLorebook` / `convertNovelLorebook` (world-info.js:5358-5490) unless you actually need those import formats. Do keep `convertCharacterBook` (5501-5555) — it is the character-card V2/V3 `character_book` mapping and defines the on-disk field names (`extensions.position`, `extensions.role`, `extensions.group_weight`, `extensions.sticky`, …) you need for interop.
- The `outlet` position (7) unless you want a `{{outlet::name}}` macro system. It is inert without a macro engine — `extension_prompt_types.NONE` means nothing ever reads it automatically.
- `world_info_min_activations` / `min_activations_depth_max` / `advanceScan()` progressive-depth-widening machinery, and `delayUntilRecursion` levels, if you are building a simpler scanner. They interact with the budget loop only through the `token_budget_overflowed` short-circuits at 4978/4985/4992, which are easy to drop.
- `toastr` overflow alerts, `console.debug` tracing, and the `WORLDINFO_SCAN_DONE` mutation protocol (world-info.js:5058-5067) where event listeners are allowed to rewrite `scanState`, `budget`, and `allActivatedText` mid-scan. That extension hook is a large correctness surface for very little benefit in a greenfield app.