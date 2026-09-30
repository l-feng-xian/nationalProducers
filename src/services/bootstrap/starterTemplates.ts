import { getDb, type BlobRecord } from '@/db/schema'
import { emptyCharacter, type Character } from '@/types/character'
import { emptyGroup, group_activation_strategy, USER_NODE_ID, type Group } from '@/types/group'
import { DEFAULT_WI_ENTRY, type WorldBook, type WorldInfoEntry } from '@/types/worldinfo'
import type { FlowConfig } from '@/types/flow'
import { generateImage } from '@/services/image/generate'
import { characterImagePrompt } from '@/services/image/prompts'
import { useSettingsStore } from '@/stores/settings'
import { useCharactersStore } from '@/stores/characters'
import { useGroupsStore } from '@/stores/groups'

interface RoleSeed {
  name: string
  job: string
  nature: string
  secret: string
  opening: string
}

interface StorySeed {
  id: string
  title: string
  era: string
  player: string
  premise: string
  stakes: string
  lore: [string, string, string[]][]
  roles: [RoleSeed, RoleSeed, RoleSeed]
  relations: [string, string, string]
  stages: [string, string, string]
  cover: string
}

export const STARTER_STORIES: StorySeed[] = [
  {
    id: 'five-dynasties', title: '乱世渡口', era: '五代十国末期，后周与南唐边境',
    player: '无田无产的渡口平民，靠零工与摆渡维生，没有武艺或官身。',
    premise: '一艘夜船载来失踪的军粮账册，渡口三人各有不得不追查的理由。',
    stakes: '乱世中粮比命贵。平民可以周旋、逃避或揭发，但不能凭空调兵、改写史实。',
    lore: [
      ['时局与身份', '后周与南唐边境战事反复，官府、寨兵与地方豪强各收一道税。普通百姓没有通行文书，跨境需保人，口粮与路费必须计入故事。', []],
      ['渡口规矩', '青芦渡天黑停船，渡船由船户轮值。私运盐、铁与军粮都会招致缉捕；发现账册的人也可能被当成同谋。', ['渡口', '夜船', '账册']],
      ['军粮疑案', '账册记录一批拨给前线的粮实际流入私人仓栈。各方知道的线索不完整，证词、印章与实物必须相互印证。', ['军粮', '仓栈', '印章']],
      ['叙事边界', '采用有历史质感的口语，不让角色预知未来。主角出身微末，选择可以改变身边人的命运，但行动须受身份、地理与物资限制。', []],
    ],
    roles: [
      { name: '沈阿篙', job: '渡船船娘', nature: '爽利、警觉、嘴硬心软', secret: '父亲曾替军府运粮，失踪前留下半枚仓印。', opening: '天色黑透，沈阿篙把船篙横在你身前：“今夜不摆渡。除非你也看见了船底那本账。”' },
      { name: '陆砚生', job: '落第账房', nature: '谨慎、斯文、对数字近乎固执', secret: '他认得账册上的涂改笔迹，却怕牵连在城内的妹妹。', opening: '陆砚生将湿透的账页摊在灯下：“这不是少了粮，是有人把粮写成了灰。”' },
      { name: '祁五娘', job: '游方郎中', nature: '温和、果断、遇到不义绝不退让', secret: '她正为一批因断粮染病的流民寻药。', opening: '祁五娘背着药箱从雨里走来：“先救船上那个发烧的人。账，天亮再算。”' },
    ],
    relations: ['患难相依', '互相提防', '旧日救命之恩'],
    stages: ['夜船靠岸', '账册追查', '渡口抉择'],
    cover: 'cinematic historical drama, late Tang Five Dynasties riverside ferry at dusk, three ordinary people with distinct silhouettes: practical boatwoman holding a pole, modest bookkeeper with ledger, traveling female healer with medicine box, authentic worn clothing, rain-wet timber pier, natural faces, warm lamplight, detailed editorial illustration, wide composition, no text, no watermark',
  },
  {
    id: 'modern-city', title: '凌晨上线', era: '当代中国都市',
    player: '在中型互联网公司工作的程序员，负责一套城市服务系统的后端。',
    premise: '凌晨上线前，系统里出现一批被悄悄修改的求助记录。谁改的、为了什么，尚无定论。',
    stakes: '工作有权限边界、取证流程和个人代价。技术不是万能钥匙，不能凭空入侵系统或把同事写成工具人。',
    lore: [
      ['公司与系统', '澜桥科技承接城市服务平台，研发、产品与运营职责分离。生产变更需工单、审批和审计记录；主角是后端程序员，权限有限。', []],
      ['异常记录', '部分求助工单在夜间被改为已处理，原始记录可能留在日志、备份与用户回执中。异常尚不能证明某个人有罪。', ['工单', '日志', '回执']],
      ['现实约束', '加班、房租、绩效与同事信任都影响选择。调查需遵守法律与隐私边界，公开信息前应核实证据。', []],
      ['都市氛围', '写真实的办公室、地铁、便利店和居民社区。人物有本职工作与生活，不会围着玩家转；对话自然克制。', []],
    ],
    roles: [
      { name: '林栖', job: '产品经理', nature: '高效、直言、在压力下仍重视用户', secret: '她接到过要求提前关闭投诉入口的口头指令。', opening: '凌晨的办公室只剩一排灯。林栖把手机推到你面前：“这个人说他的求助被标成解决了，可他还在等车。”' },
      { name: '周予安', job: '数据安全工程师', nature: '冷静、幽默、有原则', secret: '审计日志里有一枚不该出现在生产环境的临时凭证。', opening: '周予安盯着终端，摘下一边耳机：“你最好先看这条审计记录，再决定要不要点发布。”' },
      { name: '唐见月', job: '社区记者', nature: '敏锐、执着、尊重受访者', secret: '她已采访到受影响者，但当事人不愿公开姓名。', opening: '咖啡店里，唐见月合上录音笔：“我只要能核实的事实。你愿意从哪一条说起？”' },
    ],
    relations: ['并肩加班', '专业互信但立场有别', '消息来源与核实者'],
    stages: ['上线前夜', '证据链', '公开或内部纠正'],
    cover: 'contemporary Chinese city at night, three grounded professionals in one coherent cinematic wide frame: product manager with tablet, security engineer at workstation, community journalist with notebook, realistic modern office overlooking lit streets, clear expressive faces, restrained teal and amber accents, editorial photography, no text, no watermark',
  },
  {
    id: 'xianxia-outer', title: '山门试炼', era: '架空古风仙侠世界，栖云宗',
    player: '栖云宗普通外门弟子，灵根平常、修为炼气初期，靠杂役与月例修行。',
    premise: '药田灵泉忽然枯竭，外门弟子被派去查山后禁径，却发现宗门旧约留下的痕迹。',
    stakes: '修行有境界、资源与代价。主角无法越级战胜长老，也不能无代价获得法宝或顿悟。',
    lore: [
      ['栖云宗', '宗门分外门、内门、执事堂与长老院。外门弟子领取月例灵石，须完成杂役，进入禁地或借用法器须有手令。', []],
      ['修行规则', '境界由炼气、筑基、金丹循序推进。灵气、伤势、丹药和功法相互制约；突破需要积累与契机，失败会留下后果。', []],
      ['灵泉旧约', '山后灵泉原由宗门与山灵共同守护。旧约一度被封存，泉眼衰竭可能与近期采矿有关，但证据尚不充分。', ['灵泉', '旧约', '泉眼']],
      ['山门禁径', '禁径有残阵与幻雾，地图残缺。不能用蛮力跳过调查；进入须备照明、护符与退路。', ['禁径', '残阵', '幻雾']],
    ],
    roles: [
      { name: '叶听禾', job: '药田弟子', nature: '温柔、倔强、对草木极有耐心', secret: '她发现枯萎的灵草根部有陌生矿粉。', opening: '叶听禾蹲在枯黄的药畦边，掌心托着一株细苗：“昨夜还好好的。你闻，根上有铁锈味。”' },
      { name: '顾临川', job: '外门巡山弟子', nature: '守规矩、寡言、关键时刻敢担责', secret: '他曾在禁径见过执事堂的灯，却没有记下名字。', opening: '顾临川挡住山道，低声道：“没有手令不能进。但今夜若真有人在里面，我陪你走一趟。”' },
      { name: '苏照微', job: '符箓铺学徒', nature: '机灵、贪财但不舍得害人', secret: '她手中有一张能辨旧阵的残符，欠着材料钱。', opening: '苏照微把一张旧符压在桌上：“借你可以，坏了算你的。还有，别说是我画的。”' },
    ],
    relations: ['药田同伴', '互相监督', '欠账与旧识'],
    stages: ['药田异变', '禁径探查', '旧约真相'],
    cover: 'elegant Chinese xianxia fantasy wide illustration, misty mountain sect herb terraces, three ordinary outer disciples together: young herbalist with seedlings, disciplined mountain patrol apprentice, lively talisman shop apprentice, simple layered robes and practical tools, luminous spring in distance, restrained jade and coral colors, crisp faces, painterly detail, no text, no watermark',
  },
]

