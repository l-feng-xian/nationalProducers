# SillyTavern multi-character (group / 1-vs-N) chat: data model, activation strategies, turn-taking, card injection modes, group nudge, greetings, muting, and world info

## Key files
- D:/tauriApp/SillyTavern/public/scripts/group-chats.js — The entire group-chat subsystem (2490 lines): group CRUD, enums, turn-taking/activation algorithms, generateGroupWrapper orchestration loop, joined character-card assembly, group depth prompts, group chat file load/save, auto-mode worker, and all group UI wiring.
- D:/tauriApp/SillyTavern/public/script.js — Generate() pipeline. Delegates to generateGroupWrapper when selected_group is set; getCharacterCardFieldsLazy() consults getGroupCharacterCardsLazy(); depth-prompt injection for groups (~L4415); group stopping strings (~L2986); cleanGroupMessage() (L3112); saveReply stamps force_avatar/original_avatar/gen_id (~L6708); {{group}}/{{groupNotMuted}}/{{notChar}} macro resolvers (~L2819-2894); talkativeness_default = 0.5 (L548).
- D:/tauriApp/SillyTavern/public/scripts/openai.js — Chat Completion prompt assembly. default_group_nudge_prompt = '[Write the next reply only as {{char}}.]' (L114), default_new_group_chat_prompt = '[Start a new group chat. Group members: {{group}}]' (L108), groupNudge insertion at end of chatHistory (L893-899, L1077-1081), character_names_behavior enum (L205).
- D:/tauriApp/SillyTavern/src/endpoints/groups.js — Server: /api/groups/all|create|edit|delete. Defines the canonical default group object and its defaults; also migrateGroupChatsMetadataFormat() which strips the now-deprecated chat_metadata / past_metadata keys off group JSON and moves them into per-chat-file headers.
- D:/tauriApp/SillyTavern/public/global.d.ts — The `Group` TypeScript interface (L26-43) plus ChatHeader / ChatMetadata / ChatMessage interfaces used by group chat files.
- D:/tauriApp/SillyTavern/public/scripts/world-info.js — getCharacterLore() (L4363) and getSortedEntries() (L4478). Notably contains ZERO group awareness: only characters[this_chid]'s lorebook is loaded, i.e. the currently drafted speaker's.
- D:/tauriApp/SillyTavern/public/index.html — Group edit panel markup: #rm_group_activation_strategy option values 2/0/1/3, #rm_group_generation_mode option values 0/1/2, join prefix/suffix textareas + their <FIELDNAME> help text (L6254-6318), #group_member_template with data-action buttons (L7545-7569), group_nudge_prompt_textarea (L908).
- D:/tauriApp/SillyTavern/public/scripts/slash-commands.js — /member-disable, /member-enable, /member-up, /member-down, /member-peek, /member-count, /member-remove, /memberadd, and /trigger (force_chid) implementations (L4805-5020).
- D:/tauriApp/SillyTavern/public/scripts/extensions/expressions/index.js — The ONLY consumer of hideMutedSprites: visualNovelSetCharacterSprites() skips disabled members' sprites when the flag is on (L188-200).
- D:/tauriApp/SillyTavern/public/scripts/bookmarks.js — convertSoloToGroupChat(): builds a full Group create model from a solo chat (L344-437) — a good reference for every required field with explicit defaults.

## Report
# SillyTavern 1.18.0 — Multi-Character (Group) Chat, Exhaustive Spec

Repo checked out at `D:/tauriApp/SillyTavern` (`git log`: `1f809ff3c Initial commit: SillyTavern 1.18.0 …`). All line numbers below are from that tree.

---

## 1. The Group Data Model

### 1.1 TypeScript interface (`public/global.d.ts:26-43`)

```ts
interface Group {
    id: string;
    name: string;
    members: string[];
    disabled_members: string[];
    chat_id: string;
    chats: string[];
    generation_mode?: number;
    generation_mode_join_prefix?: string;
    generation_mode_join_suffix?: string;
    activation_strategy?: number;
    auto_mode_delay?: number;
    allow_self_responses?: boolean;
    avatar_url?: string;
    hideMutedSprites?: boolean;
    fav?: boolean;
    date_last_chat?: MessageTimestamp;
}
```

### 1.2 Server-side creation defaults (`src/endpoints/groups.js:156-188`)

```js
const id = String(Date.now());
const groupMetadata = {
    id: id,
    name: request.body.name ?? 'New Group',
    members: request.body.members ?? [],
    avatar_url: request.body.avatar_url,
    allow_self_responses: !!request.body.allow_self_responses,
    activation_strategy: request.body.activation_strategy ?? 0,
    generation_mode: request.body.generation_mode ?? 0,
    disabled_members: request.body.disabled_members ?? [],
    fav: request.body.fav,
    chat_id: request.body.chat_id ?? id,
    chats: request.body.chats ?? [id],
    auto_mode_delay: request.body.auto_mode_delay ?? 5,
    generation_mode_join_prefix: request.body.generation_mode_join_prefix ?? '',
    generation_mode_join_suffix: request.body.generation_mode_join_suffix ?? '',
};
```
Stored as `<user>/groups/<id>.json`, pretty-printed with 4-space indent. `/api/groups/edit` blindly overwrites the whole file with the POSTed body (no merge). `/api/groups/delete` also unlinks every `groupChats/<chatId>.jsonl`.

### 1.3 Field-by-field semantics

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | `String(Date.now())` at creation. Legacy numeric ids are coerced to string on load (`group-chats.js:770-791`). Also the tag-map key (`delete tag_map[id]` on delete). |
| `name` | `string` | Display name. If the user leaves it blank at creation, it becomes `` t`Group: ${memberNames}` `` where memberNames is the comma-joined character names (`group-chats.js:2093-2097`). |
| `members` | `string[]` | **Ordered** list of character *avatar filenames* (e.g. `Seraphina.png`), NOT names. Order is the "list order" used for turn-taking and for the collage avatar. `modifyGroupMember` **unshifts** new members to the front (`:1434`). `reorderGroupMember` swaps adjacent entries (`:1461-1489`). Very old groups stored names instead; `getGroups()` migrates name→avatar when `chat_id === undefined` (`:777-784`). `validateGroup()` drops members whose character no longer exists and toasts a warning (`:218-247`). |
| `disabled_members` | `string[]` | Subset of `members` (avatar ids) that are **muted**. Defaulted to `[]` on load if absent (`:774-776`). |
| `avatar_url` | `string` | Either a data URL, or a path starting with `user`/`/user` (see `isValidImageUrl`, `:858-864`). If invalid/empty, `getGroupAvatar()` builds a **collage of up to 4 member thumbnails** by cloning `#group_avatars_template .collage_N` (`:871-917`). 0 valid avatars → `.missing-avatar fa-solid fa-user-slash`. Uploading goes through a crop popup → 200×300 thumbnail → `saveBase64AsFile` (`:1896-1934`). |
| `allow_self_responses` | `boolean` | Only consulted by the NATURAL strategy. When false, the character who spoke the last message is banned from the next batch. |
| `activation_strategy` | `number` | See §2. |
| `generation_mode` | `number` | See §2. |
| `generation_mode_join_prefix` | `string` | Only used in APPEND modes. Prepended to each member's field value. Supports macros + `{{char}}` (the member's name) + literal `<FIELDNAME>` token. |
| `generation_mode_join_suffix` | `string` | Same, appended. |
| `auto_mode_delay` | `number` | Seconds between auto-mode ticks. `DEFAULT_AUTO_MODE_DELAY = 5` (`group-chats.js:135`). UI range 1..999. |
| `fav` | `boolean` | Favorite flag; adds `is_fav` class to the list block, drives `favsToHotswap()`. |
| `chat_id` | `string` | The **currently open** chat file id (a `humanizedDateTime()` string), file at `groupChats/<chat_id>.jsonl`. |
| `chats` | `string[]` | All chat file ids belonging to this group. Deduped with `onlyUnique` in `validateGroup`. |
| `hideMutedSprites` | `boolean` | **Note the camelCase** — the client property is `hideMutedSprites`, not `hide_muted_sprites`. Server `/create` doesn't even list it, but `/edit` persists it because it saves the whole body. Only consumed by the expressions extension (§7.3). |
| `date_last_chat` / `chat_size` / `date_added` / `create_date` | computed | Injected by `/api/groups/all` from filesystem stats; not persisted meaningfully. `saveGroupChat` also sets `group.date_last_chat = Date.now()` client-side. |

