import { createRouter, createWebHistory } from 'vue-router'

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
    },
    {
      path: '/worlds/:bookId?/:uid?',
      name: 'worlds',
      component: () => import('@/views/WorldBooksView.vue'),
    },
    {
      path: '/models',
      name: 'models',
      component: () => import('@/views/ModelsView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
  ],
})

export default router
