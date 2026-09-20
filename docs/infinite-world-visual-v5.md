# 无限世界 v5：农田层次与街区规划

本轮针对 v4 实机中的两个问题：耕地像贴在草上的整张矩形图片；房屋随机落点后再补路，缺少明确街区、退距和院落。

## 参考图与素材

使用用户指定的 `gpt-image-2.5-flare`，通过 imagegen 技能的 CLI/API 模式生成；沿用 `output/imagegen/world-v2/raw/01.png` 作为画风参考。没有修改图像生成 CLI。

- 新城镇参考：`output/imagegen/world-v5/raw/town-reference.png`
- 六种农场素材原图：`output/imagegen/world-v5/raw/farm-assets.png`
- 生成提示词：`scripts/worldgen/prompts/town-v5-reference.txt`、`town-v5-farm-assets.txt`
- 处理脚本：`python scripts/worldgen/prepare-farm.py`
- 边缘清理预览：`output/imagegen/world-v5/farm-cutouts-review.jpg`
- 运行时素材：`public/world/v5/`。卷心菜、幼苗、小麦、豆架、木篱笆、矮树篱；豆架已备好，本轮默认菜地使用前三种作物。
- v5 清单继承 v4 建筑、v3 角色和原地表贴图。玩家身高仍为 1.7 格。

## 参考图如何落实到程序

| 参考图结构 | 实现 |
| --- | --- |
| 水井小广场和街巷 | 先建连通街道与广场，再沿街分配宅地；石铺广场使用较小石块纹理比例 |
| 商店、旅店的沿街门面 | 优先布置在广场北侧上街，地形缺少完整上街时保证仍有公共建筑 |
| 住宅退距和前庭 | 房屋位于独立宅地内部，留出前院；踏石连接门口和街道 |
| 篱笆、绿篱和院门 | 前侧短篱笆留两格门洞，后侧树篱、侧面灌木；边界与碰撞标志一致 |
| 谷仓旁的集中菜地 | 预留完整农业宅地，谷仓、两条种植床、中央走道一起规划，避免零散地块 |
| 有起伏感的田垄 | 单独的土壤层，以世界坐标计算田垄受光、沟槽暗部和田埂明暗，带柔和碎边 |
| 作物接地与遮挡 | 每株作物为独立精灵，大小有轻微变化、随风摆动，使用脚底深度排序；脚下独立软阴影 |

土垄起伏采用适合 2D 游戏的着色表现，未增加实体三维高低地形。阴影为稳定的接触阴影，不是实时太阳投射的长阴影。

地形约束仍然生效：街巷遇水停止，建筑占地需平坦干燥；在镇心附近有界评估候选位置，优先选择能容纳完整街区及农场的场地。跨城道路和连通修复避开保留宅地，院门路径保持可通行。

## 版本与存档

- 新建世界默认 `torus-3`，使用街区规划。
- `torus-1`、`torus-2` 保留各自的原有建筑、道路、装饰和出生点，不会移动旧存档中的设施。
- 旧版农田只在渲染时解析成种植床，获得作物、田垄和阴影；不改变逻辑格或保存数据。
- 查看新城镇布局需新建世界。继续旧存档只能看到渲染外观升级。

## 验证与实机截图

- `npm run verify`：全部检查通过。新增宅地归属、门前退距、道路不穿宅地、围栏碰撞、作物落点检查；4 个种子覆盖 235 栋建筑、42 条种植床。
- `torus-1` 和 `torus-2` 各两个种子的世界数组、设施及出生点 SHA-256 基线保持一致；同步与异步分发均验证。
- `npm run build`：类型、模板、生产构建通过。
- 实机验收：Vite 启动后运行 `node scripts/worldgen/verify-rendering.mjs` 和加 `--webgpu` 的版本。
- 两个后端各验证 fixture / natural / shore / overview / farm / mobile / torus-1 / torus-2 共 8 个场景，包含真正移动、暂停画面冻结、Worker 版本分发、素材载入与控制台错误检查。
- 截图：`output/preview/world-v5/overview-webgl.png`、`overview-webgpu.png`、`farm-webgl.png`、`farm-webgpu.png`。
- 报告：`output/preview/world-v5/report.json`、`report-webgpu.json`。

截图中的移动端尺寸是在桌面 Chrome 中模拟的视口，并不代表真实手机 GPU 性能测试。参考图用于规划和风格对照，实机效果以 preview 截图为准。
