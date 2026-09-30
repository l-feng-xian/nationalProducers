import { getDb, chatRange } from '../schema'
import { toPlain } from '../plain'
import { pruneUnreferenced } from './blobs'
import { emptyGroup, type Group, type GroupRelation, type GroupNodeLayout } from '@/types/group'

/**
 * 补齐新增字段。**所有读取路径都必须过这里。**
 *
 * 库里是历史记录，不会因为类型加了字段就自动长出来。persona 是个对象，
 * 老记录里它是 undefined —— 模板里读 `g.persona.name` 会直接抛错，
 * 表现是「老演绎一打开就白屏」。这个坑在 settings.memory.vector 上踩过一次。
 * 这里只补不写回：下次 save 时自然落盘，不为读操作制造一次写事务。
 */
function normalize(g: Group): Group {
  if (!g.persona) g.persona = { name: '', description: '' }
  // persona 之外的这四个同样是裸取的：members/disabled_members/relations 在演绎页、
  // 提示词组装、关系图谱里一共被解引用近十处，layout 还会被 `delete layout[id]`。
  // 导入的备份可能缺任意一个（applyBackup 是零校验原样回写）
  if (!Array.isArray(g.members)) g.members = []
  if (!Array.isArray(g.disabled_members)) g.disabled_members = []
  if (!Array.isArray(g.relations)) g.relations = []
  if (!g.layout || typeof g.layout !== 'object') g.layout = {}
  return g
}

export async function list(): Promise<Group[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('groups', 'by_updatedAt')
  return rows.reverse().map(normalize)
}

export async function get(id: string): Promise<Group | undefined> {
  const db = await getDb()
  const g = await db.get('groups', id)
  return g ? normalize(g) : undefined
}

export async function create(name = '新演绎'): Promise<Group> {
  const g = emptyGroup(crypto.randomUUID(), name)
  const db = await getDb()
  await db.put('groups', toPlain(g))
  return g
}

export async function save(g: Group): Promise<void> {
  g.updatedAt = Date.now()
  const db = await getDb()
  await db.put('groups', toPlain(g))
}

async function mutate(id: string, fn: (g: Group) => void): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('groups', 'readwrite')
  const g = await tx.store.get(id)
  if (g) {
    fn(g)
    g.updatedAt = Date.now()
    await tx.store.put(toPlain(g))
  }
  await tx.done
}

export async function addMember(groupId: string, characterId: string): Promise<void> {
  await mutate(groupId, (g) => {
    if (!g.members.includes(characterId)) g.members.push(characterId)
  })
}

export async function removeMember(groupId: string, characterId: string): Promise<void> {
  await mutate(groupId, (g) => {
    g.members = g.members.filter((m) => m !== characterId)
    g.disabled_members = g.disabled_members.filter((m) => m !== characterId)
    // 成员移除时同时删掉它的所有关系边与坐标，否则图谱会渲染悬空节点
    g.relations = g.relations.filter((r) => r.from !== characterId && r.to !== characterId)
    delete g.layout[characterId]
  })
}

export async function reorderMembers(groupId: string, members: string[]): Promise<void> {
  await mutate(groupId, (g) => {
    g.members = members
  })
}

export async function toggleMute(groupId: string, characterId: string): Promise<void> {
  await mutate(groupId, (g) => {
    g.disabled_members = g.disabled_members.includes(characterId)
      ? g.disabled_members.filter((m) => m !== characterId)
      : [...g.disabled_members, characterId]
  })
}

export async function upsertRelation(groupId: string, r: GroupRelation): Promise<void> {
  await mutate(groupId, (g) => {
    const i = g.relations.findIndex((x) => x.id === r.id)
    if (i >= 0) g.relations.splice(i, 1, r)
    else g.relations.push(r)
  })
}

export async function removeRelation(groupId: string, relationId: string): Promise<void> {
  await mutate(groupId, (g) => {
    g.relations = g.relations.filter((r) => r.id !== relationId)
  })
}

export async function saveLayout(
  groupId: string,
  layout: Record<string, GroupNodeLayout>,
): Promise<void> {
  await mutate(groupId, (g) => {
    g.layout = layout
  })
}

/** 删演绎同时删其全部会话与消息 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['groups', 'chats', 'messages', 'blobs'], 'readwrite')
  const g = await tx.objectStore('groups').get(id)
  if (g?.avatarBlobId) await tx.objectStore('blobs').delete(g.avatarBlobId)
  if (g?.depthBlobId) await tx.objectStore('blobs').delete(g.depthBlobId)

  const chatStore = tx.objectStore('chats')
  const msgStore = tx.objectStore('messages')
  const chatIds = await chatStore.index('by_groupId').getAllKeys(id)
  // 删会话消息前先收集配图，删掉后就数不到了 —— 只删群头像会漏掉会话里的配图
  const imageBlobs = new Set<string>()
  for (const cid of chatIds) {
    let cursor = await msgStore.openCursor(chatRange(cid))
    while (cursor) {
      const m = cursor.value
      if (m.force_avatar) imageBlobs.add(m.force_avatar)
      for (const img of m.images ?? []) if (img.blobId) imageBlobs.add(img.blobId)
      cursor = await cursor.continue()
    }
    await msgStore.delete(chatRange(cid))
    await chatStore.delete(cid)
  }
  await tx.objectStore('groups').delete(id)
  await tx.done
  // 会话已删除，回收删完后全库无人再引用的配图（分支共享的图不误删）
  await pruneUnreferenced(imageBlobs)
}
