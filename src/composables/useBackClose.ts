import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue'
import type { Router } from 'vue-router'

/**
 * 「返回键 / 手势返回 = 关闭浮层」。
 *
 * 手机上用户关抽屉、关图片预览、关底部菜单的第一反应是**返回**，而不是去找右上角的 X。
 * 不接住的话，返回会直接把整页退掉（安卓壳里 WryActivity 把返回键翻译成 WebView.goBack()）。
 *
 * 做法：浮层打开时 pushState 一条**同 URL** 的历史，state 里记着浮层 id 栈（`cbxLayers`）；
 * 返回弹出这条历史 → popstate → 关掉不在新栈里的浮层。浮层被 UI 关掉（点 X / 点遮罩）时，
 * 若那条历史还在栈顶，就自己 history.back() 把它吃掉，不留下「按一次返回没反应」的空条目。
 *
 * ⚠️ 与 vue-router 的三处配合（installBackClose 里装）：
 *  1. 纯浮层的 popstate（URL 不变）由一个**先于路由注册**的监听 stopImmediatePropagation 吞掉，
 *     不让路由再跑一遍同址导航（那会取消掉正在等待的真实跳转）。
 *  2. 浮层开着时的 push 一律改 replace：抽屉里点分区 / 新建对话里选角色，会把浮层那条历史
 *     **替换**成新页面，返回直接回到打开浮层之前的页面，而不是先落到一条空浮层历史上。
 *  3. 路由 replace 会把 history.state 整个 assign 进新条目（连同我们的 cbxLayers），
 *     afterEach 里把它剥掉，否则新页面会被误认成「浮层在栈顶」。
 * 另外 history.back() 是异步的：UI 关浮层后紧接着的路由跳转必须等它落地（beforeEach 里 await），
 * 否则 back 会在 push 之后才生效，把刚 push 的新页面退掉。
 */

const KEY = 'cbxLayers'

interface Layer {
  id: string
  close: () => void
  /** 历史条目是否已压栈。等上一个浮层的 back() 落地期间为 false，popstate 不能把它当成被弹掉 */
  pushed: boolean
}

/** 当前打开且登记了历史的浮层，按打开顺序 */
const stack: Layer[] = []
let seq = 0
/** 上一次已知的地址，用来判断一次 popstate 是「纯浮层」还是真的换了页 */
let lastHref = typeof location === 'undefined' ? '' : location.href
let pending: Promise<void> | null = null
let settle: (() => void) | null = null
let installed = false

function layersIn(state: unknown): string[] {
  const v = (state as Record<string, unknown> | null)?.[KEY]
  return Array.isArray(v) ? (v as string[]) : []
}

/** 历史栈顶那条是不是浮层条目 */
export function layerOnTop(): boolean {
  return layersIn(history.state).length > 0
}

/** 等待 UI 关浮层触发的 history.back() 落地 */
export function layersSettled(): Promise<void> {
  return pending ?? Promise.resolve()
}

/**
 * 一次性弹掉栈顶所有浮层历史（顺带关掉这些浮层），等落地后再返回。
 * 页面级导航（appStack）要按「页面」算历史位置，先把浮层条目清干净。
 */
export async function popAllLayers(): Promise<void> {
  await layersSettled()
  const n = layersIn(history.state).length
  if (!n) return
  pending = new Promise<void>((resolve) => {
    settle = resolve
    setTimeout(() => {
      if (settle === resolve) {
        settle = null
        pending = null
        resolve()
      }
    }, 600)
  })
  history.go(-n)
  await pending
}

function onPopState(e: PopStateEvent) {
  const ids = layersIn(e.state)
  const sameUrl = location.href === lastHref
  // 从顶往下关：不在新栈里的都是被这次返回弹掉的
  for (let i = stack.length - 1; i >= 0; i--) {
    const layer = stack[i]!
    if (layer.pushed && !ids.includes(layer.id)) {
      stack.splice(i, 1)
      layer.close()
    }
  }
  settle?.()
  settle = null
  pending = null
  lastHref = location.href
  if (sameUrl) e.stopImmediatePropagation()
}

