# 侧栏导航 7 个按钮换成 Lottie 式动画 SVG 图标

## 现状
`AppSidebar.vue` 底部导航（.foot）7 个 RouterLink 用 emoji 字符（🎭 👥 📚 🌿 🧠 🗃️ ⚙️）+ 文字。延续上一轮 SunIcon/MoonIcon/MonitorIcon/MenuIcon 的动画约定：
- 24 viewBox / width=height=20 / fill none / stroke currentColor / stroke-width 2 / 圆头 / aria-hidden
- svg 根：`iconPop` 0.5s 回弹弹入（both）
- 内部元素：持续 `@keyframes` 动画（`transform-box: fill-box; transform-origin: center`）
- `prefers-reduced-motion` 全部降级为静态

## 新增 7 个图标组件（`src/components/icons/`）

| 组件 | 造型（lucide 同方言手绘） | 持续动画 |
|---|---|---|
| `CharactersIcon.vue` 角色 | 戏剧面具：盾形脸 + 笑眼 + 笑嘴 | **眨眼**（眼组 scaleY 脉冲，4s 一次）+ 面具轻摆 ±3° |
| `GroupsIcon.vue` 群聊 | 双人（前景大人 + 背景小人） | 两人**错峰上下浮动**（2.2s / 2.6s，点头寒暄感） |
| `WorldsIcon.vue` 世界书 | 打开的书（双页 + 中缝） | 左右页绕中缝**交替开合呼吸**（scaleX，origin 各贴中缝，错峰） |
| `GameWorldsIcon.vue` 无限世界 | 星球 + 圆轨道 + 轨道卫星（lucide orbit 风格，贴合"环面世界/探索"） | 卫星**绕轨道公转**（g rotate 360°，6s linear）+ 星球呼吸 |
| `ModelsIcon.vue` 模型管理 | CPU 芯片（外框 + 内核 + 四边引脚） | 内核**心跳脉冲**（scale+opacity）+ 引脚错峰闪烁 |
| `DataIcon.vue` 数据管理 | 数据库圆柱（顶椭圆 + 三层弧） | 三层弧**波次传递**（opacity 错峰 delay 0/.35/.7s，数据流动感） |
| `SettingsIcon.vue` 设置 | 齿轮（8 齿 = SunIcon rays 同法 + 体圈 + 中心孔） | 齿组**持续慢旋转**（10s/圈），中心孔静止 |

## AppSidebar.vue 修改
- import 7 个图标；RouterLink 内容改为 `<span class="nav-ico"><XxxIcon /></span><span>角色</span>`（emoji 全部移除；文字保留，可访问名不变，既有验证脚本的文字定位不受影响）
- 交互动效挂在新增的 `.nav-ico` span 上（svg 外层包裹元素，避免父 scoped 样式够不到 svg 内部、也避免覆盖 svg 根的 iconPop）：
  - **悬浮**：`navWiggle`（rotate ±8° + 上移 1px，0.5s 一次性）—— `.cbx-nav-item:hover .nav-ico`
  - **激活路由**：`activePulse`（scale 1→1.08，2.4s 循环）—— `.cbx-nav-item--active .nav-ico`
  - **按压**：`pressSquash`（压缩回弹 0.3s）—— `.cbx-nav-item:active .nav-ico`（规则顺序：activePulse → hover → press，按压优先级最高）
  - `prefers-reduced-motion`：三态动画全禁
- `.nav-ico { display:inline-flex; flex-shrink:0 }`；flex/gap 沿用 `.cbx-nav-item` 现有布局

## 验证
- 临时 Playwright 脚本（跑完删除）：
  - 7 个导航项各自的持续动画名断言（maskBlink/bookBreathe/orbitSpin/gearSpin/dbWave/chipPulse/usersFloat 等）
  - hover 触发 navWiggle、当前路由项 activePulse、reduced-motion 全禁
  - 放大截图目检 7 个图标几何（无溢出/错位）
  - 无页面错误
- 回归：`verify-data-view`（脚本会点侧栏导航进 /data）+ `verify-image-generation`
- `npm run type-check` + `check-templates`