function bookFor(story: StorySeed, now: number): WorldBook {
  const entries: Record<string, WorldInfoEntry> = {}
  story.lore.forEach(([comment, content, key], uid) => {
    entries[String(uid)] = { ...structuredClone(DEFAULT_WI_ENTRY), uid, comment, content, key, constant: key.length === 0, order: 120 - uid }
  })
  return { id: `starter-book-${story.id}`, templateId: story.id, name: `${story.title} · 世界书`, description: story.premise, entries, createdAt: now, updatedAt: now }
}

function flowFor(story: StorySeed): FlowConfig {
  return {
    rules: [{
      id: `starter-${story.id}-turn`, name: '循线推进', enabled: true,
      trigger: { kind: 'afterReply' }, match: 'all', mode: 'once',
      conditions: [{ id: 'turn', source: 'turn', op: 'gte', value: '2' }],
      actions: [{ id: 'guide', kind: 'guide', text: '让人物根据已掌握的证据提出下一步选择，保留玩家决定权，不提前揭露全部真相。', turns: 2 }],
    }],
    stages: story.stages.map((name, index) => ({
      id: `stage-${index}`, name,
      guide: `${story.premise} 当前阶段：${name}。${story.stakes} 让三个角色各自按职业与性格行动，线索通过场景、对话和代价逐步显现。`,
      transitions: index < 2 ? [{ id: `next-${index}`, to: `stage-${index + 1}`, match: 'all', conditions: [{ id: `turn-${index}`, source: 'turn', op: 'gte', value: String(index === 0 ? 4 : 10) }] }] : [],
    })),
  }
}

