import { createRouter, createWebHistory } from 'vue-router'
import { installBackClose } from '@/composables/useBackClose'
import { installAppStack } from './appStack'
import { homePath } from './layout'

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面层级，决定路由过渡方向（见 useRouteTransition）：顶层 0，列表下钻的详情页 1 */
    depth?: number
    /** 一页多栏、靠参数切换选中项的页面：层级按参数个数算，桌面宽屏下参数切换不做整页过渡 */
    panes?: boolean
    /** 手机布局下的层级（覆盖 depth）：聊天 / 设置在手机上是压在底部标签页之上的二级页，见 router/layout */
    mobileDepth?: number
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // 首页随布局：手机 = 角色页（底部标签栏的第一项），桌面 = 聊天页
    { path: '/', redirect: () => homePath() },
    {
      path: '/chat/:id?',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
      meta: { mobileDepth: 1 },
    },
    {
      path: '/characters',
      name: 'characters',
      component: () => import('@/views/CharactersView.vue'),
    },
    {
      path: '/characters/:id',
      name: 'character-edit',
      component: () => import('@/views/CharacterEditView.vue'),
      meta: { depth: 1 },
    },
    // 必须排在 '/groups/:id' 之前。:id 是必填段，`/groups` 本身匹配不上它，
    // 但顺序写反了以后再加可选段（:id?）就会被前者吞掉
    {
      path: '/groups',
      name: 'groups',
      component: () => import('@/views/GroupsView.vue'),
    },
    {
      path: '/groups/:id',
      name: 'group-edit',
      component: () => import('@/views/GroupEditView.vue'),
      meta: { depth: 1 },
    },
    {
      path: '/worlds/:bookId?/:uid?',
      name: 'worlds',
      component: () => import('@/views/WorldBooksView.vue'),
      meta: { panes: true },
    },
    {
      path: '/models',
      name: 'models',
      component: () => import('@/views/ModelsView.vue'),
    },
    {
      path: '/data',
      name: 'data',
      component: () => import('@/views/DataView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
      meta: { mobileDepth: 1 },
    },
  ],
})

// 浮层（抽屉 / 图片预览 / 底部菜单）响应返回键，见 useBackClose
installBackClose(router)
// 历史保持「首页 → 分区 → 详情」的 App 形状，不反复嵌套。须装在 installBackClose 之后
installAppStack(router)

export default router
