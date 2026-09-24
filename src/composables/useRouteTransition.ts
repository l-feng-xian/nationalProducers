import { nextTick, onBeforeUnmount } from 'vue'
import type { RouteLocationNormalized, Router } from 'vue-router'
import { viewTransitionActive } from './useViewTransition'
import { DRAWER_MQ } from './useDrawerSwipe'

/**
 * 全部路由切换的过渡：离场 → 换页 → 入场，作用在 `.main` 内容区上。
 *
 * ## 为什么不用 View Transitions / `<Transition>` 包 RouterView
 * - View Transitions 要 Chrome 111+，**安卓壳的 WebView 是 Chrome 110**，主力平台直接没有；
 *   且整页快照会把正在滑出的移动端抽屉冻住（useViewTransition 文件头有记载）。
 * - `<Transition>` 要求页面组件单根，而 ChatView 等是多根片段；并且 out-in 模式的
 *   离场要等双 rAF，会拖垮角色卡的共享元素形变（那段时间渲染是冻结的）。
 * 所以用 WAAPI 直接动 `.main`：每个平台都支持，不改任何页面结构。
 *
 * ## 三种动效（按 Material 的 shared axis / fade through）
 * - 往深一层（列表 → 编辑页）：旧页左移淡出，新页从右侧推入；
 * - 往回一层：镜像方向；
 * - 同层切换（侧栏分区、切会话）：淡出后淡入并轻微放大，不带方向。
 * 层级来自路由 meta.depth；世界书是「一页三栏」，层级按参数个数算。
 *
 * ## 让路的情况
 * - 首次进入、同址导航、用户要求减少动效；
 * - 角色卡共享元素形变进行中（viewTransitionActive）：那期间渲染冻结，离场动画播不完；
 * - 桌面宽屏下世界书只换了参数：三栏同时可见，点一条词条整页晃一下只会干扰。
 */

type Kind = 'forward' | 'back' | 'fade'

const OUT_MS = 90
const IN_MS = 210
const SHIFT = 24

const OUT: Record<Kind, Keyframe[]> = {
  forward: [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: `translateX(-${SHIFT}px)` },
  ],
  back: [
    { opacity: 1, transform: 'none' },
    { opacity: 0, transform: `translateX(${SHIFT}px)` },
  ],
  fade: [{ opacity: 1 }, { opacity: 0 }],
}
const IN: Record<Kind, Keyframe[]> = {
  forward: [
    { opacity: 0, transform: `translateX(${SHIFT}px)` },
    { opacity: 1, transform: 'none' },
  ],
  back: [
    { opacity: 0, transform: `translateX(-${SHIFT}px)` },
    { opacity: 1, transform: 'none' },
  ],
  fade: [
    { opacity: 0, transform: 'scale(0.985)' },
    { opacity: 1, transform: 'none' },
  ],
}

function depthOf(r: RouteLocationNormalized): number {
  // 一页多栏的路由：层级 = 已选中的参数个数（手机上一栏一屏，正好对应一层）
  if (r.meta.panes) return Object.values(r.params).filter((v) => !!v && v !== '').length
  return r.meta.depth ?? 0
}

function kindOf(to: RouteLocationNormalized, from: RouteLocationNormalized): Kind | null {
  if (!from.matched.length || to.fullPath === from.fullPath) return null
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null
  if (viewTransitionActive()) return null
  if (to.name === from.name && to.meta.panes && !window.matchMedia(DRAWER_MQ).matches) return null
  const d = depthOf(to) - depthOf(from)
  return d > 0 ? 'forward' : d < 0 ? 'back' : 'fade'
}

export function useRouteTransition(router: Router, main: () => HTMLElement | null) {
  /**
   * 每次导航一个令牌。连点时旧导航会被取消，但它的 afterEach 仍会晚到：
   * 只有「最新那次」导航才能碰动画，否则旧导航的收尾会把新导航的离场动画撤掉。
   * beforeEach 与 afterEach 拿到的是同一个 `to` 对象，用它当键。
   */
  let token = 0
  const navs = new WeakMap<RouteLocationNormalized, { my: number; kind: Kind | null }>()
  let outAnim: Animation | null = null

  function dropOut() {
    outAnim?.cancel()
    outAnim = null
  }

  const offBefore = router.beforeEach(async (to, from) => {
    const my = ++token
    dropOut()
    const kind = kindOf(to, from)
    const el = main()
    navs.set(to, { my, kind: el ? kind : null })
    if (!kind || !el) return
    // fill:forwards —— 离场播完后保持隐形，直到入场动画接手，中间不会闪回旧页
    const anim = el.animate(OUT[kind], { duration: OUT_MS, easing: 'ease-in', fill: 'forwards' })
    outAnim = anim
    try {
      await anim.finished
    } catch {
      // 被 cancel（后一次导航抢先）—— 照常放行，由后一次导航负责动画
    }
  })

  const offAfter = router.afterEach(async (to, _from, failure) => {
    const nav = navs.get(to)
    if (!nav || nav.my !== token) return
    if (!nav.kind || failure) {
      // 导航被取消 / 被守卫拦下：页面没换，把离场的隐形撤掉
      dropOut()
      return
    }
    // 等新页挂上 DOM 再入场；离场动画在同一帧撤掉，入场从 opacity 0 接上，不闪
    await nextTick()
    if (nav.my !== token) return
    dropOut()
    main()?.animate(IN[nav.kind], { duration: IN_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' })
  })

  onBeforeUnmount(() => {
    offBefore()
    offAfter()
    dropOut()
  })
}