function charactersFor(story: StorySeed, bookId: string, now: number): Character[] {
  return story.roles.map((role, index) => {
    const char = emptyCharacter(`starter-character-${story.id}-${index}`, role.name)
    char.templateId = `${story.id}-${index}`
    char.worldBookId = bookId
    char.createdAt = now
    char.updatedAt = now
    char.data.description = `${role.name}，${story.era}的${role.job}。${role.secret} 面对玩家时有自己的生活、目标与风险。`
    char.data.personality = role.nature
    char.data.scenario = `${story.premise} 玩家身份：${story.player} ${story.stakes}`
    char.data.first_mes = role.opening
    char.data.mes_example = `<START>\n{{user}}：你为什么愿意帮我？\n${role.name}：我有自己的理由，但这事必须一步一步弄清楚。`
    char.data.creator_notes = `基础模板 · ${story.title} · ${role.job}`
    char.data.tags = ['基础模板', story.title, role.job]
    char.data.creator = 'National Producers'
    char.data.character_version = '1.0'
    char.data.system_prompt = `扮演${role.name}。保持${role.nature}的性格，遵守世界书与${story.era}的限制。不要代替玩家发言、选择或描写玩家内心。秘密只在合乎情节时逐渐透露。`
    return char
  })
}

function groupFor(story: StorySeed, members: Character[], bookId: string, now: number): Group {
  const group = emptyGroup(`starter-group-${story.id}`, story.title)
  group.templateId = story.id
  group.worldBookId = bookId
  group.members = members.map((c) => c.id)
  group.persona = { name: '你', description: story.player }
  group.activation_strategy = group_activation_strategy.NATURAL
  group.flow = flowFor(story)
  group.createdAt = now
  group.updatedAt = now
  group.layout = { [USER_NODE_ID]: { x: 0, y: 0 }, [members[0]!.id]: { x: -220, y: 150 }, [members[1]!.id]: { x: 0, y: 220 }, [members[2]!.id]: { x: 220, y: 150 } }
  const edges: [string, string, string, string][] = [
    [USER_NODE_ID, members[0]!.id, '同行者', story.premise],
    [members[0]!.id, USER_NODE_ID, '需要信任的人', story.player],
    [members[0]!.id, members[1]!.id, story.relations[0], '共同经历使两人相互了解。'],
    [members[1]!.id, members[0]!.id, story.relations[1], '目标相近，方法未必一致。'],
    [members[1]!.id, members[2]!.id, story.relations[2], '有一段未说尽的往事。'],
    [members[2]!.id, members[1]!.id, '知情却保留', '愿意合作，但仍有自己的顾虑。'],
    [members[2]!.id, USER_NODE_ID, '谨慎的盟友', '会根据玩家的选择调整信任。'],
  ]
  group.relations = edges.map(([from, to, label, desc], i) => ({ id: `starter-relation-${story.id}-${i}`, from, to, label, desc }))
  return group
}

