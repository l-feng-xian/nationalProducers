# 幕间 · AI 沉浸式角色扮演聊天

纯前端（Vue 3 + TS + Vite），数据全部存浏览器 IndexedDB，可对接任意 **OpenAI 兼容**接口。
世界书（World Info）**完整对齐 SillyTavern v1.18.0**。

## 跑起来

```bash
npm install
npm run dev
```

打开后先去 **模型管理 → 模型服务** 添加服务，填写 baseURL / API Key / 模型名并测试连接。可保存多个服务，通过卡片上的单选框切换当前服务。

Yoshub 的 API 根地址填写 `https://api.yoshub.com/v1`。两个模型配置编辑器在拉取列表时，若裸域名返回网页或路径不存在，会尝试 `/v1`；成功后自动补全地址，保存配置即可供后续请求使用。

在 **角色 → 新建角色 → AI 创建角色** 输入简短描述，可用当前模型服务生成基本信息、开场白和对话示例并填入页面。生成结果可修改或撤销，检查后点击「保存」。

**文生图**：在「模型管理 → 文生图模型」添加多套配置，分别设置接口根地址、API Key、模型、尺寸与画质；支持 OpenAI Images 兼容的 `/images/generations` 接口。选中的配置作为默认，生成时也可临时切换。尺寸、画质和返回格式留空时使用服务默认值。

角色编辑页填写简介后点击「生成封面」，可调整画面描述、预览后设为封面。对话配图只使用当前消息内容与角色封面参考图，以保持人物一致性；顶部按钮使用最新一条消息，消息旁的图片按钮使用选中的消息，群聊会携带成员的封面图。生成窗口会显示参考图，缺少封面时需先补充；对话配图模型须支持 `/images/edits` 参考图接口。预览确认后作为附件保存，支持查看原图和下载。生成可取消或重试，图片存入本机并随备份和聊天同步，API Key 不进入备份。图片链接返回方式需要图片服务器允许跨域下载，也可使用服务支持的 Base64 返回方式。

### 关于 CORS

浏览器直连会被跨域挡住的服务：OpenAI 官方、Ollama 等。
- **DeepSeek、硅基流动**等允许跨域 → baseURL 直接填官方地址即可
- 其它 → 在模型服务编辑窗口把「代理地址」填 `/llm`，并在 `.env.local` 写：
  ```
  VITE_LLM_ORIGIN=https://api.openai.com
  ```
  开发期走 `vite.config.ts` 的 dev proxy；生产环境需自备反向代理。

**装成安卓 App 就没有这个问题了**：原生壳里请求由 Rust 发出，不受同源策略约束，
「代理地址」留空直连即可（局域网里的 Ollama / LM Studio 也能直接连）。

## 打包成安卓 App

```bash
# 一次性：装 Rust、JDK 17、Android SDK/NDK，并设好 ANDROID_HOME / NDK_HOME / JAVA_HOME
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android

npx tauri android build --apk --target aarch64     # 单 ABI，体积小、构建快
npx tauri android build --apk                      # 四个 ABI 的 universal 包
```

产物在 `src-tauri/gen/android/app/build/outputs/apk/`。

签名是**可选**的：`src-tauri/gen/android/app/keystore.properties`（已 gitignore）存在就签名，
不存在也能构建，只是产出未签名包。字段见 `app/build.gradle.kts` 顶部注释。
**keystore 一旦丢失就再也无法给同一应用发更新**，请自行备份。

⚠️ 两个本机踩过的坑：
- **rustc 会 OOM**。Tauri 的依赖树 443 个 crate，默认并行度 = CPU 核数（本机 20），
  16GB 内存扛不住，而它崩溃后会留下**被截断的 `.rmeta`**，报成一堆看着毫不相干的
  `E0462 found staticlib std` / `E0786 invalid metadata`，极易误判成 crate-type 配错。
  已在 `src-tauri/.cargo/config.toml` 里把 `jobs` 限到 2。
- **插件版本必须 npm 与 crate 对齐**，否则 Tauri CLI 在构建前直接拒绝。

## 功能

