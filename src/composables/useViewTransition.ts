/**
 * View Transitions API 的薄封装。
 *
 * 用法只有一个形状：把「会改变 DOM 的那次导航」交给 run()，
 * 它负责特性检测、无障碍、超时兜底与错误吞掉，调用方只关心业务。
 *
 * ## 为什么不用 vue-router 的全局钩子
 * 做成全局路由过渡会和 App.vue 移动端抽屉的 translateX 动画打架
 * （两个动画各自合成，抽屉会被整页快照冻住）。所以只在角色卡这一次
 * 交互上显式调用。
 *
 * ## 三条容易写错的地方（都已实测）
 * 1. **不能写 `if (document.startViewTransition)`** —— 本项目 TS 的 DOM lib
 *    把它标成必定存在，这句会以 TS2774 编译失败
 *    （`This condition will always return true`）。必须用 `in` 判断。
 * 2. **不要用对象形式 `startViewTransition({update, types})`** —— 对象重载的
 *    支持起点比方法本身晚得多（Chrome 125 / Safari 18.2 / Firefox 147），
 *    在 Firefox 144-146 上传对象会抛 TypeError。本项目只有一种过渡，
 *    用不到 types，回调形式反而覆盖面更广。
 * 3. **`.ready` 必须 catch** —— 命名冲突时规范要求整个过渡被 skip 并让 ready
 *    以 InvalidStateError reject（DOM 更新照常生效）。不 catch 就是控制台红字。
 */

import { nextTick } from 'vue'

/**
 * 冻结上限。updateCallback 期间整页渲染是冻结的，等多久就白屏多久。
 * 正常路径只花几毫秒（导航 + 一次 nextTick），这个预算是给弱网下
 * 懒加载 chunk 没预热到的极端情况兜底的。
 */
const FREEZE_BUDGET_MS = 260

export interface ViewTransitionRunner {
  /** 当前浏览器是否支持（可用于决定要不要先做预热） */
  readonly supported: boolean
  /**
   * 用过渡包裹一次 DOM 变更。
   * 不支持 / 用户要求减少动效 / 出任何岔子时，都会**照常执行** update，
   * 只是没有动画 —— 绝不会吞掉导航。
   */
  run: (update: () => unknown) => Promise<void>
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 特性检测。写成 `in` 而不是取值判断，见文件头第 1 条 */
function isSupported(): boolean {
  return typeof document !== 'undefined' && 'startViewTransition' in document
}

/**
 * 正在进行的 View Transition 个数。路由过渡（useRouteTransition）据此让路：
 * 过渡期间渲染是冻结的，路由那边的 WAAPI 离场动画永远播不完，
 * 会把 update 回调拖过冻结预算，共享元素形变随之失效。
 */
let active = 0
export function viewTransitionActive(): boolean {
  return active > 0
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export function useViewTransition(): ViewTransitionRunner {
  const supported = isSupported()

  // update 的返回值一律忽略：router.push() 返回的是
  // Promise<void | NavigationFailure | undefined>，收窄成 Promise<void> 编译不过
  async function run(update: () => unknown): Promise<void> {
    // 不支持、或用户明确要求减少动效 → 直接执行，零动画零副作用。
    // reduced-motion 这里选择**完全跳过** startViewTransition 而不是把时长压到 0：
    // 压到 0 仍然会经历一次整页快照与合成，在低端机上依然是一次卡顿，
    // 而「减少动效」的诉求本就包含「别做这件事」。
    if (!supported || prefersReducedMotion()) {
      await update()
      return
    }

    const start = (
      document as Document & {
        startViewTransition: (cb: () => void | Promise<void>) => {
          ready: Promise<void>
          finished: Promise<void>
          updateCallbackDone: Promise<void>
          skipTransition: () => void
        }
      }
    ).startViewTransition

    active++
    const transition = start.call(document, async () => {
      // 整页在这里是冻结的：给一个硬预算，再慢也不许把 UI 冻死。
      // Promise.race 的另一边超时了也无所谓 —— update 仍在继续，
      // 只是过渡会抓一个尚未完全就绪的新状态，退化成不那么完美的动画。
      await Promise.race([
        (async () => {
          await update()
          // 只能用微任务级的 nextTick 等 Vue 把 DOM 换过来。
          // ⚠️ 千万别在这里 await requestAnimationFrame：过渡期间渲染是**冻结**的，
          //    rAF 回调根本不会触发，那个 promise 永不 resolve，于是每次过渡都要
          //    跑满下面的超时预算（实测白白冻结 277ms）。
          await nextTick()
        })(),
        timeout(FREEZE_BUDGET_MS),
      ])
    })

    // 命名冲突等情况下 ready 会 reject，但导航照常完成 —— 吞掉即可，
    // 不吞就是一条控制台红字。见文件头第 3 条。
    transition.ready.catch(() => {})

    // ⚠️ 这里必须等 finished，不能等 updateCallbackDone。
    // updateCallbackDone 在回调 settle 时就 resolve，那会儿动画**才刚开始**；
    // 调用方通常在 run() 之后清掉 view-transition-name，挂在那个时机等于
    // 在动画进行中把名字摘掉。finished 即使过渡被 skip 也照常 fulfill，
    // 不会把调用方卡住。
    try {
      await transition.finished.catch(() => {})
    } finally {
      active--
    }
  }

  return { supported, run }
}
