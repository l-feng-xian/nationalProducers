<script setup lang="ts">
import { ref, onMounted } from 'vue'

// —— 主题切换：在 <html> 上写 data-theme，并记忆到 localStorage ——
const theme = ref<'light' | 'dark'>('light')

function applyTheme(t: 'light' | 'dark') {
  theme.value = t
  document.documentElement.setAttribute('data-theme', t)
  try { localStorage.setItem('cbx-theme', t) } catch {}
}
function toggleTheme() {
  applyTheme(theme.value === 'light' ? 'dark' : 'light')
}

onMounted(() => {
  let saved: string | null = null
  try { saved = localStorage.getItem('cbx-theme') } catch {}
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  applyTheme((saved as 'light' | 'dark') || (prefersDark ? 'dark' : 'light'))
})

// —— 移动端侧栏抽屉 ——
const drawerOpen = ref(false)
</script>

<template>
  <div class="shell">
    <!-- 移动端遮罩：抽屉打开时点击关闭 -->
    <div v-if="drawerOpen" class="scrim" @click="drawerOpen = false" />

    <!-- 侧栏：Chatbox 式次级背景 + 分组 + 列表项；移动端为抽屉 -->
    <aside class="sidebar" :class="{ 'sidebar--open': drawerOpen }">
      <div class="brand">
        <span class="brand__logo">国</span>
        <span class="brand__name">国货优选</span>
      </div>

      <div class="cbx-group-label">导航</div>
      <nav>
        <div class="cbx-nav-item cbx-nav-item--active">概览</div>
        <div class="cbx-nav-item">商品</div>
        <div class="cbx-nav-item">订单</div>
        <div class="cbx-nav-item">设置</div>
      </nav>

      <div style="margin-top: auto; display: flex; flex-direction: column; gap: 8px">
        <button class="cbx-btn cbx-btn--soft">+ 新建</button>
        <button class="cbx-btn cbx-btn--ghost" @click="toggleTheme">
          {{ theme === 'light' ? '🌙 暗色' : '☀️ 亮色' }}
        </button>
      </div>
    </aside>

    <!-- 主区 -->
    <main class="main">
      <header class="topbar">
        <button class="cbx-btn cbx-btn--ghost menu-btn" @click="drawerOpen = true" aria-label="菜单">☰</button>
        <h1>设计风格样板</h1>
        <span class="cbx-badge cbx-badge--brand">Chatbox Style</span>
      </header>

      <section class="content">
        <div class="cbx-card">
          <h3>按钮</h3>
          <div class="row">
            <button class="cbx-btn cbx-btn--primary">主按钮</button>
            <button class="cbx-btn cbx-btn--soft">次按钮</button>
            <button class="cbx-btn cbx-btn--ghost">文字按钮</button>
            <button class="cbx-btn cbx-btn--primary" disabled>禁用</button>
          </div>
        </div>

        <div class="cbx-card">
          <h3>输入框</h3>
          <input class="cbx-input" placeholder="请输入内容…" />
        </div>

        <div class="cbx-card">
          <h3>状态标签</h3>
          <div class="row">
            <span class="cbx-badge cbx-badge--brand">品牌</span>
            <span class="cbx-badge cbx-badge--success">成功</span>
            <span class="cbx-badge cbx-badge--warning">警告</span>
            <span class="cbx-badge cbx-badge--error">错误</span>
          </div>
        </div>

        <div class="cbx-card cbx-card--raised">
          <h3>浮起卡片</h3>
          <p style="color: var(--cbx-text-secondary)">
            用细描边 + 圆角承载内容；需要强调时用轻阴影替代描边。
          </p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.shell { display: flex; height: 100%; }

.sidebar {
  display: flex;
  flex-direction: column;
  gap: var(--cbx-space-1);
  width: var(--cbx-sidebar-w);
  padding: var(--cbx-space-4);
  background: var(--cbx-bg-secondary);
  border-right: 1px solid var(--cbx-border);
  flex-shrink: 0;
}
.scrim { display: none; }
.menu-btn { display: none; font-size: var(--cbx-fs-xl); padding: 0; width: 40px; }
.brand { display: flex; align-items: center; gap: var(--cbx-space-3); margin-bottom: var(--cbx-space-4); }
.brand__logo {
  display: grid; place-items: center;
  width: 28px; height: 28px;
  background: var(--cbx-brand); color: #fff;
  border-radius: var(--cbx-radius-md);
  font-weight: var(--cbx-fw-bold); font-size: var(--cbx-fs-sm);
}
.brand__name { font-weight: var(--cbx-fw-bold); font-size: var(--cbx-fs-lg); }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.topbar {
  display: flex; align-items: center; gap: var(--cbx-space-3);
  padding: var(--cbx-space-4) var(--cbx-space-6);
  border-bottom: 1px solid var(--cbx-border);
}
.content {
  flex: 1; overflow: auto;
  padding: var(--cbx-space-6);
  display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--cbx-space-4);
  align-content: start;
}
.row { display: flex; flex-wrap: wrap; gap: var(--cbx-space-3); margin-top: var(--cbx-space-3); }
.cbx-card h3 { margin-bottom: var(--cbx-space-2); }

/* ── 移动端：侧栏变离屏抽屉，单列内容 ── */
@media (max-width: 767px) {
  .menu-btn { display: inline-flex; }
  .topbar { padding: var(--cbx-space-3) var(--cbx-space-4); }
  .topbar h1 { font-size: var(--cbx-fs-xl); }
  .content {
    grid-template-columns: 1fr;
    padding: var(--cbx-space-4);
  }
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    z-index: 30;
    transform: translateX(-100%);
    transition: transform var(--cbx-transition);
    box-shadow: var(--cbx-shadow-lg);
  }
  .sidebar--open { transform: translateX(0); }
  .scrim {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 20;
    background: var(--cbx-bg-mask);
  }
}
</style>
