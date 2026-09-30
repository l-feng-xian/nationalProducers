# 借鉴 DeepSeek Harness 架构重构幕间App：增益分析

> 状态：分析文档，未改动任何代码。
> 日期：2026-09
> 范围：`D:/tauriApp/nationalProducers`（Vue3 + TS + Pinia + IndexedDB + Tauri 2，含 Android）

---

## 0. 结论

建议**借鉴思想、渐进改造，不做整体迁移**。

- DeepSeek Harness（`dsh`）是面向「编码 Agent」的运行时，本项目是「角色扮演聊天 + 生图」客户端，两者领域不同，直接把 dsh 当底座替换现有代码不合算。
- 但它的核心理念「一切皆插件 + 极小内核 + 服务注入 + 生命周期可回收」刚好对准本项目目前最明显的几处结构问题：
  1. `stores/generation.ts`（891 行）一个 store 直接编排了提示词、流式、状态解析、会话记忆、向量索引、演绎发言人等 20+ 个模块；
  2. LLM 只有 `openaiCompatible` 一条硬编码路径；生图后端靠 `backend === 'comfyui'` 分支判断，散落在 service、repository 白名单和 UI 组件里；
  3. 平台差异靠 `isTauri` 布尔值散在 7 个文件里；
  4. 功能下线只能「整块删代码」（快速回复、正则、SD、滚动摘要、RAG 等都是这样被移除的），无法按需开关。
- 预期收益最大的三项：**生成管线钩子化**、**模型/生图后端插件化**、**运行时 Profile（Tauri / Web / Android / Headless 测试）**。工具调用（让角色主动调用生图等能力）是可选的新能力，而不是重构的必需品。

---

## 1. 信息来源与可信度

本次在线检索只拿到了搜索结果摘要，官方架构文档（GitHub `docs/architecture.md`、deepseek.com/harness）在当前网络环境下无法直接抓取。下面第 2 节关于 dsh 的描述来自：

- 搜索摘要中能交叉印证的内容（多个来源一致）；
- Cordis 框架本身的公开设计（Koishi 生态底座：`Context`、`ctx.plugin()`、事件、Service 注入、Schema 配置、副作用随插件卸载自动回收）。

凡是 dsh 特有 API 的细节（具体接口名、配置字段），落地前需要对照官方仓库再核实一次。

---

## 2. DeepSeek Harness 的架构要点

| 要点 | 含义 |
|---|---|
| Agent = Model + Harness | 模型只负责推理，工具、会话、沙箱、循环、调度、UI 都由 Harness 提供 |
| 一切皆插件 | 模型适配、工具、技能（skills）、会话、沙箱、存储、Agent 循环、调度、UI 全部是插件 |
| 极小内核 | 内核只做三件事：生命周期管理、插件解析、上下文传播 |
| Cordis 时空可组合性 | 插件可在运行时挂载/卸载；插件注册的监听器、服务、定时器等副作用挂在它自己的 `Context` 上，卸载时自动回收 |
| Service 注入 | 能力以具名服务提供（`ctx.xxx`），依赖方声明 `inject`，服务就绪才启动、服务消失自动停 |
| 分层 + Profile | `dsh-base` 为共享第一层（模型适配、工具、持久化、沙箱与审批策略、设置、凭据、遥测），之上组合出 web / headless / sdk / acp 等不同 Profile |
| 审批策略 | 有副作用的操作（执行命令、写文件、出网）经策略层判定放行/询问/拒绝 |

---

## 3. 当前项目架构现状（已核实部分）

| 方面 | 现状 | 依据 |
|---|---|---|
| 生成编排 | `stores/generation.ts` 891 行，直接 import 提示词构建、`streamChat/chatOnce`、演绎激活、状态卡、记忆运行时、向量索引、状态解析等；`send / sendGroup / generateOne / regenerate` 内部串行调用 | 文件 import 列表与函数清单 |
| 纯函数引擎 | 世界书、宏、提示词组装按 `design-engines.md` 约定为「纯 TS、零 Vue/Pinia 依赖」，store 只负责取数与调用 | `docs/design-engines.md` |
| LLM 提供方 | 仅 `services/provider/openaiCompatible.ts`（`streamChat / chatOnce / listModels`），无工具调用（`tools/tool_calls`）支持 | grep 无结果 |
| 生图后端 | `openai` / `comfyui` 两种，在 `image/generate.ts:77` 分支；`db/repositories/settings.ts:100` 写死白名单；`ImageModelEditor.vue` 里约 10 处 `backend === 'comfyui'` 决定表单 | grep 结果 |
| 平台抽象 | `services/platform/env.ts` 只导出 `isTauri / isWeb` 布尔值，调用方（`provider/http.ts`、`image/comfyui.ts`、`ml/fetchRelay.ts`、`qr/scan.ts`、`sync/signaling.ts`、`utils/download.ts`）各自分支 | grep 结果 |
| 宏 | `services/macro/registry.ts` 已是注册表形式 | 文件存在 |
| Rust 侧 | `lib.rs` 64 行，只装 http/dialog/fs/扫码/窗口状态插件，无业务逻辑 | 文件内容 |
| 大文件 | `GroupEditView.vue` 1055、`ImageGenerationDialog.vue` 991、`generation.ts` 891、`ChatView.vue` 840、`sync/session.ts` 707、`prompt/builder.ts` 638 行 | `wc -l` |
| 功能增减方式 | 快速回复 / 正则 / SD / 滚动摘要 / RAG / 长期记忆都是**删代码**下线 | 项目历史 |