| | |
|---|---|
| **1v1 聊天** | 流式输出、Markdown、开场白 swipe 切换、重新生成、消息编辑/删除/分支 |
| **1vN 群聊** | 四种发言策略（自然/列表/轮流/手动）、SWAP/APPEND 卡片注入、group nudge、串台兜底截断 |
| **角色** | 图片、简介、性格、场景、**多条开场白**（新对话随机取）、**多组对话示例**（可视化编辑）、深度提示词、发言意愿；PNG/JSON 角色卡导入导出，**导出的 PNG 可直接被 SillyTavern 导入** |
| **关系图谱** | 可拖拽 SVG 画布 + 列表双视图，**有向边**（A→B 与 B→A 可完全不同），自动拼进 1vN 约束提示词 |
| **世界书** | 关键词/正则触发、四种副键逻辑、常驻、per-entry 扫描深度、递归、定时效果（粘滞/冷却/延迟）、包含组+组内评分、概率、预算、8 种插入位置 |
| **双模式约束提示词** | 1v1 与 1vN 各一套，可分别配置插入深度（默认 0） |
| **数据** | 整库导出/导入（**不含 API Key**），可跨设备迁移 |

## 排查问题：先看「预览提示词」

聊天页右上角的 **预览提示词** 是最重要的排查工具。所有「模型为什么没按设定走」的问题都能在这里看到答案：
哪些块进了提示词、约束提示词落在第几条、世界书激活了什么、历史被裁掉多少。
它走 dry run，**不会**推进世界书的粘滞/冷却状态。

**插入深度（depth）语义**：`depth N` = 注入之后仍有 N 条真实消息；
**`depth 0` = 追加到历史最末，作为独立的一条消息**（离生成最近，约束力最强）。
设置页的深度输入框下方有实时图示。

## 开发

```bash
npm run type-check   # vue-tsc + 模板编译检查
npm run format       # oxfmt（无分号、单引号）
npm run build        # 生产构建
```

### ⚠️ 两个必须知道的坑

1. **不要用 `structuredClone`，用 `@/utils/plain` 的 `toPlain()`。**
   Vue 的 reactive 代理无法被 structuredClone，会让 `db.put()` 抛 `DataCloneError`
   （**所有持久化静默失效**），组件里做编辑副本也会直接抛异常。
   仓储层已在写入处统一收口，UI 层取草稿时需自己调用。

2. **模板里别写多语句内联 handler，也别写字面 `{{xxx}}`。**
   前者会被 oxfmt 去掉分号折行后编译失败；后者的内层 `}}` 会提前闭合插值。
   `vue-tsc` 对这两类**完全不报**，因此 `npm run type-check` 里接了
   `scripts/check-templates.mjs`（用 Vue 真实编译器编译每个 SFC）来兜底。

### 目录

```
src/
├── types/          ST 原生字段名的数据模型
├── db/             IndexedDB schema + 仓储层（写入统一 toPlain）
├── services/
│   ├── macro/      宏引擎（递归下降，内层优先）
│   ├── worldinfo/  世界书引擎（逐行对齐 ST checkWorldInfo）
│   ├── prompt/     提示词组装、深度注入、预算、关系图谱渲染
│   ├── group/      群聊发言策略与卡片拼接
│   ├── provider/   OpenAI 兼容客户端 + SSE
│   └── io/         角色卡 / 世界书 / 整库备份
├── stores/         Pinia（响应式与编排，不碰 IDB API）
├── views/ components/ composables/ utils/
docs/
├── design-*.md            三份实现设计
└── reference/st-*.md      从 SillyTavern 源码核对出的行为规格
```

架构分层：`views/components` → `stores` → `services` + `db/repositories`。
`services/**` 与 `db/**` 不 import vue/pinia。

## 已知限制

- token 计数是启发式估算（CJK 1/字，其余 len/4），与真 tokenizer 差 10~30%，
  故世界书在预算边界上激活的条目数可能与 SillyTavern 差 1~2 条
- 角色图片暂未做裁剪，直接用原图 + `object-fit: cover`
- 数据只在本机浏览器，清除站点数据会丢，重要内容请导出备份
