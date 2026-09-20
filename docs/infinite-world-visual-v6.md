# 无限世界 v6：参考城镇重构记录

后续四项修正（栅栏/花箱、岸石、角色体型与涉水、疏林）见 [修正记录](infinite-world-v6-corrections.md)。本页原截图保留为修正前对照。

完成日期：2026-09-18。基准为 `output/imagegen/world-v5/raw/town-reference.png`。用户确认方案并指示“开始执行”后，已完成新素材、参考城镇、程序化街区、地面与水体渲染的接入。角色保留黑发、红黑服饰和 1.7 格高度。

这是实际可行走的分层场景；固定参考城镇与新世界共用建筑、农场、铺路模板和正式渲染器。**当前并非逐像素还原，不能宣称已达到“百分百还原”。** 工程测试通过与美术相似程度分别记录。

## 查看结果

- [原图、旧版、新版总览](../output/analysis/world-v6/acceptance/overview-comparison.jpg)
- [原图与新版原尺寸对照](../output/analysis/world-v6/acceptance/reference-vs-runtime.png)
- [旧版与新版原尺寸对照](../output/analysis/world-v6/acceptance/before-vs-after.png)
- [WebGPU 实机全景](../output/preview/world-v6/reference-webgpu.png) / [WebGL 实机全景](../output/preview/world-v6/reference-webgl.png)
- [八区域对照索引](../output/analysis/world-v6/acceptance/eight-details.jpg)
- [行走动作](../output/analysis/world-v6/acceptance/walking-webgpu.webp) / [水面动态](../output/analysis/world-v6/acceptance/water-webgpu.webp)
- [程序化农田](../output/preview/world-v6/farm-webgpu.png) / [自然岸线](../output/preview/world-v6/shore-webgpu.png)

开发服务器启动后打开 `http://127.0.0.1:5173/scripts/worldgen/preview.html?reference&backend=webgpu`，使用 WASD/方向键行走。将 backend 改为 webgl 可对照另一后端；加 `&freeze` 可冻结初始时间。程序化场景使用 `?natural&seed=village-wrap&backend=webgpu`。

正式游戏**新建世界**默认使用 `torus-4` 和 `public/world/v6`。旧存档继续按其生成器版本和旧图集读取，避免建筑门口、占地错位。共享地面着色器有改进，因此不承诺旧存档画面逐像素不变；旧版生成数据基线保持一致。

## 已接入的改动

| 区域 | 实现及作用 |
| --- | --- |
| 河岸 | 连续距离场控制湿土和水缘，缩窄沙岸；岸石、岸花投影到同一岸线，减少整格方块边界和宽白边 |
| 水体 | 接入水文 D8 流向；双相位手绘贴图沿流场漂移，浅处透出河床，岸边使用断续波纹；缩小重复水纹并降低对比 |
| 土路 | 连续轮廓与窄路肩，草地和土路分别采样；城镇主路、院门小径、田间道按功能预留 |
| 石板路 | 解析铺装区域并集、矩形广场、独立收边石；斜街石块沿路旋转，门口踏石圆角且略有转向 |
| 房屋 | 独立商店、蓝顶旅店、谷仓、四栋住宅、水井；按真实图像门口锚点连接短路径，不铺大矩形基座 |
| 街区 | 先保留道路、广场、院落和入口，再放建筑；新版选址只接收七栋建筑与水井完整的街区，启用农田时还须保留三块田床；不合格选址跳过 |
| 农田 | 土床、垄沟、根影、植株分层；白菜/幼苗以约 0.44 格行距种植，小麦约 0.25 格；植株独立参与深度遮挡和微风 |
| 桥梁 | 桥面与近远栏杆分别绘制，折桥按真实桥格分解，避免包围矩形覆盖水面；可跨世界接缝 |
| 阴影与边缘 | 增加树冠、树根和建筑短投影；按素材清理透明度并扩展透明边缘 RGB，减少深色抠图边 |
| 图集与角色 | 建筑、大树使用 12 层 512² 图集，小物/角色保留 162 层 256²；走路相位随实际路程推进，暂停冻结水、风与当前动作帧 |

主要入口为 `generation/referenceTown.ts`、`referenceFixture.ts`、`townLandscape.ts`、`rendering/contourField.ts`、`shorePlacement.ts`、`plotBuild.ts` 和地面、水体、地块 TSL 材质。新增生成器还修复了被水隔开的建筑入口连接，旧版不走该修复分支。

## 素材来源和加工

生成模型为用户指定的 **gpt-image-2.5-flare**，使用用户环境中的 API 配置，经 imagegen 官方 CLI 的 edit 路径引用原参考图。密钥未写入项目。六张生成源图保存在 `output/imagegen/world-v6/raw/`：地形样片、环境组件、公共建筑、住宅、树木与桥、树木与谷仓修订。

提示词保存在 `scripts/worldgen/prompts/world-v6/`。加工脚本 `scripts/worldgen/prepare-reference-assets.py` 输出 24 个独立新精灵（含三项后续替换时处理计数为 27）及 8 个地面材质；森林/湿地材质由新草地派生。角色和部分小物沿用此前已接入素材。

地面采用 512² 分层贴图和对称接缝混合；精灵使用逐资产阈值、连通域清理和未裁断轮廓检查。[抠图检查表](../output/imagegen/world-v6/cutouts-review.jpg)与 `extraction-report.json` 保留加工证据。石路收边、踏石与桥面当前仍是程序材质，未使用修订源图中的备用收边石。

## 实现后的三轮复核

### 第一轮：同画幅整体结构