### 1.4 `chat_metadata` / `past_metadata` — **DEPRECATED and REMOVED from the group object in 1.18.0**

Historically the group JSON carried `chat_metadata` (the active chat's metadata) and `past_metadata` (a `{chatId: metadata}` map). In 1.18.0 they are migrated out and actively stripped:

```js
// src/endpoints/groups.js:18-28
function warnOnGroupMetadata(groupData) {
    ['chat_metadata', 'past_metadata'].forEach(key => {
        if (Object.hasOwn(groupData, key)) {
            console.warn(color.yellow(`Group JSON data for "${groupData.id}" contains deprecated key "${key}".`));
            delete groupData[key];
        }
    });
}
```

`migrateGroupChatsMetadataFormat()` (`groups.js:34-111`) backs the files up to `backups/_group_metadata_update/`, then for each chat id writes a **header line** as the first JSONL record:

```js
const allMetadata = { ...(groupData.past_metadata || {}), [groupData.chat_id]: (groupData.chat_metadata || {}) };
…
const chatHeader = { chat_metadata: chatMetadata, user_name: 'unused', character_name: 'unused' };
const newChatData = [chatHeader, ...chatData];
```

So the current format is: **group chat file = `[ChatHeader, ...ChatMessage[]]`**, one JSON object per line, and per-chat metadata lives in `line[0].chat_metadata`. Client side, `getGroupChat()` reads `data?.[0]?.chat_metadata ?? {}`, `data.shift()`s the header off, and calls `updateChatMetadata(metadata, true)` (`group-chats.js:255-320`). `saveGroupChat()` re-emits `[chatHeader, ...chat]` (`:623-675`). Metadata keys that matter for groups: `tainted` (has anything been generated), `integrity` (a `uuidv4()` slug used for a save-collision check — mismatch pops an "enter OVERWRITE" confirmation and otherwise reloads the page), `scenario` and `mes_example` (per-chat overrides set via the `#rm_group_scenario` button → `setCharacterSettingsOverrides`), and the chat lorebook key.

---

## 2. The Two Enums (numeric values)

```js
// public/scripts/group-chats.js:122-135
export const group_activation_strategy = {
    NATURAL: 0,
    LIST: 1,
    MANUAL: 2,
    POOLED: 3,
};

export const group_generation_mode = {
    SWAP: 0,
    APPEND: 1,
    APPEND_DISABLED: 2,
};

export const DEFAULT_AUTO_MODE_DELAY = 5;
```

UI labels (`index.html:6259-6274`) — note the `<option>` order is *not* numeric order:

**Group reply strategy** (`#rm_group_activation_strategy`)
- `2` → "Manual"
- `0` → "Natural order"
- `1` → "List order"
- `3` → "Pooled order"

**Group generation handling mode** (`#rm_group_generation_mode`)
- `0` → "Swap character cards"
- `1` → "Join character cards (exclude muted)"
- `2` → "Join character cards (include muted)"

Semantics:
- **NATURAL (0)** — mention-detection + per-character talkativeness dice roll; can activate **several** members in one batch, each replying in turn.
- **LIST (1)** — every enabled member replies once, in `members[]` array order. Deduped only.
- **MANUAL (2)** — a user message produces **no** replies at all; you must click the per-member "speak" button (`data-action="speak"` → `Generate('normal', {force_chid})`) or use `/trigger <member>`. Non-user-initiated generation (auto mode, continue-ish paths) picks **1 random** enabled member.
- **POOLED (3)** — round-robin-ish: prefers a random member among those who have *not* spoken since the last user message; when everyone has spoken, picks a random member excluding the last speaker.

- **SWAP (0)** — only the current speaker's card fields are used. Implemented by `getGroupCharacterCardsLazy()` returning `null` (because `!group?.generation_mode` is true for `0`), which makes `getCharacterCardFieldsLazy()` fall through to the plain single-character path.
- **APPEND (1)** — all *non-muted* members' `description`/`personality`/`scenario`/`mes_example` are concatenated.
- **APPEND_DISABLED (2)** — same but muted members are included too.

---

## 3. Turn-taking / Speaker Selection

### 3.1 The orchestrator: `generateGroupWrapper` (`group-chats.js:945-1092`)

Guard rails first: bail if `online_status === 'no_connection'`; bail if `is_group_generating` (re-entrancy lock); force the right-hand menu to `group_edit`; emit `EMPTY` system message if the group has no members.

```js
await unshallowGroupMembers(selected_group);   // load full card data for every member
throwIfAborted();
hideSwipeButtons();
is_group_generating = true;
setCharacterName('');
setCharacterId(undefined);
const userInput = String($('#send_textarea').val());

// id of this specific batch for regeneration purposes
group_generation_id = Date.now();
const lastMessage = chat[chat.length - 1];
let activationText = '';
let isUserInput = false;

if (userInput?.length && !byAutoMode) {
    isUserInput = true;
    activationText = userInput;
} else {
    if (lastMessage && !lastMessage.is_system) {
        activationText = lastMessage.mes;
    }
}

const activationStrategy = Number(group.activation_strategy ?? group_activation_strategy.NATURAL);
const enabledMembers = group.members.filter(x => !group.disabled_members.includes(x));
let activatedMembers = [];

if (params && typeof params.force_chid == 'number') {
    activatedMembers = [params.force_chid];
} else if (type === 'quiet') {
    activatedMembers = activateSwipe(group.members, { allowSystem: true }).slice(0, 1);
    if (activatedMembers.length === 0) {
        activatedMembers = activateListOrder(group.members.slice(0, 1));
    }
} else if (type === 'swipe' || type === 'continue') {
    activatedMembers = activateSwipe(group.members, { allowSystem: false });
    if (activatedMembers.length === 0) {
        toastr.warning(t`Deleted group member swiped. To get a reply, add them back to the group.`);
        throw new Error('Deleted group member swiped');
    }
} else if (type === 'impersonate') {
    activatedMembers = activateImpersonate(group.members);
} else if (activationStrategy === group_activation_strategy.NATURAL) {
    activatedMembers = activateNaturalOrder(enabledMembers, activationText, lastMessage, group.allow_self_responses, isUserInput);
} else if (activationStrategy === group_activation_strategy.LIST) {
    activatedMembers = activateListOrder(enabledMembers);
} else if (activationStrategy === group_activation_strategy.POOLED) {
    activatedMembers = activatePooledOrder(enabledMembers, lastMessage, isUserInput);
} else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
    activatedMembers = shuffle(enabledMembers).slice(0, 1).map(x => characters.findIndex(y => y.avatar === x)).filter(x => x !== -1);
}

if (activatedMembers.length === 0) {
    // Send user message as is
    const bias = getBiasStrings(userInput, type);
    await sendMessageAsUser(userInput, bias.messageBias);
    await saveChatConditional();
    $('#send_textarea').val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
}
```

Key facts:
- Precedence is **`force_chid` > special generation types (`quiet`/`swipe`/`continue`/`impersonate`) > activation strategy**. The strategy is only consulted for a normal reply.
- `activatedMembers` is an array of **character indices into the global `characters[]` array**, not avatars.
- Special types operate on `group.members` (ALL members, including muted!) — muting only filters the strategy path.
- Zero activations → the user's typed text is committed as a plain user message with no reply (this is the MANUAL-strategy path).

Then the actual serial loop:

```js
groupChatQueueOrder = new Map();
if (power_user.show_group_chat_queue) {
    for (let i = 0; i < activatedMembers.length; ++i) {
        groupChatQueueOrder.set(characters[activatedMembers[i]].avatar, i + 1);
    }
}
await eventSource.emit(event_types.GROUP_WRAPPER_STARTED, { selected_group, type });
// now the real generation begins: cycle through every activated character
for (const chId of activatedMembers) {
    throwIfAborted();
    deactivateSendButtons();
    setCharacterId(chId);
    setCharacterName(characters[chId].name);
    if (power_user.show_group_chat_queue) { printGroupMembers(); }
    await eventSource.emit(event_types.GROUP_MEMBER_DRAFTED, chId);

    // Wait for generation to finish
    const generateType = ['swipe', 'impersonate', 'quiet', 'continue'].includes(type) ? type : 'normal';
    textResult = await Generate(generateType, { automatic_trigger: byAutoMode, ...(params || {}) });
    let messageChunk = textResult?.messageChunk;

    if (messageChunk) {
        while (shouldAutoContinue(messageChunk, type === 'impersonate')) {
            textResult = await Generate('continue', { automatic_trigger: byAutoMode, ...(params || {}) });
            messageChunk = textResult?.messageChunk;
        }
    }
    if (power_user.show_group_chat_queue) {
        groupChatQueueOrder.delete(characters[chId].avatar);
        groupChatQueueOrder.forEach((value, key, map) => map.set(key, value - 1));
    }
}
```

**This is the entire "who is speaking" mechanism**: before each `Generate()` call, the module sets the *global* `this_chid` and `name2` to the drafted member. Everything downstream (`{{char}}`, card fields, world info, avatars, stopping strings) reads those globals. `finally` resets `is_group_generating=false`, `this_chid=undefined`, `name2=''`, re-enables buttons, shows swipes, emits `GROUP_WRAPPER_FINISHED`.

Reply stamping happens in `script.js` `saveReply` (~L6708-6717):
```js
if (selected_group) {
    let avatarImg = 'img/ai4.png';
    if (characters[this_chid].avatar != 'none') { avatarImg = getThumbnailUrl('avatar', characters[this_chid].avatar); }
    newMessage.force_avatar = avatarImg;
    newMessage.original_avatar = characters[this_chid].avatar;
    newMessage.extra.gen_id = group_generation_id;
}
```
`original_avatar` is the authoritative "who said this" key used by swipe/pooled logic; `extra.gen_id` groups a whole batch for regeneration.

### 3.2 NATURAL order — the talkativeness algorithm (`:1242-1316`)

```js
function activateNaturalOrder(members, input, lastMessage, allowSelfResponses, isUserInput) {
    let activatedMembers = [];

    // prevents the same character from speaking twice
    let bannedUser = !isUserInput && lastMessage && !lastMessage.is_user && lastMessage.name;

    // ...unless allowed to do so
    if (allowSelfResponses) { bannedUser = undefined; }

    // find mentions (excluding self)
    if (input && input.length) {
        for (let inputWord of extractAllWords(input)) {
            for (let member of members) {
                const character = characters.find(x => x.avatar === member);
                if (!character || character.name === bannedUser) { continue; }
                if (extractAllWords(character.name).includes(inputWord)) {
                    activatedMembers.push(member);
                    break;
                }
            }
        }
    }

    const chattyMembers = [];
    // activation by talkativeness (in shuffled order, except banned)
    const shuffledMembers = shuffle([...members]);
    for (let member of shuffledMembers) {
        const character = characters.find((x) => x.avatar === member);
        if (!character || character.name === bannedUser) { continue; }

        const rollValue = Math.random();
        const talkativeness = isNaN(character.talkativeness) ? talkativeness_default : Number(character.talkativeness);
        if (talkativeness >= rollValue) { activatedMembers.push(member); }
        if (talkativeness > 0) { chattyMembers.push(member); }
    }

    // pick 1 at random if no one was activated
    let retries = 0;
    // try to limit the selected random character to those with talkativeness > 0
    const randomPool = chattyMembers.length > 0 ? chattyMembers : members;
    while (activatedMembers.length === 0 && ++retries <= randomPool.length) {
        const randomIndex = Math.floor(Math.random() * randomPool.length);
        const character = characters.find((x) => x.avatar === randomPool[randomIndex]);
        if (!character) { continue; }
        activatedMembers.push(randomPool[randomIndex]);
    }

    // de-duplicate array of character avatars
    activatedMembers = activatedMembers.filter(onlyUnique);

    // map to character ids
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}
```

Details worth porting exactly:
- **`talkativeness`** is a per-character card field, a float `0..1`, default `talkativeness_default = 0.5` (`script.js:548`); UI slider `min=0 max=1 step=0.05` (`index.html:6644`). It's a **per-turn independent Bernoulli probability**: activate iff `talkativeness >= Math.random()`. `talkativeness = 1` always speaks; `0` never speaks by roll but is still eligible for the last-resort random pick only if *no one* has talkativeness > 0.
- **Mention detection** takes priority and is additive: if the input text contains any word of a member's name (`extractAllWords` — lowercased word tokenization), that member is activated regardless of talkativeness. The `break` after a match means one input word activates at most one member, but multiple words can activate multiple members.
- **Self-response ban**: `bannedUser` is a **name** (`lastMessage.name`), compared against `character.name`. It only applies when `!isUserInput` (i.e. auto-mode / continued chains), so when the user types something, the last speaker is *not* banned. `allow_self_responses = true` disables the ban entirely.
- **Mention scan order is `members[]` order; talkativeness scan order is shuffled**, so the resulting reply order is: mentioned members first (in list order), then the dice-roll winners in shuffled order.
- Result can be **multiple** speakers who then reply one after another in that order.

### 3.3 LIST order (`:1180-1188`)

```js
function activateListOrder(members) {
    let activatedMembers = members.filter(onlyUnique);
    const memberIds = activatedMembers
        .map((x) => characters.findIndex((y) => y.avatar === x))
        .filter((x) => x !== -1);
    return memberIds;
}
```
Every enabled member replies once per turn, strictly in `members[]` order. No randomness, no talkativeness, no self-response check.

### 3.4 POOLED order (`:1197-1231`)

```js
function activatePooledOrder(members, lastMessage, isUserInput) {
    let activatedMember = null;
    const spokenSinceUser = [];

    for (const message of chat.slice().reverse()) {
        if (message.is_user || isUserInput) { break; }
        if (message.is_system || message.extra?.type === system_message_types.NARRATOR) { continue; }
        if (message.original_avatar) { spokenSinceUser.push(message.original_avatar); }
    }

    const haveNotSpoken = members.filter(x => !spokenSinceUser.includes(x));

    if (haveNotSpoken.length) {
        activatedMember = haveNotSpoken[Math.floor(Math.random() * haveNotSpoken.length)];
    }

    if (activatedMember === null) {
        const lastMessageAvatar = members.length > 1 && lastMessage && !lastMessage.is_user && lastMessage.original_avatar;
        const randomPool = lastMessageAvatar ? members.filter(x => x !== lastMessage.original_avatar) : members;
        activatedMember = randomPool[Math.floor(Math.random() * randomPool.length)];
    }

    const memberId = characters.findIndex(y => y.avatar === activatedMember);
    return memberId !== -1 ? [memberId] : [];
}
```
Exactly **one** speaker per turn. Note the quirk: when `isUserInput` is true the backward scan breaks immediately, so `spokenSinceUser` is empty and everyone is "have not spoken" — a fresh pool starts on every user message.

### 3.5 MANUAL (inline at `:1029-1031`)

```js
} else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
    activatedMembers = shuffle(enabledMembers).slice(0, 1).map(x => characters.findIndex(y => y.avatar === x)).filter(x => x !== -1);
}
```
With user input → empty → the user message is just posted, no reply. Explicit triggers: the member row's `data-action="speak"` button:
```js
if (action === 'speak') {
    const chid = Number(member.attr('data-chid'));
    if (Number.isInteger(chid)) { Generate('normal', { force_chid: chid }); }
}
```
and `/trigger [member]` → `Generate('normal', { force_chid: chid })` (`slash-commands.js:4986-5020`), with `findGroupMemberId()` resolving either a 0-based member index or a fuzzy (Fuse.js over `avatar`+`name`) name match (`group-chats.js:353-419`).

### 3.6 Swipe / continue / quiet / impersonate

```js
function activateSwipe(members, { allowSystem = false } = {}) {
    let activatedNames = [];
    const lastMessage = chat[chat.length - 1];
    if (!lastMessage) { return []; }

    if (lastMessage.is_user || (!allowSystem && lastMessage.is_system) || lastMessage.extra?.type === system_message_types.NARRATOR) {
        for (const message of chat.slice().reverse()) {
            if (message.is_user || (!allowSystem && message.is_system) || message.extra?.type === system_message_types.NARRATOR) { continue; }
            if (message.original_avatar) { activatedNames.push(message.original_avatar); break; }
        }
        if (activatedNames.length === 0) { activatedNames.push(shuffle(members.slice())[0]); }
    }

    // pre-update group chat swipe
    if (!lastMessage.original_avatar) {
        const matches = characters.filter(x => x.name == lastMessage.name);
        for (const match of matches) {
            if (members.includes(match.avatar)) { activatedNames.push(match.avatar); break; }
        }
    } else {
        activatedNames.push(lastMessage.original_avatar);
    }

    const memberIds = activatedNames.map((x) => characters.findIndex((y) => y.avatar === x)).filter((x) => x !== -1);
    return memberIds;
}
```
Swipe/continue re-target the **same character who wrote the message being swiped**, resolved from `original_avatar` (falling back to name matching for pre-avatar-era chats). `impersonate` picks a uniformly random member (`activateImpersonate`, `:1114-1121`) — its identity is basically irrelevant since impersonation writes as the user.

`regenerateGroup()` (`:167-188`) deletes trailing messages sharing the last `extra.gen_id` (or, for legacy messages, until it hits a user/system message), then re-runs `generateGroupWrapper(false, 'normal', {signal})` — i.e. **regenerate re-rolls the whole multi-speaker batch**, not just one message.

### 3.7 Auto mode

```js
function setAutoModeWorker() {
    clearInterval(autoModeWorker);
    const autoModeDelay = groups.find(x => x.id === selected_group)?.auto_mode_delay ?? DEFAULT_AUTO_MODE_DELAY;
    autoModeWorker = setInterval(groupChatAutoModeWorker, autoModeDelay * 1000);
}

async function groupChatAutoModeWorker() {
    if (!is_group_automode_enabled || online_status === 'no_connection') { return; }
    if (!selected_group || is_send_press || is_group_generating) { return; }
    const group = groups.find((x) => x.id === selected_group);
    if (!group || !Array.isArray(group.members) || !group.members.length) { return; }
    groupAutoModeAbortController = new AbortController();
    await generateGroupWrapper(true, 'auto', { signal: groupAutoModeAbortController.signal });
}
```
- Toggle: `#rm_group_automode` sets `is_group_automode_enabled` and registers a one-shot `GENERATION_STOPPED` → `stopAutoModeGeneration` (`:2466-2470`).
- Typing in `#send_textarea` (keyup) silently turns auto mode off (`onSendTextareaInput`, `:2396-2402`).
- `byAutoMode=true` means `isUserInput=false` and `activationText = lastMessage.mes`, so characters keep talking to each other; NATURAL's self-response ban applies.
- Note `type='auto'` is not a recognized special type, so it falls through to the strategy branch and `generateType` resolves to `'normal'`.
- The interval is re-armed by `select_group_chats()` and by editing the delay.

### 3.8 Queue UI

`groupChatQueueOrder: Map<avatar, number>` is a 1-based position map, only populated when `power_user.show_group_chat_queue` (default `false`, `power-user.js:189`). `getGroupCharacterBlock` renders `.queue_position` and toggles `is_queued` (pos > 1) / `is_active` (pos === 1) classes (`:1704-1709`).

---

## 4. Character Card Injection per Turn

### 4.1 SWAP (0) — the default

`getGroupCharacterCardsLazy()` short-circuits:

```js
export function getGroupCharacterCardsLazy(groupId, characterId) {
    const group = groups.find(x => x.id === groupId);
    // If no group cards should be generated, return null so caller knows to fall back
    if (!group || !group?.generation_mode || !Array.isArray(group.members) || !group.members.length) {
        return null;
    }
    …
}
```
`group.generation_mode === 0` is falsy → returns `null`. Then in `script.js:3343-3409`:

```js
const useGroupCards = selected_group && character;
const groupCardsLazy = useGroupCards ? getGroupCharacterCardsLazy(selected_group, Number(currentChid)) : null;
…
description:  () => { if (groupCardsLazy) return groupCardsLazy.description;  … return baseChatReplace(character.description?.trim()); },
personality:  () => { if (groupCardsLazy) return groupCardsLazy.personality;  … },
scenario:     () => { if (groupCardsLazy) return groupCardsLazy.scenario;     … chat_metadata.scenario || character.scenario … },
mesExamples:  () => { if (groupCardsLazy) return groupCardsLazy.mesExamples;  … chat_metadata.mes_example || character.mes_example … },
```

So in SWAP mode the prompt is built as if it were a **1-on-1 chat with the current speaker only**. Only four fields are ever group-aware; `system` (character's system_prompt override), `jailbreak` (post_history_instructions), `charDepthPrompt`, `version`, `creatorNotes`, `firstMessage`, `alternateGreetings` are **always taken from the current speaker's card alone**, in every mode.

**How the OTHER members are represented in SWAP mode:** they are *not* described at all. Their only presence is:
1. **Chat history** — each past message carries `name`, and gets name-prefixed into the prompt. Text completion: `formatMessageHistoryItem` → `` `${itemName}: ${chatItem.mes}\n` `` (`script.js:5774-5794`). Chat completion: depends on `oai_settings.names_behavior` (`character_names_behavior = { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 }`, `openai.js:205-210`); `DEFAULT` prepends `Name: ` for every non-user message **whenever `selected_group` is set** (`openai.js:594-597`).
2. **The `{{group}}` macro** (see §5), which lists member names.
3. **Stopping strings** — the other members' `\nName:` are added as stop sequences so the model can't ventriloquize them (`script.js:2986-2996`).
4. **`cleanGroupMessage()`** truncation as a post-hoc guard (`script.js:3112-3142`): if the output contains `(^|\n)OtherName:`, everything from that index on is cut. Disabled by `power_user.disable_group_trimming` (default false).

### 4.2 APPEND / APPEND_DISABLED (1 / 2) — "Join character cards"

```js
export function getGroupCharacterCardsLazy(groupId, characterId) {
    const group = groups.find(x => x.id === groupId);
    if (!group || !group?.generation_mode || !Array.isArray(group.members) || !group.members.length) return null;

    /** Runs baseChatReplace on a text, with custom <FIELDNAME> replace */
    function customTransform(value, fieldName, characterName, trim) {
        if (!value) return '';
        value = value.replace(/<FIELDNAME>/gi, fieldName);
        value = trim ? value.trim() : value;
        return baseChatReplace(value, null, characterName);
    }

    function replaceAndPrepareForJoin(value, characterName, fieldName, preprocess = null) {
        value = value?.trim() ?? '';
        if (!value) return '';
        if (typeof preprocess === 'function') { value = preprocess(value); }
        const prefix = customTransform(group.generation_mode_join_prefix, fieldName, characterName, false);
        const suffix = customTransform(group.generation_mode_join_suffix, fieldName, characterName, false);
        value = customTransform(value, fieldName, characterName, true);
        return `${prefix}${value}${suffix}`;
    }

    function collectField(fieldName, getter, preprocess = null) {
        const values = [];
        for (const member of group.members) {
            const index = characters.findIndex(x => x.avatar === member);
            const character = characters[index];
            if (index === -1 || !character) continue;
            if (group.disabled_members.includes(member) && characterId !== index && group.generation_mode !== group_generation_mode.APPEND_DISABLED) {
                continue;
            }
            values.push(replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess));
        }
        return values.filter(x => x.length).join('\n');
    }

    const scenarioOverride = String(chat_metadata.scenario || '');
    const mesExamplesOverride = String(chat_metadata.mes_example || '');

    return createLazyFields({
        description: () => collectField('Description', c => c.description),
        personality: () => collectField('Personality', c => c.personality),
        scenario: () => baseChatReplace(scenarioOverride?.trim()) || collectField('Scenario', c => c.scenario),
        mesExamples: () => baseChatReplace(mesExamplesOverride?.trim()) ||
            collectField('Example Messages', c => c.mes_example, x => !x.startsWith('<START>') ? `<START>\n${x}` : x),
    });
}
```

Precise semantics:
- Iteration is over **`group.members` order** (list order), not activation order. The current speaker is **not** hoisted to the front or specially marked.
- Field display names passed as `<FIELDNAME>`: `'Description'`, `'Personality'`, `'Scenario'`, `'Example Messages'`.
- **Join separator is a bare `\n`** between members' blocks (after empty blocks are filtered out).
- Prefix/suffix macro pipeline per member: `<FIELDNAME>` (case-insensitive, global) is textually replaced, then `baseChatReplace(value, null, characterName)` runs the macro engine with **`name2Override` = that member's name**, so `{{char}}` inside the prefix/suffix resolves to the member being emitted, not the current speaker. The value itself is also passed through `customTransform(..., trim=true)` — so `<FIELDNAME>` and `{{char}}` work inside the card body too.
- **Muting rule**: skip a muted member *unless* it is the character currently generating (`characterId === index`) *or* the mode is `APPEND_DISABLED`. So mode 1 = "exclude muted", mode 2 = "include muted", and a muted member that is force-triggered still gets its own description in mode 1.
- **Scenario / mesExamples chat overrides win outright** — if `chat_metadata.scenario` is set (via the group "Set group chat character settings overrides" button), the joined per-member scenarios are never computed.
- `mes_example` preprocessing prepends `<START>\n` when missing, so each member's examples form a separate example block.
- Everything is **lazily evaluated** (`createLazyFields`, `script.js:~3310-3334`): each key is an accessor that memoizes on first read. This matters because the getters call `characters.findIndex` and the macro engine.

Typical prefix/suffix usage (from the in-app help at `index.html:6279`):
> "When 'Join character cards' is selected, all respective fields of the characters are being joined together. This means that in the story string for example all character descriptions will be joined to one big text. If you want those fields to be separated, you can define a prefix or suffix here. This value supports normal macros and will also replace `{{char}}` with the relevant char's name and `<FIELDNAME>` with the name of the part (e.g.: description, personality, scenario, etc.)"

e.g. prefix `[{{char}}'s <FIELDNAME>]\n` yields `[Alice's Description]\n…\n[Bob's Description]\n…`.

Both fields are shown/hidden by `toggleHiddenControls()`:
```js
const isJoin = [group_generation_mode.APPEND, group_generation_mode.APPEND_DISABLED].includes(generationMode ?? group?.generation_mode);
$('#rm_group_generation_mode_join_prefix').parent().toggle(isJoin);
$('#rm_group_generation_mode_join_suffix').parent().toggle(isJoin);
```

### 4.3 Group depth prompts (character-specific author's notes)

```js
export function getGroupDepthPrompts(groupId, characterId) {
    if (!groupId) return [];
    const group = groups.find(x => x.id === groupId);
    if (!group || !Array.isArray(group.members) || !group.members.length) return [];

    if (group.generation_mode === group_generation_mode.SWAP) return [];   // <-- SWAP: none

    const depthPrompts = [];
    for (const member of group.members) {
        const index = characters.findIndex(x => x.avatar === member);
        const character = characters[index];
        if (index === -1 || !character) continue;
        if (group.disabled_members.includes(member) && characterId !== index) continue;   // note: no APPEND_DISABLED exemption

        const depthPromptText = baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim(), null, character.name) || '';
        const depthPromptDepth = character.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole  = character.data?.extensions?.depth_prompt?.role  ?? depth_prompt_role_default;
        if (depthPromptText) depthPrompts.push({ text: depthPromptText, depth: depthPromptDepth, role: depthPromptRole });
    }
    return depthPrompts;
}
```
Consumed in `script.js:4413-4427`:
```js
removeDepthPrompts();
const groupDepthPrompts = getGroupDepthPrompts(selected_group, Number(this_chid));
if (selected_group && Array.isArray(groupDepthPrompts) && groupDepthPrompts.length > 0) {
    groupDepthPrompts.forEach((value, index) => {
        const role = getExtensionPromptRoleByName(value.role);
        setExtensionPrompt(inject_ids.DEPTH_PROMPT_INDEX(index), value.text, extension_prompt_types.IN_CHAT, value.depth, extension_settings.note.allowWIScan, role);
    });
} else {
    // single-character path, only the current speaker's depth prompt at inject_ids.DEPTH_PROMPT
}
```
`inject_ids.DEPTH_PROMPT = 'DEPTH_PROMPT'`, `DEPTH_PROMPT_INDEX = (index) => \`DEPTH_PROMPT_${index}\`` (`constants.js:51-52`); `removeDepthPrompts()` deletes every `extension_prompts` key starting with `DEPTH_PROMPT`. **Known inconsistency:** unlike `collectField`, this function has no `APPEND_DISABLED` exemption, so muted members' depth prompts are excluded even in mode 2.

### 4.4 Other group-aware Generate() bits

- Dry-run token counting when `selected_group && is_group_generating === false && dryRun` sets `this_chid` to the **first enabled member** so the prompt can be assembled (`script.js:4291-4319`).
- Reasoning blocks from *other* group members are excluded from the prompt: `const isOtherGroupMember = selected_group && coreChat[i].name !== name2;` — only the current speaker's `extra.reasoning` is re-injected (`script.js:4473-4498`).
- `triggerAutoContinue()` is a no-op in groups (`script.js:5725-5728`) — auto-continue is instead handled explicitly inside the wrapper loop via `shouldAutoContinue`.

---

## 5. Group Nudge & New-Group-Chat Prompt

**Chat Completion only.** Two settings, both in `oai_settings`:

```js
// public/scripts/openai.js
const default_new_group_chat_prompt = '[Start a new group chat. Group members: {{group}}]';   // L108
const default_group_nudge_prompt    = '[Write the next reply only as {{char}}.]';             // L114
```
Bound to `#newgroupchat_prompt_textarea` and `#group_nudge_prompt_textarea` (`index.html:908`), with restore-default buttons (`openai.js:6820-6881`).

Creation as a prompt entry (`openai.js:1363-1382`):
```js
const groupNudge = substituteParams(oai_settings.group_nudge_prompt);
const systemPrompts = [
    …
    { role: 'system', content: quietPrompt,  identifier: 'quietPrompt' },
    { role: 'system', content: groupNudge,   identifier: 'groupNudge' },
    { role: 'assistant', content: bias,      identifier: 'bias' },
];
```

Insertion (`openai.js:881-1088`, inside `populateChatHistory`):
```js
// Reserve budget for new chat message
const newChat = selected_group ? oai_settings.new_group_chat_prompt : oai_settings.new_chat_prompt;
const newChatMessage = await Message.createAsync('system', substituteParams(newChat), 'newMainChat');
chatCompletion.reserveBudget(newChatMessage);

// Reserve budget for group nudge
let groupNudgeMessage = null;
const noGroupNudgeTypes = ['impersonate'];
if (selected_group && prompts.has('groupNudge') && !noGroupNudgeTypes.includes(type)) {
    groupNudgeMessage = await Message.fromPromptAsync(prompts.get('groupNudge'));
    chatCompletion.reserveBudget(groupNudgeMessage);
}
…
// Insert and free new chat
chatCompletion.freeBudget(newChatMessage);
chatCompletion.insertAtStart(newChatMessage, 'chatHistory');

// Reserve budget for group nudge
if (selected_group && groupNudgeMessage) {
    chatCompletion.freeBudget(groupNudgeMessage);
    chatCompletion.insertAtEnd(groupNudgeMessage, 'chatHistory');
}
```

Exact placement:
- **`newMainChat`** (`[Start a new group chat. Group members: {{group}}]`) → `insertAtStart` of the `chatHistory` collection, i.e. immediately **before the oldest retained chat message**.
- **`groupNudge`** (`[Write the next reply only as {{char}}.]`) → `insertAtEnd` of `chatHistory`, i.e. **after the last chat message, right before generation**. `{{char}}` resolves to the currently drafted member's name (because `setCharacterName` ran first).
- Both have budget reserved up front so they survive context truncation.
- Group nudge is **skipped for `type === 'impersonate'`**.
- `groupNudge` is in the excluded list at `openai.js:3856` (`const excludeList = ['newMainChat', 'newChat', 'groupNudge'];`) for prompt-manager purposes.

**Text Completion has no group nudge.** Its equivalent is the forced name suffix — `force_name2` appends `\n{{name2}}:` to the last line (`script.js:5019-5029`), plus other members' names as stop sequences (`script.js:2986-2996`).

---

## 6. Greetings in a Group (`group_only_greetings` does NOT exist here)

I grepped the whole tree (`public/` and `src/`) for `group_only_greetings` / `onlyGreetings` — **zero hits**. That is a Character Card V3 spec field that SillyTavern 1.18.0 does not implement. `alternate_greetings` (V2) **is** implemented and is what group greetings use.

Greetings are seeded **once, when the chat file is empty and untainted**, in `getGroupChat()`:

```js
const chat_id = group.chat_id;
const data = await loadGroupChat(chat_id);
const metadata = data?.[0]?.chat_metadata ?? {};
const freshChat = !metadata.tainted && (!Array.isArray(data) || !data.length);

// Remove chat file header if present
if (Array.isArray(data) && data.length && Object.hasOwn(data[0], 'chat_metadata')) { data.shift(); }
if (!metadata.integrity) { metadata.integrity = uuidv4(); }
await loadItemizedPrompts(getCurrentChatId());

if (group && Array.isArray(group.members) && freshChat) {
    chat.splice(0, chat.length);
    chatElement.find('.mes').remove();
    for (let member of group.members) {
        const character = characters.find(x => x.avatar === member || x.name === member);
        if (!character) continue;
        const mes = await getFirstCharacterMessage(character);
        if (!(mes?.mes)) continue;              // No first message -> skip this member
        chat.push(mes);
        await eventSource.emit(event_types.MESSAGE_RECEIVED, (chat.length - 1), 'first_message');
        addOneMessage(mes);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, (chat.length - 1), 'first_message');
    }
    await saveGroupChat(groupId, false);
} else if (Array.isArray(data) && data.length) {
    chat.splice(0, chat.length, ...data);
    chat.forEach(ensureMessageMediaIsArray);
    chatElement.find('.mes').remove();
    await printMessages();
}

updateChatMetadata(metadata, true);
…
await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
if (freshChat) await eventSource.emit(event_types.GROUP_CHAT_CREATED);
```

And per-member greeting selection:

```js
async function getFirstCharacterMessage(character) {
    let messageText = character.first_mes;

    // if there are alternate greetings, pick one at random
    if (Array.isArray(character.data?.alternate_greetings)) {
        const messageTexts = [character.first_mes, ...character.data.alternate_greetings].filter(x => x);
        messageText = messageTexts[Math.floor(Math.random() * messageTexts.length)];
    }

    // Allow extensions to change the first message
    const eventArgs = { input: messageText, output: '', character: character };
    await eventSource.emit(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, eventArgs);
    if (eventArgs.output) { messageText = eventArgs.output; }

    const mes = {};
    mes.is_user = false;
    mes.is_system = false;
    mes.name = character.name;
    mes.send_date = getMessageTimeStamp();
    mes.original_avatar = character.avatar;
    mes.extra = { 'gen_id': Date.now() * Math.random() * 1000000 };
    mes.mes = messageText ? substituteParams(messageText.trim(), { name2Override: character.name }) : '';
    mes.force_avatar = character.avatar != 'none' ? getThumbnailUrl('avatar', character.avatar) : default_avatar;
    return mes;
}
```

Summary of group greeting behavior:
- **Every** member (including muted ones — `disabled_members` is not checked here) that has a non-empty greeting contributes one opening message, in `members[]` order.
- The greeting is chosen **uniformly at random** from `[first_mes, ...alternate_greetings]` (empties filtered).
- Macros are substituted with `name2Override` set to that member's name, so `{{char}}` is correct per greeting.
- Each greeting gets a unique random `extra.gen_id` so it can be swiped/regenerated independently.
- Seeding only happens when the chat is both empty **and** `!metadata.tainted`. `tainted` is set to `true` on the first real generation (`script.js:4288`), which prevents greetings from reappearing in a chat the user emptied manually.

---

## 7. Muting / Disabled Members

`disabled_members: string[]` of avatar ids. Toggled from the member row (`onGroupActionClick`, `:1955-2003`):

```js
if (action === 'enable') {
    member.removeClass('disabled');
    const _thisGroup = groups.find(x => x.id === openGroupId);
    const index = _thisGroup.disabled_members.indexOf(member.data('id'));
    if (index !== -1) { _thisGroup.disabled_members.splice(index, 1); await editGroup(openGroupId, false, false); }
}
if (action === 'disable') {
    member.addClass('disabled');
    const _thisGroup = groups.find(x => x.id === openGroupId);
    if (!_thisGroup.disabled_members.includes(member.data('id'))) {
        _thisGroup.disabled_members.push(member.data('id')); await editGroup(openGroupId, false, false);
    }
}
```
UI tooltips: *"Temporarily disable automatic replies from this character"* / *"Enable automatic replies from this character"* (`index.html:7560-7561`). Slash equivalents `/member-disable`, `/member-enable`.

### 7.1 Effect on speaker selection
`const enabledMembers = group.members.filter(x => !group.disabled_members.includes(x));` — used by NATURAL, LIST, POOLED, MANUAL-random. **Muting does NOT block**: `force_chid` (speak button, `/trigger`), swipe, continue, quiet, or impersonate — those all iterate `group.members`. So "muted" precisely means *"never auto-selected"*, not *"cannot speak"*.

### 7.2 Effect on the prompt
- **Cards**: excluded from `collectField` in APPEND (1), included in APPEND_DISABLED (2), and always included if they happen to be the current speaker. Irrelevant in SWAP.
- **Depth prompts**: excluded unless current speaker (no mode-2 exemption).
- **Macros**: `{{group}}` includes muted; `{{groupNotMuted}}` excludes them (`script.js:2819-2836`):
```js
const getGroupValue = (includeMuted) => {
    if (typeof _group === 'string') return _group;
    if (selected_group) {
        const members = groups.find(x => x.id === selected_group)?.members;
        const disabledMembers = groups.find(x => x.id === selected_group)?.disabled_members ?? [];
        const isMuted = x => includeMuted ? true : !disabledMembers.includes(x);
        const names = Array.isArray(members)
            ? members.filter(isMuted).map(m => characters.find(c => c.avatar === m)?.name).filter(Boolean).join(', ')
            : '';
        return names;
    } else { return _name2 ?? name2; }
};
…
environment.group = environment.charIfNotGroup = getGroupValue(true);
environment.groupNotMuted = getGroupValue(false);
environment.notChar = getNotCharValue();   // all member names except the current speaker, plus the user's persona name
```
- **Stopping strings** are generated from ALL `group.members` regardless of mute state.
- **Greetings** ignore mute state entirely.

### 7.3 `hideMutedSprites`
Only used by the expressions extension's visual-novel mode (`extensions/expressions/index.js:188-200`):
```js
for (const avatar of group.members) {
    // skip disabled characters
    const isDisabled = group.disabled_members.includes(avatar);
    if (isDisabled && hideMutedSprites) { continue; }
    …
}
```
The live value is a module-level export in `group-chats.js` refreshed by `select_group_chats()` (`hideMutedSprites = group?.hideMutedSprites ?? false;`) and by the checkbox handler; `onHideMutedSpritesClick` persists it and emits `GROUP_UPDATED`.

---

## 8. World Info / Lorebooks in Groups

**Finding: SillyTavern 1.18.0 does NOT merge group members' lorebooks.** `public/scripts/world-info.js` imports neither `groups` nor `selected_group` nor `getGroupMembers` (verified by grep — the only "group" hits in that file are about WI *inclusion groups*, an unrelated concept).

```js
async function getCharacterLore() {
    const character = characters[this_chid];
    const name = character?.name;
    let worldsToSearch = new Set();

    const baseWorldName = character?.data?.extensions?.world;
    if (baseWorldName) worldsToSearch.add(baseWorldName);

    const fileName = getCharaFilename(this_chid);
    const extraCharLore = world_info.charLore?.find((e) => e.name === fileName);
    if (extraCharLore) worldsToSearch = new Set([...worldsToSearch, ...extraCharLore.extraBooks]);

    if (!worldsToSearch.size) return [];

    let entries = [];
    for (const worldName of worldsToSearch) {
        if (selected_world_info.includes(worldName)) continue;                 // already global
        if (chat_metadata[METADATA_KEY] === worldName) continue;               // already chat lore
        if (power_user.persona_description_lorebook === worldName) continue;   // already persona lore
        const data = await loadWorldInfo(worldName);
        const newEntries = data ? Object.keys(data.entries).map(x => data.entries[x]).map(({uid, ...rest}) => ({uid, world: worldName, ...rest})) : [];
        entries = entries.concat(newEntries);
    }
    return entries;
}
```

Because `generateGroupWrapper` sets `setCharacterId(chId)` **before** each `Generate()` call, `this_chid` is the **currently drafted speaker**, so the character-lore layer is *only that speaker's* book(s) (`data.extensions.world` + the `world_info.charLore[].extraBooks` entry keyed by the character's file name) — recomputed on every turn of the loop. For a dry run (token counting) it's the first enabled member.

Combination happens in `getSortedEntries()` (`world-info.js:4478-4531`):
```js
const [globalLore, characterLore, chatLore, personaLore] = await Promise.all([
    getGlobalLore(), getCharacterLore(), getChatLore(), getPersonaLore(),
]);
await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED, { globalLore, characterLore, chatLore, personaLore });

switch (Number(world_info_character_strategy)) {
    case world_info_insertion_strategy.evenly:          entries = [...globalLore, ...characterLore].sort(sortFn); break;
    case world_info_insertion_strategy.character_first: entries = [...characterLore.sort(sortFn), ...globalLore.sort(sortFn)]; break;
    case world_info_insertion_strategy.global_first:    entries = [...globalLore.sort(sortFn), ...characterLore.sort(sortFn)]; break;
    default:                                            entries = [...globalLore, ...characterLore].sort(sortFn); break;
}
// Chat lore always goes first, then persona lore, then the rest
entries = [...chatLore.sort(sortFn), ...personaLore.sort(sortFn), ...entries];
```
Default is `world_info_character_strategy = world_info_insertion_strategy.character_first` (`world-info.js:80`). Duplicate books across layers are skipped (the three `continue`s above).

Practical consequence: **the way to give a whole group shared lore is the group's chat lorebook** (`chat_metadata[METADATA_KEY]`, wired to `#group-metadata-controls .chat_lorebook_button` / `#group-chat-lorebook-dropdown`, enabled only for existing groups — `group-chats.js:1847,1859`) or global books. Per-member books rotate in and out with whoever is speaking.

---

## 9. Assorted mechanics worth knowing

**`unshallowGroupMembers`** (`:1378-1394`) — 1.18.0 lazy-loads character cards ("shallow" characters). Before generating and when opening a group, every member is force-loaded:
```js
for (const member of members) {
    const index = characters.findIndex(x => x.avatar === member);
    if (index === -1) continue;
    await unshallowCharacter(String(index));
}
```

**Save with integrity check** — `saveGroupChat` POSTs `{id, chat: [chatHeader, ...chat], force}`; a `{error:'integrity'}` response opens a popup requiring the literal string `OVERWRITE` or reloads the page.

**Group renaming propagation** — `renameGroupMember(oldAvatar, newAvatar, newName)` (`:683-753`) rewrites `group.members`, then rewrites every past chat file, patching `message.name`, `message.force_avatar` (URL-encoded avatar substring), `message.original_avatar`, and emits `CHARACTER_RENAMED_IN_PAST_CHAT`.

**Events** (`scripts/events.js`): `GROUP_UPDATED: 'group_updated'`, `GROUP_CHAT_CREATED: 'group_chat_created'`, `GROUP_MEMBER_DRAFTED: 'group_member_drafted'` (payload = character index), `GROUP_WRAPPER_STARTED: 'group_wrapper_started'`, `GROUP_WRAPPER_FINISHED: 'group_wrapper_finished'`, `GROUP_CHAT_DELETED`, plus the ad-hoc `eventSource.emit('groupSelected', { detail: { id, group } })` from `select_group_chats`.

**Chat lifecycle helpers**: `createNewGroupChat` (push new `humanizedDateTime()` id, set `chat_id`, clear metadata, reload), `openGroupChat`, `renameGroupChat`, `deleteGroupChat` / `deleteGroupChatByName`, `getGroupPastChats` (per-chat `/api/chats/group/info`), `importGroupChat`, `saveGroupBookmarkChat`.

**Solo→group conversion** (`bookmarks.js:344-437`) is a complete worked example of the group create payload and of back-filling `name` / `original_avatar` / `force_avatar` / `extra.gen_id` onto pre-existing solo messages so they behave like group messages.


## Reusable
## Port directly (the logic is self-contained and framework-free)

1. **The two enums with their exact numeric values** — persist them as numbers so existing SillyTavern group JSON imports cleanly:
   `group_activation_strategy = { NATURAL: 0, LIST: 1, MANUAL: 2, POOLED: 3 }`, `group_generation_mode = { SWAP: 0, APPEND: 1, APPEND_DISABLED: 2 }`, `DEFAULT_AUTO_MODE_DELAY = 5`, `talkativeness_default = 0.5`.

2. **The four activation functions verbatim** (`activateNaturalOrder`, `activateListOrder`, `activatePooledOrder`, `activateSwipe`) — they are pure functions of `(members, chat, characters, flags)` and translate to TS with almost no change. Make them pure by passing `chat` and `characters` in rather than reading module globals. The only external helpers needed are `shuffle`, `onlyUnique`, and `extractAllWords`.

3. **`getGroupCharacterCardsLazy`'s join algorithm** — the `collectField` / `replaceAndPrepareForJoin` / `customTransform` trio, including the `<FIELDNAME>` token, the per-member `{{char}}` override, the `\n` join separator, the `<START>` prefix for example messages, and the exact mute rule `disabled && currentIdx !== idx && mode !== APPEND_DISABLED`.

4. **Group nudge placement** — `[Write the next reply only as {{char}}.]` appended as a system message at the very END of chat history, plus `[Start a new group chat. Group members: {{group}}]` at the very START; and skip the nudge for impersonation. This is the single highest-leverage prompt trick for keeping 1-vs-N coherent.

5. **The `{{group}}` / `{{groupNotMuted}}` / `{{notChar}}` macros** — three tiny resolvers, high value.

6. **`cleanGroupMessage()` + other-member stopping strings** — cheap, and essential to stop the model from writing everyone's lines.

7. **The per-message identity stamp**: `{ name, original_avatar, force_avatar, extra.gen_id }`. `original_avatar` is the stable "who spoke" key that swipe/pooled/rename all depend on; `extra.gen_id` batches a multi-speaker turn for regeneration. Keep both in your IndexedDB message record.

8. **The greeting seeding rule**: seed only when `messages.length === 0 && !metadata.tainted`; one greeting per member in list order; random pick from `[first_mes, ...alternate_greetings]`; set `tainted = true` on first generation.

## Adapt / restructure

- **The orchestration loop.** `generateGroupWrapper` works by mutating globals (`this_chid`, `name2`, `is_group_generating`) around each `Generate()` call. In Pinia, make it an explicit action that takes a `speakerId` parameter and threads it through prompt building — no globals. Keep the shape: `selectSpeakers() -> for each speaker: buildPrompt(speaker) -> generate() -> appendMessage()`, with an `AbortController` and a re-entrancy lock.
- **Storage layout.** SillyTavern's `groups/<id>.json` + `groupChats/<chatId>.jsonl` with a header line maps to two IndexedDB stores: `groups` (the Group record) and `groupMessages` (keyed by `chatId`, with a sibling `chatMeta` record holding `{tainted, integrity, scenario, mes_example, lorebook}`). Do NOT replicate `chat_metadata`/`past_metadata` on the group object — 1.18.0 explicitly migrated away from that; go straight to per-chat metadata.
- **Members as avatar ids.** ST uses the avatar filename as the character primary key, which forces `characters.findIndex(x => x.avatar === member)` lookups everywhere (O(n) inside loops). Use a real `characterId` and a `Map` index; keep an `avatar` field only for import/export compatibility.
- **Naming.** `hideMutedSprites` is camelCase while every sibling is snake_case, and the server `/create` endpoint doesn't even declare it. Normalize to one convention (`hide_muted_sprites`) and map on import.
- **Fix the two known inconsistencies** rather than porting them: (a) `getGroupDepthPrompts` lacks the `APPEND_DISABLED` exemption that `collectField` has, so muted members' depth prompts are dropped even in "include muted" mode; (b) `activateSwipe` can push the same avatar twice before the `findIndex` map (harmless today only because callers slice or the duplicate maps to the same id).
- **World info.** ST does NOT merge member lorebooks — only the active speaker's. If you want group-wide lore, either replicate that (simplest, matches ST behavior) or deliberately improve it by unioning all enabled members' books with dedupe; either way keep the "chat lore first, then persona lore, then character/global by strategy" ordering and the "skip a book already active in another layer" dedupe.

## Skip entirely

- All jQuery UI plumbing: `printGroupMembers` / `printGroupCandidates` and the `pagination()` plugin, `getGroupCharacterBlock`, `getGroupBlock`, `doCurMemberListPopout`, `dragElement`/`loadMovingUIState`, `select_group_chats`'s ~80 lines of `$('#...').val()` calls, `toggleHiddenControls`, the `field-sizing` CSS fallbacks, `#group_avatars_template .collage_N` cloning (just render a CSS grid of up to 4 thumbnails).
- The legacy migrations: numeric→string `id`/`chat_id`, name→avatar member conversion, `warnOnGroupMetadata` / `migrateGroupChatsMetadataFormat`. Write the modern shape once.
- `group_only_greetings` — it does not exist in this codebase. Don't implement it just because the field name was in the brief; if you want it, it's a Character Card V3 field meaning "use these greetings instead of first_mes when in a group", and you'd add it as an extra branch inside `getFirstCharacterMessage`.
- The chat-file integrity/`OVERWRITE` popup and `compressRequest` — artifacts of a multi-tab HTTP server; IndexedDB with a version counter is enough.
- `unshallowGroupMembers` — only needed because ST lazy-loads card data over HTTP.
- The `#groupMemberListPopout` floating panel, tag filters (`FilterHelper`, `printTagFilters`), and the Fuse.js fuzzy member search in `findGroupMemberId` (a simple case-insensitive name match plus index parse covers it).