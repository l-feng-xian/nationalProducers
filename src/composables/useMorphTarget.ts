/**
 * 「下一次回到列表页时，哪张卡参与共享元素过渡」。
 *
 * ## 为什么需要它
 * 正向（列表→详情）只需要列表自己知道点的是哪张卡。反向（详情→列表）却要
 * 让**列表**在新状态里挂上同名元素，否则 View Transitions 找不到配对，
 * 只会退化成整页淡入淡出 —— 立绘不会缩回卡片，观感就是「闪一下」。
 *
 * 而详情页够不到列表页：两者互不相识、分属不同路由、详情页渲染时列表还没
 * 激活。用一个模块级 ref 当信箱最直接：详情页导航前写入 id，列表页读它决定
 * 给哪张卡挂 view-transition-name。
 *
 * ## 为什么不用路由 query / history.state
 * 这是纯视觉的一次性意图。写进 URL 会被用户看见、会进历史记录、刷新后还残留；
 * history.state 又要和 vue-router 的 push 签名较劲。模块 ref 生命周期正好匹配
 * 「一次会话内的一次导航」。
 *
 * ⚠️ 用完必须 clear()。残留的 id 会让下一次**无关**的导航也给那张卡挂上名字，
 * 于是同名元素可能在同一时刻出现两个 —— 规范要求整个过渡被 skip，
 * 表现是「动画时灵时不灵」，且不报任何错。
 */

import { ref, type Ref } from 'vue'

const target = ref<string | null>(null)

export interface MorphTarget {
  /** 列表页据此决定给哪张卡挂 view-transition-name */
  readonly target: Ref<string | null>
  /** 详情页在导航**之前**调用 */
  mark: (id: string) => void
  clear: () => void
}

export function useMorphTarget(): MorphTarget {
  return {
    target,
    mark: (id: string) => {
      target.value = id
    },
    clear: () => {
      target.value = null
    },
  }
}
