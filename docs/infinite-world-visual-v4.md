# 无限世界：连续地形与农场村庄

本轮按农场生活类 2D 游戏的空间组织方式调整地图：弯曲主路、水井空地、独立院落、门前支路和屋旁菜地。保留项目原有手绘风格，角色继续使用黑发、红黑服饰及 1.7 格显示高度。

## 地形轮廓

之前扩大单格遮罩的羽化范围，仍会留下沿网格转弯的轮廓。本轮增加 `rendering/contourField.ts`，从逻辑网格计算环面欧氏距离，做紧凑平滑及 Catmull-Rom 重建，烘焙为 1024×1024 RGBA 数据纹理。四通道分别承载石铺地、土路、沙岸和水面的连续轮廓。

着色器按世界坐标采样轮廓，叠加轻微边缘扰动；相邻格和相邻 chunk 共用同一场。绘制范围扩展到轮廓外侧，避免软边在 chunk 或原遮罩边缘被切断。普通道路并入土路层，避免两个半透明边缘重叠。桥面仍在水面上方绘制，耕地保留规则边界，便于辨识可耕作区域。

水深、浅水透明度和湿岸色调读取同一连续水域轮廓。水下延续沙土河床，保留缓慢水纹与断续岸波。逻辑碰撞和寻路仍使用 WorldGrid。

## 村庄与建筑

`generation/villageLayout.ts` 生成小型椭圆水井空地及 3–4 条弯曲街巷。每栋建筑预留院落，与相邻房屋保持距离，门口通过短支路接入村道；菜地避开建筑和道路。主干路和连通修复均绕开建筑占位。

村庄草木密度向野外渐变，房屋周围清出视线和活动空间。建筑使用自带薄石基的新精灵，取消额外的矩形石铺台座。新素材包含木屋、带侧屋的青瓦木屋、商店和谷仓，商店/谷仓素材也分别供客栈/工坊复用。

素材由用户指定的 **gpt-image-2.5-flare** 生成。使用 imagegen 技能附带 CLI、环境中的 `OPENAI_API_KEY` 和 `OPENAI_BASE_URL`，凭据没有写入项目。

- 风格输入：`output/imagegen/world-v2/raw/01.png`
- 村庄参考：[提示词](../scripts/worldgen/prompts/village-v4-reference.txt)，输出 `output/imagegen/world-v4/raw/village-reference.png`
- 建筑素材：[提示词](../scripts/worldgen/prompts/village-v4-buildings.txt)，输出 `output/imagegen/world-v4/raw/buildings.png`
- 最终素材：[public/world/v4/manifest.json](../public/world/v4/manifest.json)

生成的建筑图实际提供原生 RGBA，外围含低透明度色雾。`prepare-buildings.py` 清除色雾、保留主体连通区域、裁切并添加透明留白；运行时精灵管线继续做透明像素颜色扩展，减少采样黑边。已有原图时可本地重建：

```powershell
python scripts/worldgen/prepare-buildings.py
```

依赖 Pillow、numpy、opencv-python，仅用于素材处理。游戏运行不依赖 Python。生产清单复用 v1 地表、v3 角色和环境素材，默认加载目录改为 `/world/v4`。生成原图和截图在 Git 忽略的 `output/`，最终 PNG 与清单位于 `public/`。

## 存档兼容

新建世界使用 `torus-2`。已有 `torus-1` 世界继续调用保留的旧版布局规则，其地形、建筑、装饰和出生点不重新排列；渲染及素材改进对两种版本都生效。同步生成、Worker、缓存键及进入游戏页面都传递并识别版本。未知版本明确拒绝，避免用新规则静默重建旧世界。

`verify-village.ts` 保存两个修改前世界的 SHA-256 基准，对六张完整数据数组及建筑、桥梁、出生点逐一校验，同时检查同步和异步入口的版本传递。

## 验证与预览

```powershell
npm run verify
npm run build
# 保持 Vite 开发服务在 127.0.0.1:5173
node scripts/worldgen/verify-rendering.mjs
node scripts/worldgen/verify-rendering.mjs --webgpu
```

验证覆盖：欧氏距离与暴力求解结果一致、连续轮廓的环面接缝、窄道路/河流、跨 chunk 绘制范围、道路分层、角色位移步频和暂停、透明像素边缘，以及 312 栋房屋的可达门口和清理后的院落。原有环面、寻路、水文、城镇及流水线检查也包含在完整验证中。

浏览器验收使用真实 WebGL 2 / WebGPU 后端，各检查固定场景、生成村庄、河岸、2560×1600 全景、390×844 手机视口和旧版世界。检查素材加载、Worker 版本、真实移动、暂停后坐标与画面一致性。验收页隐藏开发工具的动画悬浮按钮，避免 DOM 覆盖层污染画面对比。

截图和报告位于 `output/preview/world-v4/`。可通过 `http://127.0.0.1:5173/scripts/worldgen/preview.html?natural` 查看村庄；添加 `&shore` 查看河岸，添加 `&version=torus-1` 检查旧版世界。

本轮完成地图生成与视觉呈现，种植、钓鱼和房屋室内交互不在本轮实现范围。水面为风格化效果；角色沿用 v3 的二维关键帧插值，衣袖等遮挡区域仍可能出现轻微形变。
