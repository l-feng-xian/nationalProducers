# 国货优选 · AI 沉浸式角色扮演聊天

纯前端（Vue 3 + TS + Vite），数据全部存浏览器 IndexedDB，可对接任意 **OpenAI 兼容**接口。
世界书（World Info）**完整对齐 SillyTavern v1.18.0**。

## 跑起来

```bash
npm install
npm run dev
```

打开后先去 **设置 → 模型服务** 填 baseURL / API Key / 模型名，点「测试连接」。

### 关于 CORS

浏览器直连会被跨域挡住的服务：OpenAI 官方、Ollama 等。
- **DeepSeek、硅基流动**等允许跨域 → baseURL 直接填官方地址即可
- 其它 → 在设置里把「代理地址」填 `/llm`，并在 `.env.local` 写：
  ```
  VITE_LLM_ORIGIN=https://api.openai.com
  ```
  开发期走 `vite.config.ts` 的 dev proxy；生产环境需自备反向代理。

## 功能

| | |
|---|---|
| **1v1 聊天** | 流式输出、Markdown、开场白 swipe 切换、重新生成、消息编辑/删除/分支 |
| **1vN 群聊** | 四种发言策略（自然/列表/轮流/手动）、SWAP/APPEND 卡片注入、group nudge、串台兜底截断 |
| **角色** | 图片、简介、性格、场景、**多条开场白**（新对话随机取）、**多组对话示例**（可视化编辑）、深度提示词、发言意愿；PNG/JSON 角色卡导入导出 |
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
