# 无限世界昼夜与阴影

2026-09-18。沿用世界设置中的一天时长（默认 20 现实分钟），完整循环 24 游戏小时。暂停、打开面板、交谈与后台隐藏沿用现有暂停规则；午夜进入下一天，保存／载入延续同一世界时间。

## 画面与交互

- 晨曦、白昼、黄昏、月夜平滑过渡；蓝色月光保留角色、道路及水边的可读性。
- 太阳由东向西运动，树木、房屋、围栏、作物、玩家和居民按精灵透明轮廓生成贴地投影。早晚长、正午短，日落渐隐；角色的影子与动作帧共用位置、尺寸、朝向，树影同步风摆。
- 固定树冠／房屋影子已替换，根部与地基的小范围接触阴影保留，夜间减弱。
- 树冠、人物、建筑、作物和其他精灵增加表面方向光照。迎光侧亮、背光侧暗；日光方向变化时亮暗侧随之变化，保留素材本身的笔触。
- 树木和建筑能把阴影投到人物及其他精灵表面；人物走出遮挡后恢复受光。阴影使用当前动画轮廓，树冠风摆同步参与遮挡。
- 镇内灯笼及门前暖色照明随黄昏亮起、黎明熄灭。地表、道路、水面和精灵使用同一照明场；灯笼带柔和光晕。雨天／雷雨根据已保存的天气降低日光和投影强度。
- 精灵上的灯光按像素位置、表面朝向和高度衰减，靠近灯笼的衣物、树干及墙面获得暖光，高处屋顶不会仅因脚底靠近灯光就整片变亮。
- 时间 HUD 显示昼夜阶段和全天进度。载入暂停的夜间存档时，第一帧即采用对应天色。

## 实现范围

`simulation/dayNight.ts` 统一时钟和光照采样；`frame.tsl.ts` 共享太阳、阴影和灯光参数；`projectedShadow.tsl.ts` 复用精灵几何和图集，使用实例化绘制地面投影；`nightLightField.ts` 在环面上预计算有限范围的照明及主导灯源方向，`nightLamps.ts` 绘制可见灯笼光晕。

`spriteNormals.ts` 在装载图集时根据透明轮廓和柔化后的绘画明度生成 128² 法线层，区分树冠、人物、屋顶及墙面。`spriteLighting.tsl.ts` 逐像素计算环境光、方向日光和局部灯光；保留缺少法线图集时的旧材质回退。不修改地形或存档格式，也不需要新素材。

`spriteShadowMap.ts` 使用 1024² 离屏纹理记录太阳射线上的最高遮挡物及其身份，接收表面按自身高度比较遮挡，并通过五点采样柔化边缘。环面镜像共用身份，避免精灵平面错误遮住自己；与地面投影共用实例位置、尺寸、翻转、动作帧及风摆。白天新增一次遮挡图绘制，每个可见图集批次一个 draw；夜间跳过，暂停且场景未变时复用，共享几何并在场景卸载时释放资源。

这是适合 2D 绘画精灵的近似立体受光，并非真实三维建筑几何。能够接收其他物体的日光阴影，未实现屋檐等内部几何的三维自遮挡；灯笼提供局部照明，未增加每盏灯各自的遮挡图。素材原本的明暗仍然保留，窗户也没有替换成独立发光像素。新增法线图集和离屏绘制的移动端性能仍需真机评估。

## 验证与证据

- `npm run verify`：包括新增 `verify:day-night`，验证周期连续性、午夜换日、暂停、保存恢复、昼夜标签、太阳方向／影长、阴天和跨接缝灯光。
- `npm run build`：类型、模板检查及生产打包通过。
- `node scripts/worldgen/verify-day-night.mjs`：真实 WebGPU／WebGL 六个时段，开关投影像素对照、灯笼、暂停首帧、午夜换日、雨天、旧生成器、地图接缝及窄屏截图；未出现渲染错误或缺失资源。
- `python scripts/worldgen/review-day-night.py`：生成对照图及分时展示动图（每帧是一张固定时段截图，非实时速度演示）。
- `npm run verify:object-lighting`：树木／人物／房屋法线、东西向受光反转、源图颜色与透明度保留、跨接缝灯光方向。
- `node scripts/worldgen/verify-object-lighting.mjs`：双后端表面光照开关对照、夜间灯光、树木与建筑对人物的遮挡、走出阴影、暂停稳定性与控制台错误检查。
- `python scripts/worldgen/review-object-lighting.py`：独立对比人物裁剪像素，断言脸部／上半身也正确接收遮挡，走出后不残留阴影；生成前后对照及像素报告。两后端树荫及建筑遮挡均改变超过 2100 个人物像素，走出后的对照差异为 0。
- `node scripts/worldgen/verify-corrections.mjs --out=output/preview/world-v6/object-lighting/movement`：加入表面光照后，双后端草地速度、左右行走、浅水移动、浸没、角色尺寸及暂停水纹回归通过。

[昼夜对照](../output/analysis/world-v6/day-night/cycle-webgpu.jpg) · [分时动图](../output/analysis/world-v6/day-night/cycle-webgpu.webp) · [动态阴影对照](../output/analysis/world-v6/day-night/shadows-webgpu.jpg) · [夜间原始截图](../output/preview/world-v6/day-night/night-webgpu.png) · [双后端验证报告](../output/preview/world-v6/day-night/report.json)

本地预览：开发服务器启动后打开 `/scripts/worldgen/preview.html?reference&freeze&minute=1320` 查看夜间，`minute=480` 查看晨间长影，`minute=720` 查看正午。去掉 `freeze` 按世界时间正常推进；日长使用 `dayMinutes` 指定现实分钟。正式游戏直接读取世界设置。

本次表面光照证据：[晨间／下午／夜间](../output/analysis/world-v6/object-lighting/surfaces-webgpu.jpg) · [建筑表面前后对照](../output/analysis/world-v6/object-lighting/comparison-webgpu.jpg) · [人物接收阴影对照](../output/analysis/world-v6/object-lighting/receiving-webgpu.jpg) · [像素检查报告](../output/analysis/world-v6/object-lighting/pixel-report.json) · [双后端运行报告](../output/preview/world-v6/object-lighting/report.json)。隔离场景使用 `/scripts/worldgen/preview.html?lighting&freeze&minute=480` 和 `?lighting=building&freeze&minute=480`。
