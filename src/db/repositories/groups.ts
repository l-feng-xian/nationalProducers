import { getDb, chatRange } from '../schema'
import { emptyGroup, type Group, type GroupRelation, type GroupNodeLayout } from '@/types/group'

export async function list(): Promise<Group[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('groups', 'by_updatedAt')
  return rows.reverse()
}

export async function get(id: string): Promise<Group | undefined> {
  const db = await getDb()
  return db.get('groups', id)
}

export async function create(name = '新群聊'): Promise<Group> {
  const g = emptyGroup(crypto.randomUUID(), name)
  const db = await getDb()
  await db.put('groups', g)
  return g
}

export async function save(g: Group): Promise<void> {
  g.updatedAt = Date.now()
  const db = await getDb()
  await db.put('groups', g)
}

async function mutate(id: string, fn: (g: Group) => void): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('groups', 'readwrite')
  const g = await tx.store.get(id)
  if (g) {
    fn(g)
    g.updatedAt = Date.now()
    await tx.store.put(g)
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

/** 删群聊同时删其全部会话与消息 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['groups', 'chats', 'messages', 'blobs'], 'readwrite')
  const g = await tx.objectStore('groups').get(id)
  if (g?.avatarBlobId) await tx.objectStore('blobs').delete(g.avatarBlobId)

  const chatStore = tx.objectStore('chats')
  const msgStore = tx.objectStore('messages')
  const chatIds = await chatStore.index('by_groupId').getAllKeys(id)
  for (const cid of chatIds) {
    await msgStore.delete(chatRange(cid))
    await chatStore.delete(cid)
  }
  await tx.objectStore('groups').delete(id)
  await tx.done
}