/** One atomic seed. Existing rows are never overwritten, including renamed or edited templates. */
export async function ensureStarterTemplates(): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['settings', 'worldbooks', 'characters', 'groups'], 'readwrite')
  const settingStore = tx.objectStore('settings')
  const settings = await settingStore.get('app')
  if (settings && (settings.starterTemplatesVersion ?? 0) >= 1) {
    await tx.done
    return
  }
  const books = tx.objectStore('worldbooks')
  const chars = tx.objectStore('characters')
  const groups = tx.objectStore('groups')
  const now = Date.now()
  for (const story of STARTER_STORIES) {
    const book = bookFor(story, now)
    if (!(await books.get(book.id))) await books.put(book)
    const members = charactersFor(story, book.id, now)
    for (const member of members) if (!(await chars.get(member.id))) await chars.put(member)
    const group = groupFor(story, members, book.id, now)
    if (!(await groups.get(group.id))) await groups.put(group)
  }
  if (settings) {
    settings.starterTemplatesVersion = 1
    await settingStore.put(settings)
  }
  await tx.done
  useSettingsStore().settings.starterTemplatesVersion = 1
}

let coversRunning = false
const BUNDLED_COVER_VERSION = 2

const STARTER_ART: Record<string, { bg: string; accent: string; title: string }> = {
  'five-dynasties': { bg: '#241d26', accent: '#d58d5c', title: '乱世渡口' },
  'modern-city': { bg: '#142634', accent: '#67c4b8', title: '凌晨上线' },
  'xianxia-outer': { bg: '#1d2730', accent: '#c6a86a', title: '山门试炼' },
}