一句话概括：**底层引擎已经是好的纯函数，问题集中在「编排层」和「扩展点」**。这正是 Harness 思想发力的位置。

---

## 4. 逐项增益分析

### 4.1 生成管线钩子化（收益最高）

**做法**：把 `generation.ts` 的串行编排拆成固定阶段，每个阶段是一个事件/钩子，功能以插件形式挂上去：

```
before-build → build-prompt → after-build → before-send → stream(chunk) → after-reply → persist
```

- 世界书扫描、会话记忆召回、状态卡注入 → 挂在 `build-prompt`
- `<status>` 流式剥离 → 挂在 `stream(chunk)`
- 状态解析、记忆提取、向量索引追赶 → 挂在 `after-reply`
- 演绎发言人选择 → 挂在 `before-send`

**增益**：
- `generation.ts` 从「知道所有功能」退化为「只跑管线」，预计能缩到 200 行以内；
- 新功能不再改核心 store，冲突和回归面大幅缩小；
- 单聊 `send` 与演绎 `sendGroup / generateOne` 共用同一管线，消除两套近似流程；
- 每个钩子可单测，现有 `verify:*` 脚本可直接对插件做断言。

### 4.2 模型提供方 / 生图后端插件化

**做法**：定义 `LLMProvider`、`ImageBackend` 服务接口，每个后端一个插件，自带：请求实现、配置 Schema（驱动编辑表单）、能力声明（是否支持流式、参考图数量、比例、工具调用）。

```ts
interface ImageBackend {
  id: 'openai' | 'comfyui' | string
  schema: ConfigSchema            // 驱动 ImageModelEditor 表单
  capabilities: { maxRefs: number; aspect: 'free' | 'square-only' }
  validate(cfg): void
  generate(args, ctx): Promise<Blob[]>
}
```

**增益**：
- 去掉散落在 service / repository 白名单 / UI 组件里的 `backend === 'comfyui'` 分支；`ImageModelEditor.vue` 按 Schema 渲染；
- 接入 Ollama 原生、Claude/Gemini 原生协议、其他本地生图（SD WebUI、Flux）只需加插件，不碰已有代码；
- ComfyUI 的特殊知识（第一张参考图决定比例、≥3 张降到 768、`<imageN>` 标签对齐）封装在插件内部，能力通过 `capabilities` 暴露给 UI，而不是 UI 自己猜。

### 4.3 平台服务注入 + Profile

**做法**：把 `isTauri` 分支收敛成 `ctx.platform` 服务（`fetch`、`download`、`scanQR`、`fs`、`signaling`），按运行环境装不同实现。再仿 dsh 的 base + profile 组合：

| Profile | 组合 |
|---|---|
| desktop | base + tauri-platform + window-state |
| android | base + tauri-platform + barcode + 返回键/手势 |
| web | base + web-platform（受 CORS 限制的能力标记为不可用） |
| headless | base + node-platform + mock-provider（给 `verify:*` 和 CI 用） |

**增益**：
- 调用方不再写 `if (isTauri)`；新平台只加一个实现；
- **headless profile 可以在不开浏览器、不动真实 IndexedDB 的情况下跑完整生成流程**，直接规避此前「浏览器自动化误删用户对话」那类事故；
- Web 端能力降级集中声明，UI 可统一置灰，而不是运行时报错。

### 4.4 功能开关代替删代码

**做法**：快速回复、正则替换、SD 生图、滚动摘要、RAG 等以插件存在，设置里按角色/全局启用。

**增益**：
- 功能下线变成配置而非不可逆删除，恢复成本从「翻 git 历史重写」变成「打开开关」；
- 与已改成「角色级」的提示词注入配置天然契合：插件配置可以按角色作用域覆盖；
- 移动端可以默认关掉重功能（向量索引、transformers.js 嵌入）节省内存。

### 4.5 生命周期与副作用自动回收

Cordis 的 `Context` 会在插件卸载时回收它注册的监听、定时器、Worker、AbortController。

**增益**：
- 流式生成的 `stop()`、`armStall` 超时守卫、向量 Worker（`embedder.worker.ts`）、同步会话（`sync/session.ts` 的 WebRTC/信令）都能挂在各自作用域下，切换对话/角色时自动清理；
- 减少「切走后后台任务仍在写库」这类竞态。

### 4.6 工具调用 / Agent 循环（可选的新能力）

