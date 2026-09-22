# SVG 图标

所有界面图标使用 `src/components/icons/AppIcon.vue`，小型操作图标也可从
`@/components/icons` 按名称导入。SVG 几何取自 Lucide（ISC 授权见同目录
`LICENSE.lucide`），角色面具与菜单保留本项目造型，无需 Lottie 运行时或网络资源。

```vue
<AppIcon name="BookOpen" tone="brand" />
<button :aria-expanded="expanded" @click="expanded = !expanded">
  <AppIcon name="ChevronRight" :active="expanded" />详情
</button>
```

- 使用 24 × 24 坐标、圆角描边和光学校正。导航及图标按钮为 20px，文字按钮、
  徽章及紧凑操作为 16px，空状态为 32px。尺寸由 `icons.css` 的令牌统一管理。
- `artwork.ts` 定义内部图层的常态、悬浮与激活姿态。渐变遵循明暗主题令牌，
  常态为中性灰蓝，悬浮和激活使用页面品牌蓝；颜色和图层一起过渡。
  操作图标继承所在控件的颜色，主按钮保留白色图标。
  `tone="danger / warning / success"` 分别使用错误红、警告橙、成功绿。
- `active`、导航选中态及 `aria-current / aria-expanded / aria-pressed / aria-selected`
  驱动持久激活态；鼠标悬浮与键盘可见焦点共享反馈，按压具有独立收缩图层。
- 360ms 过渡可在任意帧反向播放，内部图层以 24ms 错开。导航常态仅内部细节轻微
  呼吸，外框保持稳定。禁止再给图标外层叠加旋转或无限缩放动画。
- 图标默认对辅助技术隐藏。只有图标的按钮应提供 `aria-label` 或有意义的 `title`；
  独立表达信息的图标可传入 `label`。减少动态效果时保留状态终态并关闭动画。
- 主题或可见性图标切换使用固定尺寸 `.icon-swap` 与同名 Vue `Transition`；
  每个渐变实例使用独立 ID，可安全重复显示在侧栏、弹窗和空状态中。

运行 `npm run verify:icons` 检查页面渲染、状态过渡、尺寸、键盘、禁用态、重复渐变、
深色主题、减少动态效果和手机菜单。预览截图输出到 `test-results/icons/`。