/** Bundled, deterministic cover art keeps starter templates useful in a fresh browser. */
function fallbackStarterCover(assetId: string): Blob {
  const [storyId, roleIndex] = assetId.split('-').length > 2
    ? [assetId.replace(/-\d+$/, ''), Number(assetId.match(/(\d+)$/)?.[1] ?? 0)]
    : [assetId, -1]
  const art = STARTER_ART[storyId] ?? STARTER_ART['modern-city']!
  const isGroup = roleIndex < 0
  const seed = Math.max(0, roleIndex)
  const cx = 450 + (seed - 1) * 220
  const labels = isGroup ? art.title : ['船娘', '账房', '郎中'][seed] ?? '同行者'
  const body = isGroup
    ? `<path d="M0 760 Q360 590 800 710 T1600 650 V1000 H0Z" fill="${art.accent}" opacity=".22"/><circle cx="1290" cy="230" r="170" fill="${art.accent}" opacity=".2"/><path d="M500 770 Q800 500 1100 770 L1050 1000 H550Z" fill="${art.accent}" opacity=".45"/><path d="M690 760 Q800 620 910 760 L870 1000 H730Z" fill="#f4d8b2" opacity=".78"/>`
    : `<circle cx="${cx}" cy="360" r="138" fill="#f0c7a4"/><path d="M${cx - 145} 360 Q${cx} 170 ${cx + 145} 360 Q${cx + 85} 275 ${cx} 290 Q${cx - 90} 275 ${cx - 145} 360Z" fill="${art.accent}"/><path d="M${cx - 210} 900 Q${cx - 180} 575 ${cx} 540 Q${cx + 180} 575 ${cx + 210} 900Z" fill="${art.accent}" opacity=".82"/><path d="M${cx - 82} 430 Q${cx} 470 ${cx + 82} 430" fill="none" stroke="#6f403c" stroke-width="12" stroke-linecap="round"/>`
  const width = isGroup ? 1600 : 900
  const height = isGroup ? 1000 : 1200
  const textX = isGroup ? 96 : 64
  return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${art.bg}"/><stop offset="1" stop-color="#0b1118"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#bg)"/>${body}<path d="M0 ${height - 150} Q${width / 3} ${height - 220} ${width * .62} ${height - 130} T${width} ${height - 170} V${height} H0Z" fill="#080d12" opacity=".72"/><text x="${textX}" y="${height - 92}" fill="#fff4df" font-family="system-ui,sans-serif" font-size="${isGroup ? 54 : 38}" font-weight="700" letter-spacing="2">${isGroup ? labels : `${art.title} · ${labels}`}</text><circle cx="${width - 74}" cy="74" r="28" fill="${art.accent}" opacity=".9"/></svg>`], { type: 'image/svg+xml' })
}

async function saveStarterCover(
  kind: 'characters' | 'groups',
  id: string,
  expectedUpdatedAt: number,
  blob: Blob,
): Promise<string | undefined> {
  const db = await getDb()
  const tx = db.transaction([kind, 'blobs', 'starter_template_images'], 'readwrite')
  const store = tx.objectStore(kind)
  const current = await store.get(id)
  const assetId = current?.templateId ?? id
  const templateAsset = await tx.objectStore('starter_template_images').get(assetId)
  const canReplaceBundled = current?.avatarBlobId && templateAsset?.source === 'bundled'
  if (!current || (current.avatarBlobId && !canReplaceBundled) || current.updatedAt !== expectedUpdatedAt) {
    await tx.done
    return undefined
  }
  await tx.objectStore('starter_template_images').put({ id: assetId, mime: blob.type, data: blob, source: 'generated', createdAt: Date.now() })
  let blobId: string | undefined
  blobId = crypto.randomUUID()
  const previousBlobId = current.avatarBlobId
  const record: BlobRecord = { id: blobId, mime: blob.type, size: blob.size, data: blob, createdAt: Date.now() }
  current.avatarBlobId = blobId
  current.updatedAt = Date.now()
  await tx.objectStore('blobs').put(record)
  if (previousBlobId && previousBlobId !== blobId) await tx.objectStore('blobs').delete(previousBlobId)
  await store.put(current)
  await tx.done
  return blobId
}

/** Real generated cover art shipped with the app for fresh browsers. */
async function loadBundledStarterCover(assetId: string): Promise<Blob | undefined> {
  for (const extension of ['jpg', 'png']) {
    const response = await fetch(`/starter-templates/${assetId}.${extension}`)
    if (!response.ok) continue
    const data = await response.blob()
    if (data.type.startsWith('image/')) return data
  }
  return undefined
}

