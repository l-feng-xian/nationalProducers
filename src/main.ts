import { createApp } from 'vue'
import { createPinia } from 'pinia'

import './assets/styles/tokens.css'
import './assets/styles/base.css'
import './assets/styles/icons.css'

import App from './App.vue'
import router from './router'
import { bootstrap } from './bootstrap'

const app = createApp(App)

app.use(createPinia())
app.use(router)

// 先跑启动序列（打开 DB、迁移、载入配置与主题），再挂载，避免首屏闪烁
bootstrap()
  .catch((e) => {
    console.error('[bootstrap] 启动失败', e)
  })
  .finally(() => {
    app.mount('#app')
  })
