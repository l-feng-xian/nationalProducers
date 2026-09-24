import { createRouter, createWebHistory } from 'vue-router'
import { installBackClose } from '@/composables/useBackClose'

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面层级，决定路由过渡方向（见 useRouteTransition）：顶层 0，列表下钻的详情页 1 */
    depth?: number
    /** 一页多栏、靠参数切换选中项的页面：层级按参数个数算，桌面宽屏下参数切换不做整页过渡 */
    panes?: boolean
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/chat' },
    {
      path: '/chat/:id?',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
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
    },
  ],
})

// 浮层（抽屉 / 图片预览 / 底部菜单）响应返回键，见 useBackClose
installBackClose(router)

export default router