async function restoreStarterCover(kind: 'characters' | 'groups', id: string): Promise<string | undefined> {
  const db = await getDb()
  const readTx = db.transaction([kind, 'blobs', 'starter_template_images'])
  const current = await readTx.objectStore(kind).get(id)
  const assetId = current?.templateId ?? id
  let image = await readTx.objectStore('starter_template_images').get(assetId)
  const previous = current?.avatarBlobId ? await readTx.objectStore('blobs').get(current.avatarBlobId) : undefined
  await readTx.done
  if (!current) return undefined
  if (current.avatarBlobId) {
    if (image?.source === 'bundled' && image.bundledVersion !== BUNDLED_COVER_VERSION && current.updatedAt === current.createdAt) {
      const data = await loadBundledStarterCover(assetId)
      if (!data) return undefined
      const tx = db.transaction([kind, 'blobs', 'starter_template_images'], 'readwrite')
      const latest = await tx.objectStore(kind).get(id)
      const latestImage = await tx.objectStore('starter_template_images').get(assetId)
      if (!latest || latest.avatarBlobId !== current.avatarBlobId || latest.updatedAt !== current.updatedAt || latestImage?.source !== 'bundled') {
        await tx.done
        return undefined
      }
      const blobId = crypto.randomUUID()
      await tx.objectStore('starter_template_images').put({ id: assetId, data, mime: data.type, source: 'bundled', bundledVersion: BUNDLED_COVER_VERSION, createdAt: Date.now() })
      await tx.objectStore('blobs').put({ id: blobId, data, mime: data.type, size: data.size, createdAt: Date.now() })
      await tx.objectStore('blobs').delete(current.avatarBlobId)
      latest.avatarBlobId = blobId
      await tx.objectStore(kind).put(latest)
      await tx.done
      return blobId
    }
    if (current.updatedAt === current.createdAt && previous?.mime === 'image/svg+xml') {
      const data = await loadBundledStarterCover(assetId)
      if (!data) return undefined
      const tx = db.transaction([kind, 'blobs', 'starter_template_images'], 'readwrite')
      const latest = await tx.objectStore(kind).get(id)
      if (!latest || latest.avatarBlobId !== current.avatarBlobId || latest.updatedAt !== current.updatedAt) { await tx.done; return undefined }
      const blobId = crypto.randomUUID()
      await tx.objectStore('starter_template_images').put({ id: assetId, data, mime: data.type, source: 'bundled', bundledVersion: BUNDLED_COVER_VERSION, createdAt: Date.now() })
      await tx.objectStore('blobs').put({ id: blobId, data, mime: data.type, size: data.size, createdAt: Date.now() })
      await tx.objectStore('blobs').delete(current.avatarBlobId)
      latest.avatarBlobId = blobId
      await tx.objectStore(kind).put(latest)
      await tx.done
      return blobId
    }
    // Existing starter images become reusable template assets after upgrading older databases.
    if (!image && previous) {
      const tx = db.transaction('starter_template_images', 'readwrite')
      await tx.objectStore('starter_template_images').put({ id: assetId, data: previous.data, mime: previous.mime, source: 'generated', createdAt: Date.now() })
      await tx.done
    }
    return undefined
  }
  // A modified row may have had its image deliberately removed; leave that choice intact.
  if (!image && current.updatedAt === current.createdAt) {
    const data = await loadBundledStarterCover(assetId)
    if (!data) return undefined
    image = { id: assetId, data, mime: data.type, source: 'bundled', bundledVersion: BUNDLED_COVER_VERSION, createdAt: Date.now() }
  }
  if (!image || current.updatedAt !== current.createdAt) return undefined
  const tx = db.transaction([kind, 'blobs', 'starter_template_images'], 'readwrite')
  const latest = await tx.objectStore(kind).get(id)
  if (!latest || latest.avatarBlobId || latest.updatedAt !== current.updatedAt) { await tx.done; return undefined }
  await tx.objectStore('starter_template_images').put(image)
  const blobId = crypto.randomUUID()
  await tx.objectStore('blobs').put({ id: blobId, data: image.data, mime: image.mime, size: image.data.size, createdAt: Date.now() })
  latest.avatarBlobId = blobId
  await tx.objectStore(kind).put(latest)
  await tx.done
  return blobId
}

