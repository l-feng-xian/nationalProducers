# 无限世界 v6 四项修正

日期：2026-09-18。针对栅栏/花圃倾斜、岸石自带水纹、角色变大与无涉水效果、树木过密的反馈完成修正。

| 问题 | 修改 |
| --- | --- |
| 栅栏、花箱歪斜 | 用 gpt-image-2.5-flare 生成水平正面栅栏、水平花箱和无水纹石头。侧栅栏从同一新木材素材重组等高立柱与纵向横杆，按地块南北方向接续；修正脚底位置与高度比例 |
| 石头自带水纹 | v6 岸石全部替换为干净的石块轮廓，移除旧素材中的蓝绿水圈；稀疏的大石使用低矮扁石。流水仍由水面材质动态绘制 |
| 起步或转向时体型突变 | 实测旧正面待机主体高约 182px，行走约 207px。图集载入时按不透明主体测量每组动作的中位高度，将四方向待机/行走统一校准到正面待机比例；整组使用相同变换，保持脚底锚点和逐帧动作，不逐帧拉伸 |
| 浅水像漂浮 | 从实际水面轮廓采样浸没深度，遮住水下腿部、压暗湿润衣摆，入水逐渐下沉；按移动路程在落脚点生成短暂细涟漪，离开后淡出，暂停冻结。脚下实际水面减速至 1.7 格/秒，干燥草坪、陆地及桥面为 3.2 格/秒；桥上不触发浸没 |
| 树冠挤成一片 | 合并野外/镇外两阶段种树结果后统一疏林；树干最小间距 2.4 格，跨世界接缝同样生效。移除树木同步恢复通行标记；减少城镇外围新增树概率，保留成簇趋势 |

角色仍采用原有 1.7 格标尺，校准以当前待机体型为目标，没有放大待机角色。旧版生成器 torus-1/2/3 保持原地形/树木基线；v6 素材及疏林用于 torus-4，角色校准和涉水渲染适用于各版本。刷新页面重新进入世界即可重新载入素材与生成数据。

素材经 imagegen 官方 CLI edit 路径调用指定模型和既有用户环境配置生成，未修改 CLI 或保存密钥。源图：`output/imagegen/world-v6/raw/props-correction.png`；提示词：`scripts/worldgen/prompts/world-v6/props-correction.txt`。加工：`scripts/worldgen/prepare-reference-assets.py`。最终素材在 `public/world/v6/`，manifest 切换为 `fence-front-straight.png`、`fence-side-aligned.png`、`flower-box-straight.png`、`bank-stones-dry.png`、`flat-stone-dry.png`；保留原文件用于对照。

验证包括 `npm run verify`、`npm run build`，以及 WebGPU/WebGL 各 14 个实际渲染场景。新增 `verify:corrections` 覆盖整组动画比例、树木间距/确定性/跨接缝通行、浅水减速与桥面排除。浏览器专项实际穿过程序化浅水，检查浸没量、速度、固定角色缩放和暂停冻结，并从实际图集测量四方向帧的主体高度。窄视口测试是桌面模拟，不代表手机性能测试。

证据：

- [修正前后全景](../output/analysis/world-v6/corrections/town-before-after.jpg)
- [栅栏与花箱](../output/analysis/world-v6/corrections/fences-flowers.png)
- [岸石对照](../output/analysis/world-v6/corrections/bank-stones.png)
- [疏林全景](../output/analysis/world-v6/corrections/forest-overview.jpg)
- [校准后角色帧表](../output/preview/world-v6/corrections/hero-normalized-webgpu.png)
- [涉水动图](../output/analysis/world-v6/corrections/wading-webgpu.webp) / [逐帧图](../output/analysis/world-v6/corrections/wading-frames-webgpu.jpg)
- [WebGPU 报告](../output/preview/world-v6/corrections/report-webgpu.json) / [WebGL 报告](../output/preview/world-v6/corrections/report.json) / [涉水与体型专项报告](../output/preview/world-v6/corrections/wading-report.json)

复现：启动开发服务器后运行 `node scripts/worldgen/verify-rendering.mjs --webgpu --out=output/preview/world-v6/corrections` 和不带 `--webgpu` 的同一命令，再运行 `node scripts/worldgen/verify-corrections.mjs` 与 `python scripts/worldgen/review-corrections.py`。

## 草地速度与侧向行走补充修复（2026-09-18）

草地减速来自 `movementSpeed` 对原始 `Surface.Marsh`、`Surface.ShallowWater` 的硬编码。v6 湿地素材实际上是草坪的湿润色调，窄小浅水格还可能在岸线平滑后消失，所以画面上干燥的草坪也会触发减速。现只按脚下可见水面的浸没深度判定，桥面始终正常通行；不会修改存档地形。

侧向行走原始四个关键帧几乎一直由同一条腿支撑，光流插值只能制造轻微变形。经 imagegen 官方 CLI 的 edit 模式，使用指定 `gpt-image-2.5-flare` 生成保留黑发红黑服饰的侧向素材。初稿的支撑腿仍重复，因此拆出生成素材中的衣袍、裤腿和靴子，用两条独立腿部关节链重新制作 32 帧循环，依次落地、支撑、屈膝抬脚、前摆、换腿；右行完整镜像左行。原有四方向待机及前后行走保留。左右动画共用身体比例和脚底基线，运行时继续按实际移动距离推进，浅水时同步放慢。

- 生成原图：`output/imagegen/world-v6/raw/hero-side-gait.png`
- 完整生成提示词：`scripts/worldgen/prompts/world-v6/hero-side-gait.txt`
- 可重现加工脚本：`python scripts/worldgen/prepare-side-gait.py`
- 接入素材：`public/world/v6/hero-side/walk-{left,right}-{0..31}.png`；配置：`public/world/v6/side-gait.json`。v5/v6 manifest 均接入，覆盖旧存档及当前世界。重新加工 v6 环境素材时保留该覆盖配置。
- [素材动作帧表](../output/imagegen/world-v6/qa/side-gait/contact-sheet.jpg) / [素材循环动图](../output/imagegen/world-v6/qa/side-gait/side-walk.webp)
- [游戏内草地左右行走](../output/analysis/world-v6/movement/grass-walk-webgpu.webp) / [实测逐帧截图](../output/analysis/world-v6/movement/grass-walk-frames-webgpu.jpg)
- [涉水回归动图](../output/analysis/world-v6/movement/wading-webgpu.webp) / [双后端速度、体型及动画报告](../output/preview/world-v6/movement/wading-report.json)

专项回归：`npm run verify:corrections` 覆盖真实平滑轮廓、湿地草坪、孤立水格、桥面及环面坐标；`npm run verify:rendering` 覆盖距离驱动动作、暂停和碰撞；`node scripts/worldgen/verify-corrections.mjs --out=output/preview/world-v6/movement` 在真实生成的湿地草坪和浅水上分别运行 WebGPU/WebGL。实测草地速度均为 3.2 格/秒，涉水速度为 1.7 格/秒，采样四方向身体高度为 193–198 图集像素（自然动作起伏），画布缩放始终一致。`python scripts/worldgen/review-movement.py` 生成上述证据；游戏截图动图按固定展示间隔组合，动画速度以实际游戏为准。

本轮 `npm run build`（类型检查、模板检查、生产打包）通过；`git diff --check` 通过。构建仅保留已有的 npm 配置及打包体积提示。