使用 1536×1024、DPR 1、晴天正午、冻结初始动画时间的实机画面。七栋建筑、水井、东北三块田床、左侧河桥、矩形广场和环绕小径均出现；南侧住宅保留短院落。核对过程中修正了斜向收边石、过长谷仓踏石链，以及程序化选址缺失住宅的问题。

原图使用绘画投影，实机使用正交相机；桥、水井、庭院和道路位置仍有偏差。因此对照图保留原尺寸而不计算没有意义的 SSIM 或“还原百分比”。

### 第二轮：八个原尺寸局部

每对图片使用同一视口窗口裁切，不缩放，不对齐或重绘地标。索引缩图仅用于导航。

| 对照区域 | 已确认的改善 | 仍可见的差异 |
| --- | --- | --- |
| [01 河岸](../output/analysis/world-v6/acceptance/01-bank.png) | 水陆连续、窄湿土、岸石嵌入水边 | 原图岸树、根系与草团更丰富，实机装饰仍有重复 |
| [02 水与桥](../output/analysis/world-v6/acceptance/02-water-bridge.png) | 桥面栏杆独立、水纹更小、桥头可连接道路 | 木板方向、桥柱粗细、桥下暗部及河弯未逐项还原；附近树群偏密 |
| [03 土路](../output/analysis/world-v6/acceptance/03-dirt-grass.png) | 无逐格硬边，窄踏石衔接院门 | 土路纹理碎石偏多，缺少原图更细的磨损和车辙 |
| [04 石板广场](../output/analysis/world-v6/acceptance/04-stone-square.png) | 广场轮廓清楚，有独立收边与水井基脚 | 石块尺寸/缝隙、灯柱位置和局部花草不完全相同 |
| [05 庭院](../output/analysis/world-v6/acceptance/05-house-yard.png) | 可辨门槛、窄基础、短石径、院门和边界 | 侧向围栏较薄；庭院草木、木桶密度仍不足 |
| [06 农田](../output/analysis/world-v6/acceptance/06-farm.png) | 分层田床和根影，密植白菜/幼苗/小麦；植株有遮挡 | 三块床的覆盖率、行倾角与生长形态不同，谷仓杂物不够丰富 |
| [07 建筑](../output/analysis/world-v6/acceptance/07-building-roofs.png) | 商店和蓝顶阳台旅店可辨，高分辨率保留瓦片门窗 | 素材重绘改变了部分窗饰、屋顶比例和笔触 |
| [08 林缘](../output/analysis/world-v6/acceptance/08-forest-meadow.png) | 镇外成簇种树，增加落地影，院内避免大树堵门 | 树冠仍偏细碎、重复度高，原图更有大片叶团和疏密变化 |

### 第三轮：动态与跨场景

WebGPU、WebGL 均实跑 14 个场景：固定参考、桥、基础测试地形、自然世界、岸边、全景、农田、两种其他种子、世界接缝、窄视口以及 torus-1/2/3。报告断言实际启用的渲染后端和生成器版本，检查浏览器错误与缺失素材，结果全部通过。

参考/桥/基础场景验证角色实际移动，并比较暂停前后 canvas 字节及玩家位置。保留 16 张实际动作帧；WebP 以每帧 80ms 编码便于查看，不代表实际设备帧率。

专项检查在两个后端各实跑四处院门往返、完整过桥、x=512/0 接缝行走，共 12 组路线通过。院门测试确认角色能走到门口并被房屋占地挡住；完整过桥从 x=52.2 到 x>57，接缝从 x=511.2 到 x≈1.47。[交互报告](../output/preview/world-v6/interactions/report.json)保留实际坐标。[WebGPU 遮挡](../output/analysis/world-v6/acceptance/occlusion-webgpu.png)与 [WebGL 遮挡](../output/analysis/world-v6/acceptance/occlusion-webgl.png)人工核对角色在井后被遮住、在井前正确覆盖井体。

专项脚本最初出现零位移，原因是无头 Chrome 首帧尚未呈现就开始计时。增加首帧 canvas 截图作为就绪边界后通过；未放宽通行断言或更改碰撞以掩盖问题。

报告：[WebGPU](../output/preview/world-v6/report-webgpu.json)、[WebGL](../output/preview/world-v6/report.json)、[截图参数与范围](../output/analysis/world-v6/acceptance/evidence.json)。

## 工程检查与限制

- `npm run verify` 全部通过；村庄检查覆盖 522 栋建筑、165 块田床，检查入口连通、地块/道路/房屋冲突，并保留旧生成版本基线。
- `npm run build` 通过，包含类型检查和模板检查。仍有现有 npm 配置提示及大于 500 kB 的打包体积提示。
- 新增 `verify:reference` 检查完整参考城镇、植株根部范围、弯桥准确覆盖、跨接缝归属、岸线投影和 Worker 水流缓冲区转移。
- 参考场景 4 个可见 chunk、53 次绘制。图集基础 RGBA 数据约 52.5 MiB，不含 mip、地面纹理与渲染目标。浏览器报告中的 FPS 是短窗口采样，窄视口还有初始化阶段低采样值；不作为性能达标证明，也未测试真实手机。
- 新版采用一套固定关系的完整街区模板，地形、镇址、河流和植被由种子决定；尚未实现多套街区变体。严格选址会减少某些地形的城镇数量。
- 岸根局部遮挡、桥面和复杂折桥栏杆转角、院落道具密度、树群多样性仍有美术差距。当前接触影采用解析形状，未逐建筑生成准确投影轮廓。

复现：先 `npm run dev`，再执行 `node scripts/worldgen/verify-rendering.mjs --webgpu`、`node scripts/worldgen/verify-rendering.mjs`、`node scripts/worldgen/verify-interactions.mjs`，最后 `python scripts/worldgen/review-reference.py`。浏览器验证需要已安装 Chrome。