/**
 * ⚠️ 必须在**模块求值时**就注册，不能等 installBackClose。
 * window 上的监听按注册顺序触发（实测 Chrome 下捕获阶段也不会插队），
 * 而 vue-router 在 createWebHistory() 时就挂好了自己的 popstate 监听。
 * 晚于它注册的话，路由会先对浮层自己的 back() 跑一次同址导航，
 * 把正在等待的 router.replace 取消掉（NavigationFailure cancelled，实测抽屉里「角色→群聊」点了不跳）。
 * router/index.ts 在 createRouter 之前 import 本模块，保证这里先注册。
 */
if (typeof window !== 'undefined') window.addEventListener('popstate', onPopState, true)

function stripState() {
  if (!(KEY in ((history.state as object | null) ?? {}))) return
  const { [KEY]: _drop, ...rest } = history.state as Record<string, unknown>
  history.replaceState(rest, '')
}

export function installBackClose(router: Router) {
  if (installed) return
  installed = true

  const push = router.push.bind(router)
  // 先等 UI 关浮层触发的 back() 落地再判断：否则栈顶还是那条将被弹掉的浮层历史，
  // push 会被误改成 replace，把浮层底下那条真正的页面历史替换掉
  router.push = async (to) => {
    // 让出一个微任务：同一轮里先关浮层、后 push 的写法（close(); router.push()），
    // 关浮层的卸载 / release 在 Vue 的 flush 里才发生，要等它登记上 pending 再判断
    await Promise.resolve()
    await layersSettled()
    return layerOnTop() ? router.replace(to) : push(to)
  }
  router.beforeEach(() => layersSettled())
  router.afterEach(() => {
    stripState()
    lastHref = location.href
  })
}

function open(close: () => void): string {
  const id = `l${++seq}`
  const layer: Layer = { id, close, pushed: false }
  stack.push(layer)
  const doPush = () => {
    // 等待期间已经被 UI 关掉了，就不必再压
    if (!stack.includes(layer)) return
    history.pushState(
      { ...(history.state as object | null), [KEY]: [...layersIn(history.state), id] },
      '',
    )
    layer.pushed = true
    lastHref = location.href
  }
  // ⚠️ 上一个浮层的 back() 还没落地时不能立刻 pushState：back 是按「当时的当前条目」回退的，
  // 会把刚压进去的这条弹掉，新浮层一打开就被关（实测：抽屉里点「新建对话」，面板闪一下就没了）
  if (pending) void pending.then(doPush)
  else doPush()
  return id
}

/** UI 侧关闭：浮层条目还在栈顶就吃掉它 */
function release(id: string) {
  const i = stack.findIndex((l) => l.id === id)
  if (i < 0) return
  const [layer] = stack.splice(i, 1)
  if (!layer?.pushed) return
  const ids = layersIn(history.state)
  if (ids[ids.length - 1] !== id) return
  pending = new Promise<void>((resolve) => {
    settle = resolve
    // popstate 万一不来（极少数壳子），别让路由永远卡在 beforeEach 上
    setTimeout(() => {
      if (settle === resolve) {
        settle = null
        pending = null
        resolve()
      }
    }, 600)
  })
  history.back()
}

/**
 * 让一个浮层响应返回键。
 * - 传 `isOpen`：浮层常驻组件、靠布尔值开合（抽屉、长按菜单）；
 * - 不传：组件挂载即打开、卸载即关闭（v-if 控制的弹窗）。
 * `enabled` 为假时不登记历史（例如桌面宽屏下侧栏不是抽屉）。
 */
export function useBackClose(
  close: () => void,
  isOpen?: Ref<boolean> | (() => boolean),
  enabled: () => boolean = () => true,
) {
  let id: string | null = null

  function attach() {
    if (id || !enabled()) return
    id = open(() => {
      id = null
      close()
    })
  }
  function detach() {
    if (!id) return
    const current = id
    id = null
    release(current)
  }

  if (isOpen) {
    // sync：状态一变就登记 / 吃掉历史，紧跟着的 router.push 才看得到 pending
    watch(isOpen, (v) => (v ? attach() : detach()), { immediate: true, flush: 'sync' })
    onBeforeUnmount(detach)
  } else {
    onMounted(attach)
    onBeforeUnmount(detach)
  }
}