dsh 的 Agent 循环是「模型 → 工具调用 → 结果回填 → 再推理」。本项目可以借来做：

- 角色主动调用 `generate_image` 画当前场景（现在是用户手动点 / `promptFromLLM` 单次转写）；
- 角色调用 `update_status` 写状态卡，替代「回复末尾 `<status>` JSON + 正则剥离」；
- 调用 `recall_memory` 按需检索会话记忆，而不是每轮都注入。

**注意**：这要求 `openaiCompatible` 补 `tools` 支持，且大量第三方中转/本地模型的 function calling 不稳定，必须保留当前「文本约定」路径做兜底。这是**新特性**，不是重构收益，优先级放后。

### 4.7 审批策略

仿 dsh 的 sandbox/approval：对有成本或副作用的操作（调用付费生图、局域网 ComfyUI 请求、写导出文件、同步推送到另一台设备）走统一策略层：`allow / ask / deny`。

**增益**：与 4.6 配套时必需——角色自动调生图若没有审批，会在后台烧额度或把 6GB 显卡卡死；统一做比每处加确认框干净。

---

## 5. 增益汇总

| 方向 | 收益 | 改动量 | 风险 | 建议 |
|---|---|---|---|---|
| 4.1 生成管线钩子化 | 高 | 中 | 中（核心路径） | 优先做 |
| 4.2 Provider/生图后端插件化 | 高 | 中 | 低 | 优先做 |
| 4.3 平台服务 + headless Profile | 中高 | 中 | 低 | 第二批 |
| 4.4 功能开关代替删除 | 中 | 低（依赖 4.1） | 低 | 随 4.1 做 |
| 4.5 生命周期自动回收 | 中 | 低 | 低 | 随 4.1 做 |
| 4.6 工具调用 / Agent 循环 | 新能力 | 高 | 高（模型兼容） | 视需求 |
| 4.7 审批策略 | 配套 4.6 | 低 | 低 | 配套 4.6 |

---

## 6. 代价与不适用之处

- **不宜直接依赖 dsh / Cordis**：dsh 是 developer preview，API 未稳定；它面向终端/仓库/沙箱，本项目用不到一大半。Cordis 本身可以用，但也可以只写一个百行级的轻量 `Context + 钩子 + 服务注册表`，零新依赖更稳（本项目依赖要锁版本、移动端包体敏感）。
- **与 Vue/Pinia 响应式的边界**：插件内部应只处理纯数据，响应式状态留在 store。进出边界必须 `toPlain()`，否则会重演「reactive 对象 `structuredClone` 失败 → `db.put` 静默不落库」的坑。
- **钩子顺序是新的隐性契约**：世界书、记忆、状态卡都往提示词里插内容，插件多了以后顺序和优先级必须显式声明（参考 ST 的 order/depth），否则会出现提示词顺序漂移。
- **调试链路变长**：串行代码一眼能看懂，事件驱动需要配套的管线日志（每阶段输入/输出、耗时），否则排错反而更难。
- **不解决 UI 大文件**：`GroupEditView.vue`、`ImageGenerationDialog.vue` 的体积问题靠组件拆分，与 Harness 架构无关（4.2 的 Schema 驱动表单能让 `ImageModelEditor.vue` 顺带瘦身）。

---

## 7. 渐进迁移路径（参考）

1. **内核**：新增 `src/core/`（`Context`、`plugin()`、`on/emit`、`provide/inject`、`dispose`），纯 TS、带单测。
2. **Provider 接口**：把 `openaiCompatible` 包成第一个 `LLMProvider` 插件，`generation.ts` 改为从服务取 provider，行为不变。
3. **生图后端**：`openai`、`comfyui` 改为 `ImageBackend` 插件，`ImageModelEditor.vue` 按 Schema 渲染；`settings.ts` 的白名单改为读注册表。`verify:comfy-graph`、`verify:image-generation` 作为回归。
4. **生成管线**：先定义阶段事件，把状态解析、记忆提取、向量追赶逐个从 `generation.ts` 迁成 `after-reply` 插件；每迁一个跑一遍 `verify:status / verify:group-mentions`。
5. **平台服务 + headless**：收敛 `isTauri` 分支，补 node 实现与 mock provider，把现有 `verify:*` 改成走 headless 管线。
6. **可选**：`tools` 支持 + 审批策略 + `generate_image / update_status` 工具。

每一步都可以单独合入、单独回滚，不需要停下来做大迁移。

---

## 8. 参考

- deepseek-ai/deepseek-harness `docs/architecture.md`：https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- DeepSeek Harness developer preview：https://deepseek.com/harness/en/
- DataCamp，DeepSeek Harness Explained: Cordis and Plugin Architecture：https://www.datacamp.com/blog/what-is-deepseek-harness
- SitePoint，Everything-is-a-Plugin Developer Preview：https://www.sitepoint.com/deepseek-harness-developer-preview/
- freeCodeCamp，What Is an Agent Harness?：https://www.freecodecamp.org/news/what-is-an-agent-harness/
