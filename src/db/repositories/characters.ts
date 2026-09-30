import { getDb, chatRange } from '../schema'
import { toPlain } from '../plain'
import { pruneUnreferenced } from './blobs'
import { emptyCharacter, type Character } from '@/types/character'

/**
 * 补齐可能缺失的字段。**所有读取路径都必须过这里**（与 groups.ts 同一套路）。
 *
 * 这个 store 原先一个 normalize 都没有，而 `worldBookIds` 是裸取的：
 * 角色编辑页渲染时 `c.worldBookIds.includes(...)`，删世界书时也逐张卡这么问。
 * 导入的备份可能没有这个字段（applyBackup 是零校验原样回写），
 * 于是「打开某张卡就白屏」「删任何世界书都失败」，而两者看上去毫不相干。
 */
function normalize(c: Character): Character {
  if (!Array.isArray(c.worldBookIds)) c.worldBookIds = []
  return c
}

export async function list(): Promise<Character[]> {
  const db = await getDb()
  const rows = await db.getAllFromIndex('characters', 'by_updatedAt')
  return rows.reverse().map(normalize)
}

export async function get(id: string): Promise<Character | undefined> {
  const db = await getDb()
  const c = await db.get('characters', id)
  return c ? normalize(c) : undefined
}

export async function getMany(ids: string[]): Promise<Character[]> {
  const db = await getDb()
  const tx = db.transaction('characters')
  const out: Character[] = []
  for (const id of ids) {
    const c = await tx.store.get(id)
    if (c) out.push(normalize(c))
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
 * 头像 blob、该角色的全部会话与消息、演绎中的成员引用与关系边。
 */
export async function remove(id: string): Promise<void> {
  const db = await getDb()
  const tx = db.transaction(['characters', 'blobs', 'chats', 'messages', 'groups'], 'readwrite')

  const c = await tx.objectStore('characters').get(id)
  if (c?.avatarBlobId) await tx.objectStore('blobs').delete(c.avatarBlobId)
  // 深度图也是这个角色的，一起收掉 —— 漏掉就是一张永远不会再被引用的孤儿图片
  if (c?.depthBlobId) await tx.objectStore('blobs').delete(c.depthBlobId)

  const chatStore = tx.objectStore('chats')
  const chatIds = await chatStore.index('by_characterId').getAllKeys(id)
  const msgStore = tx.objectStore('messages')
  // 删这些会话的消息前先收集其配图（images[].blobId + force_avatar）。删掉会话后
  // 这些图就再也数不到了 —— 只删头像/深度图会漏掉会话里生成的配图，留下孤儿。
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

  /**
   * ⚠️ 级联清理是**裸读别的 store**的，拿到的行没经过那个仓储的 normalize ——
   * normalize 挂在读路径（list/get）上，而事务里只能直接开 objectStore。
   *
   * 所以这里每一个跨库字段都必须自己防一手。少防一个的后果极其难查：
   * 字段缺失会在**事务内**抛出，事务连同前面已排队的删除一起翻车，
   * 而调用方（CharacterEditView）只是 await 之后 toast + 跳转 —— 抛了就什么都不做。
   * 用户看到的是「确认框关掉了，然后毫无反应」，删**任何**角色都如此，
   * 而真正的原因在一个完全无关的 store 的某一行里。
   */
  const gStore = tx.objectStore('groups')
  const groups = await gStore.getAll()
  for (const g of groups) {
    if (!Array.isArray(g.members) || !g.members.includes(id)) continue
    g.members = g.members.filter((m) => m !== id)
    g.disabled_members = Array.isArray(g.disabled_members)
      ? g.disabled_members.filter((m) => m !== id)
      : []
    g.relations = Array.isArray(g.relations)
      ? g.relations.filter((r) => r.from !== id && r.to !== id)
      : []
    if (g.layout && typeof g.layout === 'object') delete g.layout[id]
    g.updatedAt = Date.now()
    await gStore.put(toPlain(g))
  }

  await tx.objectStore('characters').delete(id)
  await tx.done
  // 会话已删除，回收「删完后全库无人再引用」的配图（分支共享的图交给它比对，不误删）
  await pruneUnreferenced(imageBlobs)
}