async function starterCoverIsBundled(kind: 'characters' | 'groups', id: string): Promise<boolean> {
  const db = await getDb()
  const tx = db.transaction([kind, 'starter_template_images'])
  const current = await tx.objectStore(kind).get(id)
  const assetId = current?.templateId ?? id
  const asset = await tx.objectStore('starter_template_images').get(assetId)
  await tx.done
  return asset?.source === 'bundled'
}

/** Restore reusable template images before checking whether image generation is configured. */
export async function restoreStarterTemplateCovers(): Promise<void> {
  const chars = useCharactersStore()
  const groups = useGroupsStore()
  for (const story of STARTER_STORIES) {
    for (const char of chars.items.filter((c) => c.templateId?.startsWith(`${story.id}-`))) {
      const blobId = await restoreStarterCover('characters', char.id)
      if (blobId) char.avatarBlobId = blobId
    }
    const group = groups.items.find((g) => g.templateId === story.id)
    if (group) {
      const blobId = await restoreStarterCover('groups', group.id)
      if (blobId) group.avatarBlobId = blobId
    }
  }
}

/** Run after stores load; failed requests leave text templates available and retry next launch. */
export async function generateStarterCovers(): Promise<void> {
  if (coversRunning) return
  await restoreStarterTemplateCovers()
  const settings = useSettingsStore()
  const service = settings.activeImageService
  if (!service) return
  coversRunning = true
  try {
    const apiKey = await settings.getApiKey(service.secretRef)
    const chars = useCharactersStore()
    const groups = useGroupsStore()
    for (const story of STARTER_STORIES) {
      for (const char of chars.items.filter((c) => c.templateId?.startsWith(`${story.id}-`))) {
        const restored = await restoreStarterCover('characters', char.id)
        if (restored) {
          const current = chars.byId(char.id)
          if (current && !current.avatarBlobId) current.avatarBlobId = restored
        }
        if (char.avatarBlobId && (!(await starterCoverIsBundled('characters', char.id)) || char.updatedAt !== char.createdAt)) continue
        try {
          const image = await generateImage({ service, apiKey, prompt: characterImagePrompt(char.data), signal: new AbortController().signal })
          const blobId = await saveStarterCover('characters', char.id, char.updatedAt, image.blob)
          const current = chars.byId(char.id)
          if (blobId && current && current.updatedAt === char.updatedAt) {
            current.avatarBlobId = blobId
            current.updatedAt = Date.now()
          }
        } catch (error) { console.warn('Starter character cover generation failed', error); return }
      }
      const group = groups.items.find((g) => g.templateId === story.id)
      if (!group) continue
      const restored = await restoreStarterCover('groups', group.id)
      if (restored) {
        const current = groups.byId(group.id)
        if (current && !current.avatarBlobId) current.avatarBlobId = restored
      }
      if (group.avatarBlobId && (!(await starterCoverIsBundled('groups', group.id)) || group.updatedAt !== group.createdAt)) continue
      try {
        const image = await generateImage({ service, apiKey, prompt: story.cover, size: service.backend === 'comfyui' ? undefined : '1536x1024', signal: new AbortController().signal })
        const blobId = await saveStarterCover('groups', group.id, group.updatedAt, image.blob)
        const current = groups.byId(group.id)
        if (blobId && current && current.updatedAt === group.updatedAt) {
          current.avatarBlobId = blobId
          current.updatedAt = Date.now()
        }
      } catch (error) { console.warn('Starter group cover generation failed', error); return }
    }
  } finally { coversRunning = false }
}
