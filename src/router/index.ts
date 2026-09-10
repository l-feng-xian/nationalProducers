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
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
  ],
})

export default router
