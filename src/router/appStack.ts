import type { RouteLocationRaw, Router } from 'vue-router'
import { layersSettled, popAllLayers } from '@/composables/useBackClose'
import { depthOf } from '@/composables/useRouteTransition'
import { homeName, homePath } from './layout'

/**
 * 应用级导航栈：让历史记录长成常规手机 App 的形状，而不是「点过哪儿就叠一层」。
 *
 * 目标形状永远是：
 *
 *     [首页(某个会话)] → [某个分区] → [详情] → [更深的详情] …
 *
 * - **首页**：手机 = 角色页，桌面 = 聊天页（router/layout）。在首页按返回 = 退出 App
 *   （安卓壳里 WebView 退无可退就结束 Activity）。
 * - **分区**：层级为 0 的页面（手机底部标签栏的五项；桌面侧栏各分区），彼此平级。
 *   从任何地方（包括某个分区的详情页里）切到分区，都先退回首页那一格，再压入该分区；
 *   所以分区页按返回一定回首页，不会在分区之间来回倒。切到首页本身（桌面上切会话）则直接退到栈底替换。
 * - **详情页**：正常下钻压栈；同一种详情之间平级切换（另一个角色、另一个会话、世界书里另一条词条）
 *   用替换。手机上聊天 / 设置也属于这一类（meta.mobileDepth）。
 * - **跳到栈里已有的页面**（详情页的「返回」按钮、保存后回列表写的都是 push('/列表')）：
 *   直接退回到那一格，而不是再压一份，杜绝「列表→详情→列表→详情」的反复嵌套。
 *
 * ## 实现
 * vue-router 在 history.state.position 里记着每条历史的序号，这里按序号镜像一份「每格是哪个页面」。
 * 「退回某格再换成目标」用 history.go(-n) + 在那次 popstate 导航的 beforeEach 里重定向到目标：
 * 重定向发生在解析组件之前，中间那一格**不会被渲染**，看起来就是一次普通跳转（过渡动画也照常）。
 * 只接管 router.push；显式的 router.replace 保持原意。浮层（抽屉、弹窗页）的历史条目先整体弹掉，
 * 保证序号按「页面」算（见 useBackClose.popAllLayers）。
 */

const STORE_KEY = 'cbxAppStack'
const LAND_TIMEOUT = 1500

/** 首页那一格的历史序号 */
let root = -1
/** 下标 = 历史序号，值 = 该格页面的 fullPath（不知道时为 null） */
let entries: (string | null)[] = []
/** 从 sessionStorage 恢复的镜像，要在第一次导航落地时核对 */
let restored = false
/** 下一次「退回第 at 格」的 popstate 导航要被重定向到哪里 */
let redirect: { at: number; to: string; replace: boolean } | null = null

function position(): number {
  const p = (history.state as { position?: unknown } | null)?.position
  return typeof p === 'number' ? p : 0
}

function load() {
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    if (!raw) return
    const v = JSON.parse(raw) as { root?: unknown; entries?: unknown }
    if (typeof v.root === 'number' && Array.isArray(v.entries)) {
      root = v.root
      entries = v.entries.map((e) => (typeof e === 'string' ? e : null))
      restored = true
    }
  } catch {
    /* 隐私模式等拿不到存储：从当前页重新开始记 */
  }
}

function save() {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify({ root, entries }))
  } catch {
    /* 同上 */
  }
}

let appBack: () => void = () => history.back()

/** 页面上的「返回」箭头：与系统返回键同一效果，栈底时回首页而不是退出 */
export function goBack(): void {
  appBack()
}

export function installAppStack(router: Router) {
  // 已被 useBackClose 包过一层（浮层开着时 push 改 replace 等），这里再包在外面
  const push = router.push.bind(router)
  const replace = router.replace.bind(router)
  load()

  const isHome = (fullPath: string | null) =>
    !!fullPath && router.resolve(fullPath).name === homeName()

  /** 等下一次落在 fullPath 上的导航完成（或失败）；兜底超时，不让调用方永远挂着 */
  function landed(fullPath: string): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        off()
        clearTimeout(timer)
        resolve()
      }
      const off = router.afterEach((to, _from, failure) => {
        if (failure || to.fullPath === fullPath) done()
      })
      const timer = setTimeout(done, LAND_TIMEOUT)
    })
  }

  /** 退回到第 at 格；给了 then 就在那次导航里直接换成 then（中间页不渲染） */
  async function backTo(at: number, then?: { to: string; replace: boolean }) {
    const wait = landed(then?.to ?? entries[at] ?? '')
    redirect = then ? { at, ...then } : null
    router.go(at - position())
    await wait
  }

  router.beforeEach((to) => {
    const r = redirect
    if (!r || position() !== r.at) return
    redirect = null
    if (to.fullPath === r.to) return
    const loc = router.resolve(r.to)
    return { path: loc.path, query: loc.query, hash: loc.hash, replace: r.replace }
  })

  router.afterEach((to, _from, failure) => {
    if (failure) return
    const p = position()
    if (restored) {
      restored = false
      // 刷新后镜像对不上（换了标签页 / 手动改了地址）：从当前页重新开始记
      if (entries[p] !== to.fullPath) {
        root = p
        entries = []
      }
    }
    if (root < 0 || p < root) root = p
    entries = entries.slice(0, p)
    while (entries.length < p) entries.push(null)
    entries[p] = to.fullPath
    save()
  })

  appBack = () => {
    // 栈里下面还有本应用的页面就退一格；已在栈底（冷启动直接进的二级页）就回首页
    if (root >= 0 && position() > root) router.back()
    else void router.push(homePath())
  }

  router.push = async (raw: RouteLocationRaw) => {
    // 与 useBackClose 的包装同理：先让「关浮层再跳转」写法里的 back() 登记并落地
    await Promise.resolve()
    await layersSettled()
    const target = router.resolve(raw)
    const current = router.currentRoute.value
    // 同址 / 还没开始记（首次导航）：交给原逻辑
    if (target.fullPath === current.fullPath || root < 0) return push(raw)

    await popAllLayers()
    const p = position()

    // ① 目标就在栈里下面某格：退回去，不再压一份
    const k = entries.lastIndexOf(target.fullPath)
    if (k >= root && k < p) return backTo(k)

    // ② 顶层页（首页 / 分区）
    if (depthOf(target) === 0) {
      // 目标就是首页；或首页那格其实不是首页（从别的页冷启动），都直接让位
      const replaceRoot = target.name === homeName() || !isHome(entries[root] ?? null)
      if (p === root) return replaceRoot ? replace(raw) : push(raw)
      // 已经是 [首页, 某分区]：分区之间平级切换，直接替换
      if (!replaceRoot && p === root + 1) return replace(raw)
      return backTo(root, { to: target.fullPath, replace: replaceRoot })
    }

    // ③ 详情页：同类详情之间平级切换（另一个角色、另一本世界书）用替换，只有往深处走才压栈
    if (target.name === current.name && depthOf(target) <= depthOf(current)) return replace(raw)
    return push(raw)
  }
}
