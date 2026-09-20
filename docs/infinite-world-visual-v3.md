# 无限世界渲染调整（2026-09-16）

本文记录第一轮实现。当前默认使用 v4 素材与连续地形轮廓，新建世界的布局及兼容策略见 [v4 说明](infinite-world-visual-v4.md)。

地形仍由现有 WorldGrid / 双网格生成，渲染使用 Three.js TSL，支持 WebGPU 与 WebGL 2。此次变更无需重建存档；重新进入世界即可加载。

## 地形与水岸

- 土路改用连续有机遮罩，扩大羽化范围；两级世界坐标噪声只扰动边界。取消覆盖层内描边，降低路旁的统一压暗，保留石铺地与耕地结构。
- 原先水深使用大半径模糊的水域覆盖率，窄河难以达到深水阈值。现在用环面多源距离场，B 通道编码到岸距离，水中为正、陆地为负，范围 ±8 格。
- 河床沙土延伸到水下；近岸水层透明度渐变，显露湿润河床。叠加缓慢漂移的长细水纹、柔和反光和断续岸波，避免整圈白线。
- 精灵离线去除抠像边缘色溢出，地被底部渐隐。运行时把主体 RGB 延伸到透明像素，避免线性采样和 mipmap 混入黑底；剔除 alpha 极低像素中的异常底色。

## 角色

使用 `user.png` 的黑发、红黑汉服角色；地图内高度保持 1.7 格。每方向 16 张走路帧、16 张轻微呼吸待机帧，以及一张站姿。

素材通过 imagegen 技能自带 CLI 的图像编辑接口生成，模型为用户指定的 **gpt-image-2.5-flare**。第一轮读取角色参考与 `01.png` 风格参考，第二轮以第一轮角色为参考生成步态关键帧。原图和完整提示词保存在：

- `output/imagegen/world-v3/raw/hero-walk.png`
- `output/imagegen/world-v3/raw/hero-gait.png`
- [第一轮提示词](../scripts/worldgen/prompts/hero-v3-walk.txt)
- [步态提示词](../scripts/worldgen/prompts/hero-v3-gait.txt)

生成结果不是 16 张独立的正确步态：后处理采用每方向 4 个关键姿势，经双向光流补齐到 16 帧，包含末帧到首帧的衔接。右向最后一张生成姿势方向有误，使用对应左向姿势镜像修正。头部中心和地面基线统一对齐，运行时保留共同画布与参考高度，不再逐帧裁剪、缩放。待机呼吸由站姿的轻微形变生成。

动画按碰撞处理后的真实位移推进，因此湿地减速和沿墙滑行会同步调整步频，完全受阻时停止走路。待机时钟独立；暂停保留当前帧；失焦清理按键，避免切回窗口后持续移动。

游戏读取 [v3 素材清单](../public/world/v3/manifest.json)。角色与清理后的环境精灵在 `public/world/v3/`；地面材质通过清单复用 `public/world/v1/`。

## 复现与验证

已有生成原图时，使用 Python（Pillow、numpy、opencv-python）执行：

```powershell
python scripts/worldgen/prepare-hero.py
python scripts/worldgen/clean-sprite-edges.py
```

上述脚本只做本地图片处理，不调用 API。运行时没有 Python 依赖。原图与预览位于已被 Git 忽略的 `output/`；游戏实际读取的最终 PNG 和 manifest 位于可入库的 `public/world/v3/`。

验证通过：

- `npm run build`：类型检查、模板检查和生产构建。
- `npm run verify:dualgrid`：30 项通过，三套遮罩共享边偏差为零。
- `npm run verify:rendering`：全水/全陆、窄河、环面平移、水深方向、帧率无关步频、暂停/碰撞和精灵透明边缘采样。
- 启动 `npm run dev -- --host 127.0.0.1` 后，运行 `node scripts/worldgen/verify-rendering.mjs` 及附加 `--webgpu`：两个真实后端各验证固定场景、生成村庄和河岸；无浏览器错误、无素材加载回退，暂停前后画面逐字节一致。

预览：`http://127.0.0.1:5173/scripts/worldgen/preview.html`；加 `?natural` 查看生成村庄，加 `?natural&shore` 查看河岸，`&backend=webgl` 强制 WebGL。

验收文件：

- `output/preview/world-v3/{fixture,natural,shore}-{webgl,webgpu}.png`
- `output/preview/world-v3/report.json` 与 `report-webgpu.json`
- `output/imagegen/world-v3/qa/hero-walk.gif`（四方向循环）
- `output/imagegen/world-v3/qa/hero-contact-sheet.jpg`

水面使用风格化颜色与距离近似，没有引入真实几何反射。角色插值仍是二维关键帧变形，复杂衣袖遮挡处可能有轻微形变。
