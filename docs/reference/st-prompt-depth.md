# SillyTavern prompt assembly pipeline and depth injection (Generate(), setExtensionPrompt, doChatInject, openai.js populationInjectionPrompts / populateChatCompletion, authors-note.js)

## Key files
- D:/tauriApp/SillyTavern/public/script.js — Core. Defines extension_prompt_types (L483), extension_prompt_roles (L493), MAX_INJECTION_DEPTH (L499), setExtensionPrompt (L8866), getExtensionPrompt (L3242), getExtensionPromptByName (L3198), getExtensionPromptMaxDepth (L3222), getExtensionPromptRoleByName (L8882), removeDepthPrompts (L8905), addPersonaDescriptionExtensionPrompt (L3144), getCharacterCardFields (L3417), Generate() (L4231), doChatInject (L5569), flushWIInjections (L5619).
- D:/tauriApp/SillyTavern/public/scripts/openai.js — Chat-completion assembly. setOpenAIMessages (L566, reverses chat), populationInjectionPrompts (L806, the OAI depth-injection engine), populateChatHistory (L881), populateDialogueExamples (L1097), getPromptPosition (L1136), getPromptRole (L1153), populateChatCompletion (L1181, the master order), preparePromptsForChatCompletion (L1363), prepareOpenAIMessages (L1538), Message (L3444), MessageCollection (L3741), ChatCompletion (L3850, add/insert/getChat/squashSystemMessages).
- D:/tauriApp/SillyTavern/public/scripts/authors-note.js — Author's Note. MODULE_NAME = '2_floating_prompt', metadata_keys, chara_note_position, loadSettings defaults (depth 4, position 1=IN_CHAT, interval 1, role SYSTEM), setFloatingPrompt() which calls setExtensionPrompt with the AN position/depth/role.
- D:/tauriApp/SillyTavern/public/scripts/PromptManager.js — INJECTION_POSITION enum {RELATIVE:0, ABSOLUTE:1} (L37), DEFAULT_DEPTH=4 / DEFAULT_ORDER=100 (L31-32), Prompt class with injection_depth/injection_order/injection_position/injection_trigger, PromptCollection (index/get/has/override), getPromptCollection(generationType) which materializes the user's prompt_order.
- D:/tauriApp/SillyTavern/public/scripts/constants.js — inject_ids (L48-56): STORY_STRING, QUIET_PROMPT, DEPTH_PROMPT, DEPTH_PROMPT_INDEX(i), CUSTOM_WI_DEPTH, CUSTOM_WI_DEPTH_ROLE(depth,role), CUSTOM_WI_OUTLET(key).
- D:/tauriApp/SillyTavern/public/scripts/world-info.js — world_info_position enum (L855) incl. atDepth:4, WIDepthEntries building (L5078-5144), AN hijack via setExtensionPrompt (L5152), scan-flag injection into the WI buffer via getExtensionPromptByName (L4607-4614).
- D:/tauriApp/SillyTavern/public/scripts/personas.js — persona_description_positions enum (L88): IN_PROMPT:0, AFTER_CHAR:1(deprecated), TOP_AN:2, BOTTOM_AN:3, AT_DEPTH:4, NONE:9.
- D:/tauriApp/SillyTavern/public/scripts/slash-commands.js — /inject slash command (L3780-3843): position map {before:BEFORE_PROMPT, after:IN_PROMPT, chat:IN_CHAT, none:NONE}, defaultDepth 4, persisted in chat_metadata.script_injects, rehydrated by processChatSlashCommands (L3891).
- D:/tauriApp/SillyTavern/public/scripts/extensions/memory/index.js — Summary extension, MODULE_NAME='1_memory', defaults position IN_PROMPT, role SYSTEM, depth 2; calls setExtensionPrompt at L965.
- D:/tauriApp/SillyTavern/public/scripts/extensions/vectors/index.js — Vectors. EXTENSION_PROMPT_TAG='3_vectors' (depth 2, IN_PROMPT), EXTENSION_PROMPT_TAG_DB='4_vectors_data_bank' (file_depth_db 4, IN_PROMPT, role SYSTEM). setExtensionPrompt at L696/784/785/854.
- D:/tauriApp/SillyTavern/default/content/presets/openai/Default.json — Default chat-completion prompt_order: main, worldInfoBefore, charDescription, charPersonality, scenario, enhanceDefinitions(off), nsfw, worldInfoAfter, dialogueExamples, chatHistory, jailbreak. (character_id 100001 variant inserts personaDescription after worldInfoBefore.)
- D:/tauriApp/SillyTavern/default/content/presets/context/Default.json — Text-completion story_string Handlebars template and story_string_position/depth/role defaults (0 / 1 / 0).

