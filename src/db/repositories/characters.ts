import { getDb, chatRange } from '../schema'
import { toPlain } from '../plain'
import { emptyCharacter, type Character } from '@/types/character'

export async function list(): Promise<Character[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('characters', 'by_updatedAt')
  return rows.reverse()
}

export async function get(id: string): Promise<Character | undefined> {
  const db = await getDb()
  return db.get('characters', id)
}

export async function getMany(ids: string[]): Promise<Character[]> {
  const db = await getDb()
  const tx = db.transaction('characters')
  const out: Character[] = []
  for (const id of ids) {
    const c = await tx.store.get(id)
    if (c) out.push(c)
  }
  await tx.done
  return out
}

export async function create(name = '新角色'): Promise<Character> {
  const c = emptyCharacter(crypto.randomUUID(), name)
  const db = await getDb()
  await db.put('characters', toPlain(c))
  return c
}

/** 自动 stamp updatedAt 与 favIdx（IDB 不索引 boolean） */
export async function save(c: Character): Promise<Character> {
  c.updatedAt = Date.now()
  c.favIdx = c.fav ? 1 : 0
  const db = await getDb()
  await db.put('characters', toPlain(c))
  return c
}

export async function toggleFav(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction('characters', 'readwrite')
  const c = await tx.store.get(id)
  if (c) {
    c.fav = !c.fav
    c.favIdx = c.fav ? 1 : 0
    c.updatedAt = Date.now()
    await tx.store.put(toPlain(c))
  }
  await tx.done
}

export async function count(): Promise<number> {
  const db = await getDb()
  return db.count('characters')
}

/**
 * 删除角色。必须在一个跨 store 事务里，否则中途失败会留下孤儿数据：
 * 头像 blob、该角色的全部会话与消息、群聊中的成员引用与关系边。
 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(
    ['characters', 'blobs', 'chats', 'messages', 'groups', 'rpgworlds'],
    'readwrite',
  )

  const c = await tx.objectStore('characters').get(id)
  if (c?.avatarBlobId) await tx.objectStore('blobs').delete(c.avatarBlobId)
  // 深度图也是这个角色的，一起收掉 —— 漏掉就是一张永远不会再被引用的孤儿图片
  if (c?.depthBlobId) await tx.objectStore('blobs').delete(c.depthBlobId)

  const chatStore = tx.objectStore('chats')
  const chatIds = await chatStore.index('by_characterId').getAllKeys(id)
  const msgStore = tx.objectStore('messages')
  for (const cid of chatIds) {
    await msgStore.delete(chatRange(cid))
    await chatStore.delete(cid)
  }

  const gStore = tx.objectStore('groups')
  const groups = await gStore.getAll()
  for (const g of groups) {
    if (!g.members.includes(id)) continue
    g.members = g.members.filter((m) => m !== id)
    g.disabled_members = g.disabled_members.filter((m) => m !== id)
    g.relations = g.relations.filter((r) => r.from !== id && r.to !== id)
    delete g.layout[id]
    g.updatedAt = Date.now()
    await gStore.put(toPlain(g))
  }

  /**
   * RPG 世界里引用了这张卡的 NPC。
   *
   * 不能只是把 characterId 清掉就完事：`resolveNpc` 在查不到卡时会回落到
   * `npc.name || '无名者'`，删掉一张卡，世界里那个 NPC 就**静默换了身份**，
   * 站位还在、人没了，而且不报任何错。
   *
   * 所以解绑前先把卡上的名字与简介**落进 NPC 自己的字段**：NPC 留在原地、
   * 还是那个人，只是从此不再跟着卡走。
   *
   * ⚠️ 必须**卡优先**，不能写成 `npc.name || c?.data.name`。关联型 NPC 的
   * name 不是空的 —— addNpc 一律播种字面量「新 NPC」(stores/rpg.ts)，而
   * NpcEditor 在关联期间把名字输入框整个藏了，这个占位符**永远没机会被清掉**。
   * 写成 npc 优先的话，解绑后名字停在「新 NPC」、简介却是那张卡的正文，
   * 提示词里会同时出现「姓名：陆雪琪」和「你正在扮演 新 NPC」两个矛盾身份。
   * 关联期间生效的本来就是卡上的值，玩家认识的也是那个人，所以以卡为准。
   */
  const wStore = tx.objectStore('rpgworlds')
  for (const w of await wStore.getAll()) {
    let touched = false
    for (const npc of w.npcs) {
      if (npc.characterId !== id) continue
      npc.name = c?.data.name || npc.name || '无名者'
      npc.description = c?.data.description || npc.description || ''
      delete npc.characterId
      touched = true
    }
    if (!touched) continue
    w.updatedAt = Date.now()
    await wStore.put(toPlain(w))
  }

  await tx.objectStore('characters').delete(id)
  await tx.done
}