## Report
        # SillyTavern Prompt Assembly + Depth Injection — Authoritative Spec

        Everything below is from `D:/tauriApp/SillyTavern/public/...`. Line numbers are as of the checked-out tree.

        ---

        ## 0. The two pipelines

        SillyTavern has **two completely separate assembly paths**, chosen by `main_api`:

        | | `main_api === 'openai'` (Chat Completion) | everything else (Text Completion / instruct) |
        |---|---|---|
        | Assembler | `openai.js` → `prepareOpenAIMessages` → `populateChatCompletion` | `script.js` `Generate()` inline (storyString + chat2 + mesSend) |
        | Depth injector | `openai.js populationInjectionPrompts()` | `script.js doChatInject()` |
        | Output | array of `{role, content, name?, tool_calls?}` | one flat string |

        `Generate()` explicitly gates the text-completion injector:

        ```js
        // script.js:4683-4687
        // Inject all Depth prompts. Chat Completion does it separately
        let injectedIndices = [];
        if (main_api !== 'openai') {
            injectedIndices = await doChatInject(coreChat, isContinue);
        }
        ```

        If you are reimplementing a chat-completion client, **`doChatInject` is not your model** — `populationInjectionPrompts` is. They are near-identical in depth math but differ in ordering knobs (`injection_order`) and in continue-handling.

        ---

        ## 1. Enums (exact numeric values)

        ### `extension_prompt_types` — `script.js:480-488`
        ```js
        /**
         * @enum {number} Extension prompt types
         */
        export const extension_prompt_types = {
            NONE: -1,
            IN_PROMPT: 0,
            IN_CHAT: 1,
            BEFORE_PROMPT: 2,
        };
        ```
        Semantics:
        - `NONE (-1)` — never emitted into the prompt by position matching. Still readable by `getExtensionPromptByName()` and macros (this is how WI "outlet" entries work, `script.js:4617` + `macros.js:598`). Also used by `setFloatingPrompt` to *disable* the A/N (`authors-note.js:352`).
        - `IN_PROMPT (0)` — "after story string" / after the character block. For chat completion this maps to prompt-collection position `'end'`.
        - `IN_CHAT (1)` — **the depth-injection position**. Requires a `depth`.
        - `BEFORE_PROMPT (2)` — before the story string. Chat completion → position `'start'`.

        Mapping to chat-completion relative positions — `openai.js:1136-1146`:
        ```js
        export function getPromptPosition(position) {
            if (position == extension_prompt_types.BEFORE_PROMPT) return 'start';
            if (position == extension_prompt_types.IN_PROMPT)    return 'end';
            return false;   // NONE and IN_CHAT
        }
        ```

        ### `extension_prompt_roles` — `script.js:490-497`
        ```js
        /**
         * @enum {number} Extension prompt roles
         */
        export const extension_prompt_roles = {
            SYSTEM: 0,
            USER: 1,
            ASSISTANT: 2,
        };
        ```
        Mapping to API roles — `openai.js:1153-1164`:
        ```js
        export function getPromptRole(role) {
            switch (role) {
                case extension_prompt_roles.SYSTEM:    return 'system';
                case extension_prompt_roles.USER:      return 'user';
                case extension_prompt_roles.ASSISTANT: return 'assistant';
                default:                               return 'system';
            }
        }
        ```
        Name→enum — `script.js:8882-8899` `getExtensionPromptRoleByName()`: accepts a number already in the enum and returns it; otherwise `'system'|'user'|'assistant'` → 0/1/2; anything else → `SYSTEM`.

        ### `MAX_INJECTION_DEPTH` — `script.js:499`
        ```js
        export const MAX_INJECTION_DEPTH = 10000;
        ```
        `getExtensionPromptMaxDepth()` (`script.js:3222`) just returns this constant (the smarter "compute the real max depth" version is commented out in the source). Both injectors therefore loop `for (let i = 0; i <= 10000; i++)` — 10001 iterations. **Do not copy this**; compute `max(depth)` over your actual injections.

        ### `INJECTION_POSITION` (prompt manager) — `PromptManager.js:37-40`
        ```js
        export const INJECTION_POSITION = { RELATIVE: 0, ABSOLUTE: 1 };
        ```
        `RELATIVE` = the prompt sits at its slot in `prompt_order`. `ABSOLUTE` = the prompt is an in-chat depth injection (uses `injection_depth`, `injection_order`, `role`). Defaults: `PromptManager.js:31-32` → `DEFAULT_DEPTH = 4`, `DEFAULT_ORDER = 100`.

        ### `persona_description_positions` — `personas.js:88-98`
        ```js
        export const persona_description_positions = {
            IN_PROMPT: 0,
            AFTER_CHAR: 1,   // @deprecated, use IN_PROMPT
            TOP_AN: 2,
            BOTTOM_AN: 3,
            AT_DEPTH: 4,
            NONE: 9,
        };
        ```

        ### `world_info_position` — `world-info.js:855-864`
        ```js
        export const world_info_position = {
            before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7,
        };
        ```

        ### `inject_ids` — `constants.js:48-56`
        ```js
        export const inject_ids = {
            STORY_STRING: '__STORY_STRING__',
            QUIET_PROMPT: 'QUIET_PROMPT',
            DEPTH_PROMPT: 'DEPTH_PROMPT',
            DEPTH_PROMPT_INDEX: (index) => `DEPTH_PROMPT_${index}`,
            CUSTOM_WI_DEPTH: 'customDepthWI',
            CUSTOM_WI_DEPTH_ROLE: (depth, role) => `customDepthWI_${depth}_${role}`,
            CUSTOM_WI_OUTLET: (key) => `customWIOutlet_${key}`,
        };
        ```

        ---

        ## 2. `setExtensionPrompt` — the registry

        `script.js:8856-8875`:
        ```js
        /**
         * Sets a prompt injection to insert custom text into any outgoing prompt. For use in UI extensions.
         * @param {string} key Prompt injection id.
         * @param {string} value Prompt injection value.
         * @param {number} position Insertion position. 0 is after story string, 1 is in-chat with custom depth.
         * @param {number} depth Insertion depth. 0 represets the last message in context. Expected values up to MAX_INJECTION_DEPTH.
         * @param {number} role Extension prompt role. Defaults to SYSTEM.
         * @param {boolean} scan Should the prompt be included in the world info scan.
         * @param {(function(): Promise<boolean>|boolean)} filter Filter function to determine if the prompt should be injected.
         */
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
        Note the **actual parameter order is `(key, value, position, depth, scan, role, filter)`** — the JSDoc lists `role` before `scan`, which is wrong. Callers pass `scan` 5th.

        The global store is `extension_prompts` — a plain object keyed by `key`. There is **one slot per key**; re-registering overwrites. Setting `value` to `''` is how you disable an injection (all the `flush*` helpers either `delete` the key or set an empty value).

        ### `getExtensionPrompt` — the query — `script.js:3232-3270`
        ```js
        export async function getExtensionPrompt(position = extension_prompt_types.IN_PROMPT, depth = undefined, separator = '\n', role = undefined, wrap = true) {
            const filterByFunction = async (prompt) => {
                const hasFilter = typeof prompt.filter === 'function';
                if (hasFilter && !await prompt.filter()) return false;
                return true;
            };
            const promptPromises = Object.keys(extension_prompts)
                .sort()                                                   // <-- ALPHABETICAL BY KEY
                .map((x) => extension_prompts[x])
                .filter(x => x.position == position && x.value)
                .filter(x => depth === undefined || x.depth === undefined || x.depth === depth)
                .filter(x => role === undefined || x.role === undefined || x.role === role)
                .filter(filterByFunction);
            const prompts = await Promise.all(promptPromises);

            let values = prompts.map(x => x.value.trim()).join(separator);
            if (wrap && values.length && !values.startsWith(separator)) values = separator + values;
            if (wrap && values.length && !values.endsWith(separator))   values = values + separator;
            if (values.length) values = substituteParams(values);
            return values;
        }
        ```
        Critical details for reimplementation:
        - **Ordering of multiple injections at the same (position, depth, role) is alphabetical by key.** This is why the built-in modules are named `1_memory`, `2_floating_prompt`, `3_vectors`, `4_vectors_data_bank` — the numeric prefix is a sort key. `authors-note.js:26` says so explicitly: `const MODULE_NAME = '2_floating_prompt'; // <= Deliberate, for sorting lower than memory`.
        - Merging is `values.join(separator)` after `.trim()` on each value. In depth injection, `separator = '\n'` and `wrap = false`.
        - `.filter(filterByFunction)` is buggy-by-design: `Array.prototype.filter` with an async predicate keeps everything (a Promise is truthy). The real filtering happens because `Promise.all` resolves each to `true`/`false`… actually no — the array being filtered is the *prompt objects*, and `filterByFunction` returns a Promise, so **the filter never removes anything**; `Promise.all(promptPromises)` then resolves an array of prompt objects (non-promises pass through). Net effect: **`filter` functions are effectively ignored inside `getExtensionPrompt`** (they ARE honored in `getExtensionPromptByName`, `getAllExtensionPrompts` and `preparePromptsForChatCompletion`). Don't replicate the bug; just apply the filter.
        - `substituteParams` (macro expansion) is applied to the *joined* string, once, at the end.

        ### `getExtensionPromptByName` — `script.js:3193-3216`
        ```js
        export async function getExtensionPromptByName(moduleName) {
            if (!moduleName) return '';
            const prompt = extension_prompts[moduleName];
            if (!prompt) return '';
            const hasFilter = typeof prompt.filter === 'function';
            if (hasFilter && !await prompt.filter()) return '';
            return substituteParams(prompt.value);
        }
        ```
        Only consumer: `world-info.js:4607-4614`, which feeds every injection with `scan: true` into the WI scan buffer *before* the scan runs:
        ```js
        for (const key of Object.keys(context.extensionPrompts)) {
            if (context.extensionPrompts[key]?.scan) {
                const prompt = await getExtensionPromptByName(key);
                if (prompt) buffer.addInject(prompt);
            }
        }
        ```

        ---

        ## 3. `Generate()` — order of operations (`script.js:4231` …)

        Signature (`script.js:4231`):
        ```js
        export async function Generate(type, { automatic_trigger, force_name2, quiet_prompt, quietToLoud, skipWIAN, force_chid, signal, quietImage, quietName, jsonSchema = null, depth = 0 } = {}, dryRun = false)
        ```
        (`depth` here is the *tool-calling recursion* depth, unrelated to injection depth.)

        Sequence, in source order:

        1. **User message committed** to `chat` (L4389-4399) unless `automatic_trigger` / `quiet` / `dryRun` / recursion.
        2. **Character card fields resolved** (L4401-4411) via `getCharacterCardFields()` → `{description, personality, persona, scenario, mesExamples, system, jailbreak, charDepthPrompt, creatorNotes}`. Sources (`script.js:3343-3435`): `persona` = `power_user.persona_description`; `system` = `chat_metadata.system_prompt || character.data.system_prompt` (only if `power_user.prefer_character_prompt`); `jailbreak` = `character.data.post_history_instructions` (only if `power_user.prefer_character_jailbreak`); `charDepthPrompt` = `character.data.extensions.depth_prompt.prompt`; `scenario` = `chat_metadata.scenario || character.scenario`; group chats override description/personality/scenario/mesExamples via `getGroupCharacterCardsLazy`.
        3. **Character depth prompt registered** (L4413-4427):
        ```js
        removeDepthPrompts();
        const groupDepthPrompts = getGroupDepthPrompts(selected_group, Number(this_chid));
        if (selected_group && Array.isArray(groupDepthPrompts) && groupDepthPrompts.length > 0) {
            groupDepthPrompts.forEach((value, index) => {
                const role = getExtensionPromptRoleByName(value.role);
                setExtensionPrompt(inject_ids.DEPTH_PROMPT_INDEX(index), value.text, extension_prompt_types.IN_CHAT, value.depth, extension_settings.note.allowWIScan, role);
            });
        } else {
            const depthPromptText = charDepthPrompt || '';
            const depthPromptDepth = characters[this_chid]?.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;   // 4
            const depthPromptRole = getExtensionPromptRoleByName(characters[this_chid]?.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default); // 'system'
            setExtensionPrompt(inject_ids.DEPTH_PROMPT, depthPromptText, extension_prompt_types.IN_CHAT, depthPromptDepth, extension_settings.note.allowWIScan, depthPromptRole);
        }
        ```
        `depth_prompt_depth_default = 4`, `depth_prompt_role_default = 'system'` (`script.js:549-550`).
        4. **`coreChat` built** (L4437-4498): `chat.filter(x => !x.is_system || (canUseTools && Array.isArray(x.extra?.tool_invocations)))`; `type === 'swipe'` pops the last. Then regex scripts (`getRegexedString` with `depth: coreChat.length - index - (isContinue ? 2 : 1)`), file attachments, media titles, and reasoning blocks are folded into `mes`.
        5. Token limit, interceptors, Horde adjust, CFG (L4500-4545).
        6. `mesExamplesArray = parseMesExamples(mesExamples, isInstruct)` (L4557).
        7. **`setFloatingPrompt()`** (L4560) — registers the Author's Note (see §5).
        8. **Quiet prompt made visible to WI** (L4564), **WI scan runs** (L4576), quiet prompt cleared (L4577):
        ```js
        setExtensionPrompt(inject_ids.QUIET_PROMPT, quiet_prompt || '', extension_prompt_types.IN_PROMPT, 0, true);
        const chatForWI = coreChat.map(x => world_info_include_names ? `${x.name}: ${x.mes}` : x.mes).reverse();
        const { worldInfoString, worldInfoBefore, worldInfoAfter, worldInfoExamples, worldInfoDepth, outletEntries } = await getWorldInfoPrompt(chatForWI, this_max_context, dryRun, globalScanData);
        setExtensionPrompt(inject_ids.QUIET_PROMPT, '', extension_prompt_types.IN_PROMPT, 0, true);
        ```
        9. **WI example-message entries** merged into `mesExamplesArray` (L4580-4596); `mesExamplesRawArray` snapshot taken.
        10. **WI `atDepth` entries registered as injections** (L4605-4622):
        ```js
        if (skipWIAN !== true) {
            flushWIInjections();
            if (Array.isArray(worldInfoDepth)) {
                worldInfoDepth.forEach((e) => {
                    const joinedEntries = e.entries.join('\n');
                    setExtensionPrompt(inject_ids.CUSTOM_WI_DEPTH_ROLE(e.depth, e.role), joinedEntries, extension_prompt_types.IN_CHAT, e.depth, false, e.role);
                });
            }
            if (outletEntries && ...) {
                Object.entries(outletEntries).forEach(([key, value]) => {
                    setExtensionPrompt(inject_ids.CUSTOM_WI_OUTLET(key), value.join('\n'), extension_prompt_types.NONE, 0);
                });
            }
        }
        ```
        One key per `(depth, role)` pair → `customDepthWI_<depth>_<role>`. `scan` is `false` here (WI cannot re-scan itself).
        11. **Persona description** (L4625) → `addPersonaDescriptionExtensionPrompt()` (see §5).
        12. **System prompt resolved for non-OAI** (L4628-4638).
        13. **Relative anchors collected** (L4641-4642):
        ```js
        const beforeScenarioAnchor = await getExtensionPrompt(extension_prompt_types.BEFORE_PROMPT);
        const afterScenarioAnchor  = await getExtensionPrompt(extension_prompt_types.IN_PROMPT);
        ```
        14. **Story string rendered** (L4644-4676) — text-completion only shape; see §6.
        15. **Depth injection for non-OAI** (L4683-4687) → `doChatInject(coreChat, isContinue)`.
        16. **Jailbreak / post-history instructions appended for non-OAI** (L4689-4706):
        ```js
        if (main_api !== 'openai' && power_user.sysprompt.enabled) {
            jailbreak = power_user.prefer_character_jailbreak && jailbreak
                ? substituteParams(jailbreak, { original: power_user.sysprompt.post_history ?? '' })
                : baseChatReplace(power_user.sysprompt.post_history);
            if (jailbreak) {
                if (isContinue) {
                    coreChat.splice(coreChat.length - 1, 0, { mes: jailbreak, is_user: true });
                } else {
                    coreChat.push({ mes: jailbreak, is_user: true });
                    injectedIndices.forEach(shiftUpByOne);
                }
            }
        }
        ```
        **Note: the PHI/jailbreak is appended AFTER depth injection**, so it ends up *below* a depth-0 injection in text-completion mode.
        17. `chat2` built (reverse of `coreChat`) L4713-4757; `oaiMessages = setOpenAIMessages(coreChat)` for OAI (L4775).
        18. Budget fitting, examples fitting, `mesSend` assembly (non-OAI) L4800-4952.
        19. **Dispatch** L5225-5256: for `openai`, `prepareOpenAIMessages({...})`.

        ---

        ## 4. DEPTH INJECTION MECHANICS

        ### 4.1 What "depth N" means

        Both injectors operate on a **newest-first** array, splice at index `N`, then reverse back. Net semantics:

        > **depth N = the injection is placed so that exactly N real chat messages follow it.**
        > depth 0 → after the very last message (closest to the model's reply).
        > depth 1 → immediately before the last message.
        > depth K ≥ chat length → at the very top of the chat history.

        Worked example, chat `[M1, M2, M3]` (M3 newest):
        - newest-first: `[M3, M2, M1]`
        - depth 0: splice(0,0,X) → `[X, M3, M2, M1]` → reverse → `[M1, M2, M3, X]`
        - depth 1: splice(1,0,X) → `[M3, X, M2, M1]` → reverse → `[M1, M2, X, M3]`
        - depth 2: → `[M1, X, M2, M3]`

        **Depth 0 is not "attached to the last message"** — it is a *separate message appended after the last one*. In chat completion this means an extra `{role, content}` element at the very end of `chatHistory` (before `controlPrompts`). In text completion it becomes an extra formatted history line after the last message.

        ### 4.2 Chat completion — `populationInjectionPrompts` (`openai.js:806-871`) — THE one to reimplement

        ```js
        async function populationInjectionPrompts(prompts, messages) {
            let totalInsertedMessages = 0;

            const roleTypes = {
                'system': extension_prompt_roles.SYSTEM,
                'user': extension_prompt_roles.USER,
                'assistant': extension_prompt_roles.ASSISTANT,
            };

            const maxDepth = getExtensionPromptMaxDepth();          // 10000
            for (let i = 0; i <= maxDepth; i++) {
                // Get prompts for current depth
                const depthPrompts = prompts.filter(prompt => prompt.injection_depth === i && prompt.content);

                const roleMessages = [];
                const separator = '\n';
                const wrap = false;

                // Group prompts by priority
                const extensionPromptsOrder = '100';
                const orderGroups = { [extensionPromptsOrder]: [] };
                for (const prompt of depthPrompts) {
                    const order = prompt.injection_order ?? 100;
                    if (!orderGroups[order]) orderGroups[order] = [];
                    orderGroups[order].push(prompt);
                }

                // Process each order group in order (b - a = low to high ; a - b = high to low)
                const orders = Object.keys(orderGroups).sort((a, b) => +b - +a);
                for (const order of orders) {
                    const orderPrompts = orderGroups[order];

                    // Order of priority for roles (most important go lower)
                    const roles = ['system', 'user', 'assistant'];
                    for (const role of roles) {
                        const rolePrompts = orderPrompts
                            .filter(prompt => prompt.role === role)
                            .map(x => x.content)
                            .join(separator);

                        // Get extension prompt
                        const extensionPrompt = order === extensionPromptsOrder
                            ? await getExtensionPrompt(extension_prompt_types.IN_CHAT, i, separator, roleTypes[role], wrap)
                            : '';
                        const jointPrompt = [rolePrompts, extensionPrompt].filter(x => x).map(x => x.trim()).join(separator);

                        if (jointPrompt && jointPrompt.length) {
                            roleMessages.push({ 'role': role, 'content': jointPrompt, injected: true });
                        }
                    }
                }

                if (roleMessages.length) {
                    const injectIdx = i + totalInsertedMessages;
                    messages.splice(injectIdx, 0, ...roleMessages);
                    totalInsertedMessages += roleMessages.length;
                }
            }

            messages = messages.reverse();
            return messages;
        }
        ```

        **Precise behavior:**

        1. `messages` arrives **newest-first**. That is guaranteed by `setOpenAIMessages` (`openai.js:566-645`), which walks `chat` forward but writes backwards:
           ```js
           for (let i = chat.length - 1; i >= 0; i--) {
               ...
               messages[i] = { role, content, name, media, mediaDisplay, mediaIndex, invocations, signature, reasoning };
               j++;
           }
           ```
           so `messages[0]` is the newest chat message.
        2. Two sources merge at each depth:
           - **Prompt-manager ABSOLUTE prompts** (`prompts` arg = `absolutePrompts`), matched by `prompt.injection_depth === i` and grouped by `prompt.injection_order` (default 100).
           - **`extension_prompts` registry** entries with `position === IN_CHAT && depth === i && role === <role>`, fetched via `getExtensionPrompt(IN_CHAT, i, '\n', roleEnum, false)`. These are **hard-pinned into the `'100'` order bucket**.
        3. **Order groups are sorted numerically descending** (`+b - +a`). Because the whole `roleMessages` array is spliced into a newest-first array and later reversed, **higher `injection_order` ends up LOWER in the final prompt (closer to the response)**.
        4. **Within an order group, roles are processed `['system', 'user', 'assistant']`**. Same reversal applies: the final chronological order of a depth's injections is **assistant, then user, then system** — i.e. the comment `// Order of priority for roles (most important go lower)` means *system ends up last / lowest*.
        5. **Merging within one (depth, order, role) cell:** prompt-manager contents joined by `'\n'`, then the extension-prompt string appended, `[rolePrompts, extensionPrompt].filter(x=>x).map(x=>x.trim()).join('\n')`. So **one message per (order, role) pair at a given depth** — never one per injection.
        6. `injectIdx = i + totalInsertedMessages`. Since depths are processed ascending, everything already inserted lives at array positions `< i + total`, so this correctly keeps depth semantics stable. (No `Math.min` clamp here — `splice` past the end just appends, which is the right behavior for depth ≥ chat length.)
        7. Every injected message is stamped `injected: true`. This is consumed by `populateChatHistory` for the continue-nudge logic: `const continueMessageIndex = messages.findLastIndex(x => !x.injected);` (`openai.js:911`).
        8. `messages.reverse()` at the end → chronological (oldest first). **`reverse()` mutates in place**, so the caller's `oaiMessages` array is also mutated.

        **Continue handling (chat completion)** — there is *no* `depth 0 → 1` remap. Instead, `populateChatCompletion` displaces the message being continued *before* injecting (`openai.js:1314-1327`):
        ```js
        // Displace the message to be continued from its original position before performing in-chat injections
        if (type === 'continue' && oai_settings.continue_prefill && messages.length) {
            const chatMessage = messages.shift();      // newest-first, so this is the message being continued
            ...
            controlPrompts.add(continueMessage);
            chatCompletion.reserveBudget(continueMessage);
        }
        // Add in-chat injections
        messages = await populationInjectionPrompts(absolutePrompts, messages);
        ```
        With `continue_prefill` on: the continued message is pulled out, injections happen against the remaining history, and the continued message is re-appended last via `controlPrompts` → **a depth-0 injection lands before the prefill**. With `continue_prefill` off, `populateChatHistory` splices out the last non-injected message and re-adds it plus `continueNudge` at the very end via `chatCompletion.add(continueMessageCollection, -1)`.

        ### 4.3 Text completion — `doChatInject` (`script.js:5563-5617`)

        ```js
        /**
         * Injects extension prompts into chat messages.
         * @param {object[]} messages Array of chat messages
         * @param {boolean} isContinue Whether the generation is a continuation. If true, the extension prompts of depth 0 are injected at position 1.
         * @returns {Promise<number[]>} Array of indices where the extension prompts were injected
         */
        async function doChatInject(messages, isContinue) {
            const injectedMessages = [];
            let totalInsertedMessages = 0;
            messages.reverse();                                   // chronological -> newest-first

            const maxDepth = getExtensionPromptMaxDepth();
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
                    const isUser = role === extension_prompt_roles.USER;
                    const name = names[role];

                    if (extensionPrompt) {
                        roleMessages.push({
                            name: name,
                            is_user: isUser,
                            mes: extensionPrompt,
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
        Differences vs. the OAI version:
        - No `injection_order` concept (prompt manager is OAI-only). Only the `extension_prompts` registry.
        - **`isContinue` remaps depth 0 → 1**, so injections don't land after the partial message being continued.
        - `Math.min(..., messages.length)` clamp.
        - Produces pseudo chat messages (`{name, is_user, mes, extra.type}`) that later go through `formatMessageHistoryItem`. `SYSTEM` role becomes a **narrator** message with an empty name; `USER` gets `name1`; `ASSISTANT` gets `name2`.
        - Returns `injectedIndices` **in the newest-first coordinate space** (computed before the final `reverse()`), which matches `chat2` indexing in `Generate()` (`chat2[0]` = newest). Those indices are used to *pre-allocate* injected messages into the context budget before ordinary history (`script.js:4819-4841`), i.e. **injections are never truncated by context pressure**; ordinary history is dropped first.

        ---

        ## 5. Every caller that registers a depth-capable injection

        | Key | Where | Position | Depth | Role | Scan |
        |---|---|---|---|---|---|
        | `2_floating_prompt` (Author's Note) | `authors-note.js:383-390` (`setFloatingPrompt`) | `chat_metadata.note_position` (default **1 = IN_CHAT**) | `chat_metadata.note_depth` (default **4**) | `chat_metadata.note_role` (default **0 = SYSTEM**) | `extension_settings.note.allowWIScan` |
        | `2_floating_prompt` (disable) | `authors-note.js:352` | `NONE` | `MAX_INJECTION_DEPTH` | — | — |
        | `2_floating_prompt` (WI ANTop/ANBottom hijack) | `world-info.js:5152` | same as AN | same | same | same |
        | `2_floating_prompt` (persona TOP_AN/BOTTOM_AN hijack) | `script.js:3160` | same as AN | same | same | same |
        | `PERSONA_DESCRIPTION` | `script.js:3164` | `IN_CHAT` | `power_user.persona_description_depth` (default **2**) | `power_user.persona_description_role` (default **0**) | `true` |
        | `PERSONA_DESCRIPTION` (clear) | `script.js:3146` | `IN_PROMPT` | 0 | — | — |
        | `DEPTH_PROMPT` (character card A/N) | `script.js:4426` | `IN_CHAT` | `character.data.extensions.depth_prompt.depth ?? 4` | `...depth_prompt.role ?? 'system'` | `extension_settings.note.allowWIScan` |
        | `DEPTH_PROMPT_<i>` (group members) | `script.js:4420` | `IN_CHAT` | per-member `value.depth` | per-member `value.role` | `allowWIScan` |
        | `customDepthWI_<depth>_<role>` (WI `atDepth`) | `script.js:4612` | `IN_CHAT` | WI entry `depth` (default 4) | WI entry `role` (default SYSTEM) | `false` |
        | `customWIOutlet_<key>` | `script.js:4617` | `NONE` | 0 | — | — |
        | `__STORY_STRING__` | `script.js:4671` | `IN_CHAT` (only when `main_api !== 'openai'` and `power_user.context.story_string_position === IN_CHAT`) | `power_user.context.story_string_depth ?? 1` | `power_user.context.story_string_role ?? SYSTEM` | `false` |
        | `QUIET_PROMPT` | `script.js:4564` / cleared 4577 | `IN_PROMPT` | 0 | SYSTEM | `true` |
        | `1_memory` (Summary) | `memory/index.js:965` | `extension_settings.memory.position` (default `IN_PROMPT`) | `.depth` (default **2**) | `.role` (default SYSTEM) | `.scan` |
        | `3_vectors` (Vector memory) | `vectors/index.js:854` | `settings.position` (default `IN_PROMPT`) | `settings.depth` (default **2**) | *(not passed — defaults SYSTEM)* | `settings.include_wi` |
        | `4_vectors_data_bank` | `vectors/index.js:696` | `settings.file_position_db` (default `IN_PROMPT`) | `settings.file_depth_db` (default **4**) | `settings.file_depth_role_db` (default SYSTEM) | `settings.include_wi` |
        | `script_inject_<id>` (`/inject`) | `slash-commands.js:3823`, rehydrated at `:3929` | `{before:2, after:0, chat:1, none:-1}`, default `after` | `args.depth ?? 4` | `{system:0,user:1,assistant:2}`, default SYSTEM | `args.scan` |

        ### Author's Note detail (`authors-note.js`)

        - `MODULE_NAME = '2_floating_prompt'` (L26) — the numeric prefix controls its alphabetical merge position relative to `1_memory`, `3_vectors`, `4_vectors_data_bank`.
        - `metadata_keys` (L30-36): `note_prompt`, `note_interval`, `note_depth`, `note_position`, `note_role`.
        - Defaults (`loadSettings`, L272-297): `DEFAULT_DEPTH = 4`, `DEFAULT_POSITION = 1` (IN_CHAT), `DEFAULT_INTERVAL = 1`, `DEFAULT_ROLE = extension_prompt_roles.SYSTEM`.
        - `chara_note_position` (L38-42): `replace: 0, before: 1, after: 2` — how the character-scoped A/N combines with the chat A/N.
        - Interval logic (`setFloatingPrompt`, L324-392):
          ```js
          let lastMessageNumber = context.chat.filter(m => m.is_user).length;   // USER messages only
          if (chat_metadata[metadata_keys.interval] === 1) lastMessageNumber = 1;   // interval 1 always inserts
          if (lastMessageNumber <= 0 || chat_metadata[metadata_keys.interval] <= 0) {
              context.setExtensionPrompt(MODULE_NAME, '', extension_prompt_types.NONE, MAX_INJECTION_DEPTH);
              shouldWIAddPrompt = false; return;
          }
          const messagesTillInsertion = lastMessageNumber >= interval ? (lastMessageNumber % interval) : (interval - lastMessageNumber);
          const shouldAddPrompt = messagesTillInsertion == 0;
          ```
        - `shouldWIAddPrompt` is exported and gates both the WI AN-anchor hijack (`world-info.js:5149`) and the persona TOP_AN/BOTTOM_AN hijack (`script.js:3154`).
        - Final registration:
          ```js
          context.setExtensionPrompt(
              MODULE_NAME,
              String(prompt),
              chat_metadata[metadata_keys.position],
              chat_metadata[metadata_keys.depth],
              extension_settings.note.allowWIScan,
              chat_metadata[metadata_keys.role],
          );
          ```
        - `/note-position` accepts `after|scenario` → 0, `chat` → 1, `before_scenario|before` → 2 (L83-89) — i.e. it writes raw `extension_prompt_types` values.

        ### WI `atDepth` grouping (`world-info.js:5116-5128`)
        ```js
        case world_info_position.atDepth: {
            const existingDepthIndex = WIDepthEntries.findIndex((e) => e.depth === (entry.depth ?? DEFAULT_DEPTH) && e.role === (entry.role ?? extension_prompt_roles.SYSTEM));
            if (existingDepthIndex !== -1) {
                WIDepthEntries[existingDepthIndex].entries.unshift(content);
            } else {
                WIDepthEntries.push({ depth: entry.depth, entries: [content], role: entry.role ?? extension_prompt_roles.SYSTEM });
            }
            break;
        }
        ```
        Entries are iterated `[...allActivatedEntries.values()].sort(sortFn)` and `unshift`ed, so within a `(depth, role)` bucket the final text is ordered from insertion-order 999 down to 1 (`// Appends from insertion order 999 to 1. Use unshift for this purpose`, L5082). Joined with `'\n'` in `Generate()` at L4611.

        ---

        ## 6. Full assembled order

        ### 6.A Chat completion (`main_api === 'openai'`) — the important one

        `prepareOpenAIMessages` (`openai.js:1538-1620`) → `preparePromptsForChatCompletion` → `populateChatCompletion`.

        **Step 1 — build the PromptCollection** (`preparePromptsForChatCompletion`, L1363-1512):

        `systemPrompts` seeded (L1370-1382):
        ```js
        const systemPrompts = [
            // Ordered prompts for which a marker should exist
            { role: 'system', content: formatWorldInfo(worldInfoBefore), identifier: 'worldInfoBefore' },
            { role: 'system', content: formatWorldInfo(worldInfoAfter),  identifier: 'worldInfoAfter' },
            { role: 'system', content: charDescription,                  identifier: 'charDescription' },
            { role: 'system', content: charPersonalityText,              identifier: 'charPersonality' },
            { role: 'system', content: scenarioText,                     identifier: 'scenario' },
            // Unordered prompts without marker
            { role: 'system', content: impersonationPrompt,              identifier: 'impersonate' },
            { role: 'system', content: quietPrompt,                      identifier: 'quietPrompt' },
            { role: 'system', content: groupNudge,                       identifier: 'groupNudge' },
            { role: 'assistant', content: bias,                          identifier: 'bias' },
        ];
        ```
        Then, from `extensionPrompts` (the `extension_prompts` registry, passed in from `Generate()` at L5233):
        - `1_memory` → `summary` (role/position mapped)
        - `2_floating_prompt` → `authorsNote`
        - `3_vectors` → `vectorsMemory`
        - `4_vectors_data_bank` → `vectorsDataBank`
        - `chromadb` → `smartContext`
        - `power_user.persona_description` when position is `IN_PROMPT` → `personaDescription`
        - **every other registry key** whose `position ∈ {BEFORE_PROMPT, IN_PROMPT}` and passes its `filter()` → a generated prompt `{identifier: key.replace(/\W/g,'_'), position: 'start'|'end', role, content, extension: true}` (L1445-1463). Excluded: `knownExtensionPrompts = ['1_memory','2_floating_prompt','3_vectors','4_vectors_data_bank','chromadb','PERSONA_DESCRIPTION','QUIET_PROMPT','DEPTH_PROMPT']`.

        **`IN_CHAT` registry entries are deliberately NOT turned into prompts here** — they are picked up later inside `populationInjectionPrompts` via `getExtensionPrompt(IN_CHAT, ...)`.

        The user's `prompt_order` is materialized by `promptManager.getPromptCollection(type)` (`PromptManager.js:1516-1541`), which honors `entry.enabled` and `shouldTrigger(prompt, generationType)` (`injection_trigger` array). `main` is always kept (content blanked) so relative injections have an anchor. System prompts are then merged in, with the prompt manager's `injection_position` / `injection_depth` / `injection_order` / `role` overriding (L1469-1489). Character card `system_prompt` / `post_history_instructions` override `main` / `jailbreak` unless `forbid_overrides` (L1491-1509).

        **Step 2 — `populateChatCompletion` (`openai.js:1181-1343`) — exact call sequence:**
        ```js
        chatCompletion.reserveBudget(3); // every reply is primed with <|start|>assistant<|message|>
        // Character and world information
        await addToChatCompletion('worldInfoBefore');
        await addToChatCompletion('main');
        await addToChatCompletion('worldInfoAfter');
        await addToChatCompletion('charDescription');
        await addToChatCompletion('charPersonality');
        await addToChatCompletion('scenario');
        await addToChatCompletion('personaDescription');
        ```
        then control prompts reserved (impersonate, quietPrompt), then:
        ```js
        const systemPrompts = ['nsfw', 'jailbreak'];
        const userRelativePrompts = prompts.collection
            .filter((prompt) => false === prompt.system_prompt && prompt.injection_position !== INJECTION_POSITION.ABSOLUTE)
            .reduce(...);                       // custom user prompts, in prompt_order
        const absolutePrompts = prompts.collection
            .filter((prompt) => prompt.injection_position === INJECTION_POSITION.ABSOLUTE)
            .reduce(...);                       // the depth-injected ones

        for (const identifier of [...systemPrompts, ...userRelativePrompts]) await addToChatCompletion(identifier);
        if (prompts.has('enhanceDefinitions')) await addToChatCompletion('enhanceDefinitions');
        if (bias && bias.trim().length) await addToChatCompletion('bias');
        ```
        then relative extension prompts are folded around `main` (L1261-1303) — `summary`, `authorsNote`, `vectorsMemory`, `vectorsDataBank`, `smartContext`, then any `p.extension && p.position`, each inserted into the `main` collection at `'start'` or `'end'`; if `main` is absent they are converted into ABSOLUTE prompts copying `main`'s depth/order/role.

        then tool-token reservation, continue-prefill displacement, and finally:
        ```js
        // Add in-chat injections
        messages = await populationInjectionPrompts(absolutePrompts, messages);

        if (power_user.pin_examples) {
            await populateDialogueExamples(prompts, chatCompletion, messageExamples);
            await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
        } else {
            await populateChatHistory(messages, prompts, chatCompletion, type, cyclePrompt);
            await populateDialogueExamples(prompts, chatCompletion, messageExamples);
        }

        chatCompletion.freeBudget(controlPrompts);
        if (controlPrompts.collection.length) chatCompletion.add(controlPrompts);
        ```
        **Crucial:** `chatCompletion.add(collection, index)` writes into a *sparse array at the prompt's index in `prompt_order`* (`openai.js:3931-3946`):
        ```js
        if (null !== position && -1 !== position) this.messages.collection[position] = collection;
        else this.messages.collection.push(collection);
        ```
        So the **order of the `await addToChatCompletion(...)` calls above is only the budget-consumption order, NOT the output order.** The output order is exactly `prompt_order`. The one exception is `controlPrompts`, which is `push`ed → always last.

        **Step 3 — the default emitted order** (from `default/content/presets/openai/Default.json`, `prompt_order` for `character_id: 100000`):

        1. `main` (system prompt) — plus, folded inside this collection at `'start'`/`'end'`: Summary, Author's Note (when position ≠ IN_CHAT), Vectors memory, Vectors data bank, Smart Context, and any other relative extension prompt
        2. `worldInfoBefore` (WI ↑Char), wrapped by `oai_settings.wi_format`
        3. `charDescription`
        4. `charPersonality` (through `oai_settings.personality_format`)
        5. `scenario` (through `oai_settings.scenario_format`)
        6. `enhanceDefinitions` (disabled by default)
        7. `nsfw`
        8. `worldInfoAfter` (WI ↓Char)
        9. `dialogueExamples` — `newChat` separator message + example blocks (unless `pin_examples`, which swaps 9 and 10's *budget* order but not their emitted order)
        10. `chatHistory`:
            - `newMainChat` (`new_chat_prompt` / `new_group_chat_prompt`) at the very start,
            - the chat messages **with depth injections already spliced in**,
            - `groupNudge` appended at the end (group chats, not on `impersonate`),
            - `continueNudge` collection appended at the very end for `type === 'continue'` without prefill
        11. `jailbreak` (= post-history instructions / PHI)
        12. `controlPrompts` (always last): `impersonate` prompt (if impersonating), then `continuePrefill` message, then `quietPrompt` — *"This should always be last, even in control prompts."*

        The `character_id: 100001` default order is the same but inserts `personaDescription` right after `worldInfoBefore`.

        Note: `personaDescription` only exists as a *prompt* when `power_user.persona_description_position === persona_description_positions.IN_PROMPT (0)`. `AT_DEPTH (4)` routes it through the `PERSONA_DESCRIPTION` registry key at `IN_CHAT` instead; `TOP_AN (2)` / `BOTTOM_AN (3)` prepend/append it to the Author's Note text.

        **Step 4 — flatten** (`ChatCompletion.getChat`, `openai.js:4053-4074`):
        ```js
        getChat() {
            const chat = [];
            for (let item of this.messages.collection) {
                if (item instanceof MessageCollection) {
                    chat.push(...item.getChat());
                } else if (item instanceof Message && (item.content || item.tool_calls)) {
                    const message = {
                        role: item.role,
                        content: item.content,
                        ...(item.name ? { name: item.name } : {}),
                        ...(item.tool_calls ? { tool_calls: item.tool_calls } : {}),
                        ...(item.role === 'tool' ? { tool_call_id: item.identifier } : {}),
                        ...(item.signature ? { signature: item.signature } : {}),
                        ...(item.reasoning ? { reasoning: item.reasoning } : {}),
                    };
                    chat.push(message);
                } else { this.log(`Skipping invalid or empty message in collection: ...`); }
            }
            return chat;
        }
        ```
        Empty-content messages are dropped. Then, if `oai_settings.squash_system_messages` and not a dry run, `squashSystemMessages()` (`openai.js:3855-3887`) merges **consecutive** `role === 'system'` messages that have no `name`, joining with `'\n'`, excluding identifiers `['newMainChat', 'newChat', 'groupNudge']`. This is what makes a depth-0 system injection visually merge with an adjacent system message — **if you don't implement squashing, your output will have more discrete system messages than SillyTavern's.**

        Finally `CHAT_COMPLETION_PROMPT_READY` is emitted with `{chat, dryRun}` (last chance for extensions to mutate the array), and `prepareOpenAIMessages` returns `[chat, tokenCounts]`.

        ### 6.B Text completion (for contrast)

        Story string template (`default/content/presets/context/Default.json`):
        ```
        {{#if anchorBefore}}{{anchorBefore}}\n{{/if}}{{#if system}}{{system}}\n{{/if}}{{#if wiBefore}}{{wiBefore}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{personality}}\n{{/if}}{{#if scenario}}{{scenario}}\n{{/if}}{{#if wiAfter}}{{wiAfter}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}{{#if anchorAfter}}{{anchorAfter}}\n{{/if}}{{trim}}
        ```
        i.e. **BEFORE_PROMPT injections → system prompt → WI before → description → personality → scenario → WI after → persona → IN_PROMPT injections**. `anchorBefore`/`anchorAfter` are exactly `getExtensionPrompt(BEFORE_PROMPT)` / `getExtensionPrompt(IN_PROMPT)` (`script.js:4641-4642`).

        Final flattening (`getCombinedPrompt` → `combine()`, `script.js:5123-5145`):
        ```js
        mesSendString = finalMesSend.map((e) => `${e.extensionPrompts.join('')}${e.message}`).join('');
        mesSendString = addChatsSeparator(mesSendString);   // chat_start / "***"
        mesSendString = addChatsPreamble(mesSendString);
        let combinedPrompt = [combinedStoryString, mesExmString, mesSendString, generatedPromptCache].join('').replace(/\r/gm, '');
        ```
        So: **story string → example messages → (chat separator) → chat history with depth injections and PHI already spliced in → continuation cache**.

        ---

        ## 7. Reimplementing depth-0 correctly — minimal checklist

        1. Keep a registry `Map<key, {value, position, depth, scan, role, filter}>`.
        2. To build the message array:
           a. Produce the chat history **chronologically**, then reverse to newest-first (or index from the end directly).
           b. For `d = 0 .. maxDepth` (maxDepth = max registered depth, not 10000):
              - group candidate injections by `injection_order` (default 100), sort orders **descending**;
              - for each order, for each role in **`[system, user, assistant]`**:
                - collect all injections at `(position=IN_CHAT, depth=d, role)`, **sorted alphabetically by key**, `.trim()` each, join with `'\n'`;
                - if non-empty, emit one message `{role, content}`.
              - splice the emitted messages, in that emitted order, at index `d + totalInsertedSoFar`.
           c. Reverse back to chronological.
           The net observable ordering at a single depth, reading top-to-bottom in the final array, is: **lowest order-group first, and within each group assistant → user → system**, with system sitting immediately above the following real message (or, at depth 0, at the very bottom).
        3. `depth 0` = *appended after the last chat message*, as its own message. Not concatenated onto it.
        4. If continuing an assistant message: either remap depth 0 → 1 (text-completion behavior) or displace the continued message before injecting and re-append it after (chat-completion behavior). Pick one and be consistent.
        5. Apply macro substitution to the **joined** string of a cell, once.
        6. Depth injections must be budgeted *before* ordinary history — SillyTavern pre-allocates them (`script.js:4819-4841`) so they survive context truncation.
        7. If you emulate ST's system-message squashing, exclude the chat-start/example-start/group-nudge markers.


## Reusable
        ## Copy nearly verbatim

        - **The two enums.** `extension_prompt_types {NONE:-1, IN_PROMPT:0, IN_CHAT:1, BEFORE_PROMPT:2}` and `extension_prompt_roles {SYSTEM:0, USER:1, ASSISTANT:2}` — port as TS `const enum`s. Persisted character cards, WI entries and presets store these raw numbers, so if you ever want to import ST assets the values must match exactly. Same for `world_info_position` (atDepth = 4), `persona_description_positions`, and `INJECTION_POSITION {RELATIVE:0, ABSOLUTE:1}`.
        - **The depth-splice algorithm** from `populationInjectionPrompts` — the `injectIdx = i + totalInsertedMessages` on a newest-first array, then reverse. It is ~25 lines and it is the whole feature. Reimplement it as a pure function `injectAtDepths(messages: Msg[], injections: Injection[]): Msg[]` with no I/O, and unit-test depth 0/1/N-overflow.
        - **The merge rule**: one output message per `(depth, order, role)` cell, contents `.trim()`ed and joined with `'\n'`. This is what users' muscle memory expects.
        - **The role priority `[system, user, assistant]`** and **order-group descending sort**, including the resulting "system ends up lowest" behavior.
        - **The registry shape** `{value, position, depth, scan, role, filter}` keyed by string id, with "set empty string to disable". Maps cleanly onto a Pinia store (`useInjectionsStore` with a `Record<string, Injection>`), and onto an IndexedDB table keyed by `id` for the persistent ones (`/inject`-equivalents, Author's Note per-chat metadata).
        - **Author's Note interval math** (`setFloatingPrompt`) — counts **user** messages only, `interval === 1` always fires, `messagesTillInsertion` formula. Small and behaviorally load-bearing.
        - **Defaults**: A/N depth 4 / position IN_CHAT / role SYSTEM / interval 1; character depth_prompt depth 4 role system; persona AT_DEPTH depth 2; `/inject` default depth 4 position `after`; prompt-manager `DEFAULT_DEPTH = 4`, `DEFAULT_ORDER = 100`.
        - **Pre-allocating injections into the token budget before ordinary history** — otherwise a long chat silently drops the user's depth-0 instruction, which is the worst possible failure mode.
        - **`squashSystemMessages`** if you target Anthropic/OpenAI and want ST-comparable output; it's 25 lines and materially changes the request shape.

        ## Adapt / simplify

        - **`getExtensionPrompt`'s alphabetical-key sort** is an accident of history (`1_memory`, `2_floating_prompt`, `3_vectors`, `4_vectors_data_bank`). Replace it with an explicit numeric `order` field on every injection and sort on that; keep the *descending* order semantics so higher order = closer to the response. You still need a deterministic tiebreak — use insertion sequence or id.
        - **`MAX_INJECTION_DEPTH = 10000` with a 10001-iteration loop containing an `await` per role per iteration.** In a Vue app this would be ~30k awaited microtasks per keystroke-triggered dry run. Compute `maxDepth = Math.max(...injections.map(i => i.depth), 0)` and iterate only over depths that actually have injections (or better: bucket injections into a `Map<depth, Injection[]>` and iterate the map's sorted keys).
        - **The async-`filter` bug** in `getExtensionPrompt` (a Promise predicate always passes) — do not port. Resolve filters first, then filter synchronously.
        - **`Message` / `MessageCollection` / `ChatCompletion` with the sparse-array-indexed-by-prompt_order trick.** The idea (top-level order = user's configured `prompt_order`, budget consumption order ≠ emission order) is worth keeping, but implement it as an ordered array of named sections `{id, messages: Msg[]}` built by mapping over `promptOrder`, plus a reactive Pinia getter that flattens. Skip `reserveBudget`/`freeBudget`/`canAfford` unless you need exact token-budget parity — a simpler "fill history newest-first until budget" loop covers 95% of behavior.
        - **The `Prompt` / `PromptCollection` / `PromptManager` triple** is ~2000 lines of jQuery DOM plumbing fused with data. Extract only the data model: `{identifier, role, content, system_prompt, injection_position, injection_depth, injection_order, injection_trigger, forbid_overrides, enabled}` plus `prompt_order: {character_id, order: [{identifier, enabled}]}`. Render the UI with Vue components; store `prompt_order` per character in IndexedDB.
        - **`injection_trigger`** (`shouldTrigger`, gen-type gating: normal/continue/impersonate/swipe/regenerate/quiet) is cheap and genuinely useful — port the concept, drop the UI.
        - **`filter` closures** in ST are stringified slash-command closures rehydrated by a parser. Replace with a plain predicate id or a small expression, or drop entirely for v1.

        ## Do NOT bother porting

        - **`doChatInject` and the entire text-completion branch of `Generate()`** (`chat2`, `mesSend`, `mesExmString`, `modifyLastPromptLine`, `formatInstructModeChat`, `force_output_sequence`, the `FORMAT_TOKEN = ' ￼ �'` continue hack, `addChatsPreamble`/`addChatsSeparator`) — unless you're targeting KoboldCPP/TextGen/NovelAI. For a chat-completion-only app it's dead weight. Read `doChatInject` only to confirm the depth math matches `populationInjectionPrompts` (it does, modulo `isContinue` depth 0→1 and the `Math.min` clamp).
        - **The story-string Handlebars template + `renderStoryString`** — chat completion never uses it (`applyStoryStringInject` is explicitly `main_api !== 'openai'`). Its field order is still a useful reference for what a "sane" character block looks like.
        - **`__STORY_STRING__` in-chat injection**, CFG guidance-scale depth splicing, Horde param adjustment, `itemized-prompts.js`, `PromptReasoning`, tool-call reasoning modes (`ACTIVE_CHAIN` / `SINCE_LAST_USER`) — all orthogonal to depth injection.
        - **`chromadb` / Smart Context**, `AFTER_CHAR (1)` persona position (marked `@deprecated`), and the WI `outlet` position (position `NONE` consumed only through a `{{...}}` macro) — legacy surface area.
        - **The `extension_prompts` global mutable object + `flushWIInjections()` / `removeDepthPrompts()` prefix-scan deletes.** In Pinia, model transient (per-generation) injections as a value computed fresh each build, and only persist the genuinely user-owned ones (A/N text, `/inject` equivalents, character depth prompt). That eliminates the entire class of "stale injection leaked into the next generation" bugs that the `flush*` helpers exist to paper over.
