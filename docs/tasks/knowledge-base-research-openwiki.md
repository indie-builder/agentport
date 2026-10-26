# OpenWiki 定向调研：brains、文件产物与 PACE 接入

调研日期：2026-10-25；仅静态读取官方仓库、GitHub API 与 Claude 官方文档，未安装或运行下载代码。
本地基线 `797edfea`；上游 main `305599f8e44203f9ca6b74bb6b38eebaf0b0405e`（commit 时间 2026-10-21）。下文功能以该 main 为准，**未保证全部进入 v0.7.2**。[上游提交](https://github.com/langchain-ai/openwiki/commit/305599f8e44203f9ca6b74bb6b38eebaf0b0405e)
范围：只新增本文件；原四份研究报告及并行产生的 `knowledge-base-research-weknora.md` 不属本次改动。不提交、不改产品代码；D-9 不变。

## 结论

**LangChain OpenWiki 已有通用个人知识 brain，不能仅归类为代码文档生成器；但其个人 brain 的自动整理仍依赖另一套 Deep Agents 执行循环。** 当前最契合 PACE 的路线是复用已生成 Markdown，投影到官方技能支持文件；代码 wiki 另有沿用宿主 Claude Code 循环的官方项目集成，但不能直接套到 PACE 的受限产品沙盒。[两种模式](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/README.md#two-modes)／[集成限制](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/README.md#coding-agent-integrations)

## 先辨认仓库

下表 stars、push 时间与 release 来自当日 GitHub API；push 不等于 main commit 时间，也不证明质量。

| 仓库 | 实际定位 | 活跃与发布快照 | 许可与本次取舍 |
|---|---|---|---|
| [langchain-ai/openwiki](https://github.com/langchain-ai/openwiki) | Node CLI；代码 wiki＋个人知识；Markdown/OKF＋宿主技能/MCP | 17,397 stars；push 2026-10-25；[v0.7.2，2026-10-09](https://github.com/langchain-ai/openwiki/releases/tag/v0.7.2) | [MIT 原文](https://github.com/langchain-ai/openwiki/blob/main/LICENSE)，本次主候选 |
| [vercel-labs/openwiki](https://github.com/vercel-labs/openwiki) | Next.js＋eve agent；为 GitHub 仓库生成公开 wiki/聊天，Neon＋Vercel Blob | 143 stars；push 2026-07-02；releases API 返回空数组 | API license=null，**许可未核实**；是另一个 Web 产品，不能代替 LangChain 项目的 brains 结论 |
| [AIDotNet/OpenDeepWiki](https://github.com/AIDotNet/OpenDeepWiki) | C# 后端＋Next.js，Git/ZIP/本地目录转仓库知识，聊天/嵌入/MCP；Microsoft.Agents.AI 编排 | 3,638 stars；push 2026-10-23；[v2.0.6，2026-09-08](https://github.com/AIDotNet/OpenDeepWiki/releases/tag/v2.0.6) | [MIT](https://github.com/AIDotNet/OpenDeepWiki/blob/main/LICENSE)；完整服务，非轻量 brains CLI |

定位来源：[Vercel README](https://github.com/vercel-labs/openwiki/blob/main/README.md)／[OpenDeepWiki README](https://github.com/AIDotNet/OpenDeepWiki/blob/main/README.md)。元数据可复核：`gh api repos/<owner>/<repo>`、`gh api repos/<owner>/<repo>/releases/latest`；Vercel 用 `/releases`。

## 知识是否文件、能否追源

- **代码模式**：仓库 `openwiki/` 下的 Markdown、链接与索引；`.claims/` JSON 记录事实及证据版本，`.page-manifest.json`、`.run.json`、`.last-update.json` 管理页面和更新；`INSTRUCTIONS.md` 是用户简报。`repo://src/server.ts#L40-L82` 等证据变化可触发重核，非仅靠 mtime。[README 架构与 Claims](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/README.md#how-it-works)
- **个人模式就是通用 brain**：`openwiki personal --init`；归纳跨来源的主题、承诺/待办、个人事务、未决问题、来源摘要与 quickstart。不是只解析代码，也不是一个向量库 SDK。[personal prompt 源码](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/agent/prompts/personal.ts)／[ingestion 合成指令](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/ingestion/ingestion.ts#L285-L385)
- 个人正文默认 `~/.openwiki/wiki/`，原始数据 `~/.openwiki/connectors/<connector>/raw/`，另有 `config.json`、`state.json`、logs、会话历史、`.env`；`OPENWIKI_CONFIG_DIR` 可整体改根目录。知识正文是文件，运行状态不全是 Markdown；不要导入含凭证的整个 home。[路径实现](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/config/openwiki-home.ts)
- 来源通过 connector ID、raw 文件、source 页面和引用保留；个人 ingestion 指令要求来源/日期、冲突与置信标签。**这些提示约束不等于可靠性实测，更不等于代码 Claims 的版本证据保证**；README 明确 Grounded Claims 目前只覆盖仓库证据，connector facts 不在其中。[Claims 范围](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/README.md#grounded-claims)
- 两种模式都输出 Google OKF v0.2：Markdown frontmatter、`type`、`sources`、`generated`、可选 `verified/status/stale_after`；标准链接表达关系。**OKF 是 Google 的格式；OpenWiki 私有状态目录及字段不是 Claude 官方定义**。[OKF 原规范](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)／[生产者说明](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/README.md#open-knowledge-format-okf-v02)

## 生成、读取与接口

| 路线 | 谁调用模型/写知识 | 对外接口与限制 |
|---|---|---|
| 原生 CLI code/personal | OpenWiki 自己的 Deep Agents；init/update/chat/ingest | CLI，个人数据源连接、调度与可视化；需要其状态目录与模型配置 |
| 官方项目维护的 Claude Code 集成 | **宿主 Claude Code** 研究源码并写每页；OpenWiki 做确定性队列/Claims/收尾 | `openwiki integrations install claude --project` 安装 `.claude/skills/openwiki/SKILL.md` 和 `.mcp.json` stdio；当前仅代码仓库，非个人 brain/connector 内容 |
| 只读检索 | 不调用模型，不启动生成 | MCP `openwiki_search`/`openwiki_read`，另有 list_workspaces/list_wikis；搜索返回紧凑排名引用，再按标题锚点读完整 section |
| 静态产物 | PACE 的 Claude Agent SDK 读 Markdown | 不必运行 OpenWiki；没有自动抓源、合并和 Claims 更新，需要人工/外部更新 |

集成是 **OpenWiki 官方提供的第三方技能**，不是 Anthropic 内置技能；其标准位置及支持文件机制符合 [Claude Skills 官方文档](https://code.claude.com/docs/en/skills)。`openwiki/`、`INSTRUCTIONS.md`、`.claims/`、`~/.openwiki` 都不能称为 Claude 原生目录。

宿主生成协议：`begin → submit_plan → next_page → submit_page → … → finish`，还有按需 `inspect_page_claims`；这套确定性生命周期本身无需第二个 LLM loop。[技能完整协议](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/integrations/openwiki/SKILL.md)／[注册器与安装命令](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/integrations/install/registry.ts)

只读实现不是向量 RAG：每次搜索扫描 wiki Markdown，切出 section，在 **Node `node:sqlite` 内存 FTS5** 建索引，以 BM25、词覆盖及源码路径提示排序；读工具按 page/heading 返回。查询使用 Unicode 字母数字词，FTS tokenizer 为 `porter unicode61`；**没有据此宣称中文分词或语义召回好**。[检索源码 L433-L599、L928 起](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/retrieval/wiki.ts)

MCP 传输已核实为 stdio：`openwiki mcp --host claude`。默认工具集合同时含读工具和生成生命周期，不能把整个 server 称为只读服务。[stdio](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/integrations/mcp/stdio.ts)／[完整工具集](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/integrations/core/session-manager.ts#L218-L270)

**未发现稳定通用 REST 知识库 API 或官方 HTTP MCP server**：README 对外路线是 CLI/stdio MCP；`visualize` HTTP 只监听 127.0.0.1，是图谱查看器，不是远程检索服务。不能拿“它会连接外部 MCP”推断“它提供 HTTP MCP”。[可视化 server](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/visualize/server.ts#L1-L15)

## 实际依赖：安装、执行与纯产物要分开

- npm 主包要求 **Node ≥22.22.0**，源码是 TypeScript/JavaScript；未见 Python 为主产品运行前提。`evals/*.py` 不意味着部署必须 Python；原生依赖编译的工具链另算。[package.json](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/package.json)
- 主包直接依赖 `deepagents=1.13.2`、`langchain`、`@langchain/*` 模型适配器及 `@langchain/langgraph-checkpoint-sqlite`；lock 中 deepagents 依赖 `@langchain/langgraph=1.4.13`。`src/agent/index.ts` 实际调用 `createDeepAgent`、`SqliteSaver`，不是只在 README 挂徽标。[运行源码](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/agent/index.ts#L1-L15)／[锁文件](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/pnpm-lock.yaml)
- **原生 code/personal 生成确有另一套模型循环**；宿主技能＋MCP 生成及 read/search 本身没有独立模型调用，但完整 npm 安装仍带上述依赖。CLI 顶层静态导入 runners/App，不能承诺仅启动 MCP 时连模型库都不加载。[CLI 入口](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/cli/cli.tsx#L1-L54)
- 只搬 Markdown 到 PACE：产品侧无需 Node OpenWiki 包、Python、Deep Agents/LangGraph、embedding 服务或向量数据库。**保留引用文本不等于保留上游自动证据核验功能**；`.claims` 和原仓库版本上下文留在原生成环境。
- MIT 复用代码/技能须保留许可通知；上游连接源的访问授权与内容许可另核。GPL/AGPL 也不能简单推论为“独立 HTTP API 调用方全部开源”；本次三个候选没有以此作为否决依据。

## PACE 的真实接入成本

本项目是单管理员；以下约束来自代码，不能套用多租户产品的否决理由。

| 本项目边界 | 对 OpenWiki 的具体影响 |
|---|---|
| [文件 hook](../../packages/sandbox/src/memory-permissions.ts:36)、[runner](../../packages/sandbox/src/runner.ts:174) | 主会话 Read 仅普通 `.md` 记忆/`.claude/skills/<slug>/references/**`；Grep/Glob/Bash 固定禁用，子智能体文件访问也拒绝。不能按上游技能 fallback 去搜 `openwiki/`，也不能研究源码/写页面 |
| [worker 快照](../../packages/worker/src/index.ts:116)、[挂载约定](../ARCHITECTURE.md:167) | 每 run 从 DB 重建且 `/workspace` 只读；手工塞目录不会成为持久编辑来源。上游生成需可写目录，不能让 MCP 写定义快照绕过限制 |
| [技能资源 schema](../../packages/shared/src/agent.ts:125) | 文本资源；路径仅 ASCII 安全集，最长 200 字符；单文件 `content` 最多 200,000 字符；运行可 Read 的还必须是 `.md`。中文标题正文可保留，中文文件名须映射 ASCII，并修链接 |
| [专家包限制](../../packages/shared/src/agent-package.ts:15)、[导入解析](../../packages/api/src/features/agent-package.ts:680) | ZIP ≤1 MiB，解压总量 ≤4 MiB，≤6,000 条目，每 skill ≤50 资源；只认声明的官方文件路径，根 `openwiki/` 会拒绝。50 文件是专家包往返限制，不能误称资源 CRUD 的同一硬上限 |
| [技能单文件导入](../../packages/api/src/features/skills/routes.ts:20) | `skillMd` 入口只导入 SKILL.md，≤131,072 字符；支持资源要走各自 CRUD/专家包，不能把整仓库 ZIP 交给这个入口 |
| [HTTP 创建校验](../../packages/api/src/features/servers/routes.ts:119)、[worker URL 改写](../../packages/worker/src/index.ts:111) | http server 创建同样走 SSRF；只有 generated URL 被自动改写成沙盒可达平台地址。普通 http 不会自动变成 `${SANDBOX_API_URL}`，内网服务接入必须单独验证可达/准入/认证 |
| [沙盒镜像](../../packages/sandbox/Dockerfile:3) | Node 24 已有；未显式安装 OpenWiki 或 git。stdio 需要镜像预装和数据挂载；不能假设 worker 宿主的 CLI 可供 SDK 执行 |

原版检索每次先用 `git rev-parse --show-toplevel` 解析根目录，页面预期在该仓库 `openwiki/`。因此它**不是任意 `references/` 或个人 `~/.openwiki/wiki` 的现成搜索服务**。[根目录验证](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/integrations/core/repository-root.ts#L20-L33)／[retrieval 输入](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/integrations/core/retrieval-tools.ts)

## 条件推荐与工作量估计

估计为工程判断，非已验证工期；数据清洗、真实模型验收与内容规模决定实际成本。

| 选项 | 最小完整改动与代价 | 判断 |
|---|---|---|
| **A：只复用 Markdown** | 现有技能＋资源 CRUD，无新服务/运行依赖/权限修改；将正文与目录索引放 `references/`，SKILL.md 指向索引，修相对链接/ASCII 路径，保留来源/日期与生成版本；小样本整理约半天，含可重复导入/真实问答验收约 1–2 人日 | **优先**；适合少量稳定文档，接受人工更新及按目录阅读。不需要先推翻 D-9 |
| B：原版只读 MCP 消费代码 wiki | 镜像装 OpenWiki＋git，额外只读挂载真正仓库/wiki，设置可写配置/运行目录，登记 stdio；只批准 search/read/list，拒绝生成工具；验收 Node FTS5/native 依赖、路径与源隔离。约 2–4 人日 | 需要排名且对象确为代码 wiki 才试；无第二 LLM loop，但包依赖与目录成本仍在，不能直接吃现有 skill references |
| C：官方 Claude Code 技能生成代码 wiki | 在**独立可写研发仓库**用官方集成；沿用 Claude Code 模型循环，产物再按 A 导入 | 本地研发工具可用；不能直接变成 PACE 产品内自动知识整理。技能单文件本身不含 MCP 后端 |
| D：个人 brains 自动抓源/维护 | 原生 personal CLI＋凭证/OAuth/raw 数据/SQLite 会话/调度；约数日以上部署及验证，另有模型费用 | 功能已具备，但嵌进产品会引入 Deep Agents/LangGraph 循环，**不符合当前单 Harness 约束**；若用户自行外部生成，PACE 可仅消费 A 的产物 |

若知识量或更新频率使 A 无法满足，先拿真实查询评估 B/外部检索；不要为“接上 OpenWiki”先造 REST 包装或改为第二套 agent。只消费来源 Markdown 与导航，不导入其 `.env`、OAuth、会话数据库或私有运行元数据。

## 验证、缺口与下一步

- 已验证：GitHub metadata/release API；官方 README/LICENSE/package/lock；原生 `createDeepAgent`/SQLite、MCP 协议及检索路径；本地读取权限、快照、导入上限、SSRF 与 URL 改写源码。
- 中文检索质量、中文 PDF/OCR、复杂 Office 解析均**未实测/未核实**；UI 多语言或生成语言选项不能证明这些能力。
- 当前 worktree 没有已安装 SDK `sdk.d.ts` 可读；未改 SDK 调用，不将类型存在当运行验收。references 实际模型按需读取、MCP resources 可用性均仍待真实调用验证；本建议用工具而非假设 resources 已接通。
- `blog.langchain.com/openwiki/` 重定向后的官方页面返回 404，未引用其历史宣传；结论以已固定 main 源码为准。Vercel 许可、v0.7.2 与 main 的逐项差异未核实。
- 文档静态校验：文件 ≤150 行、链接路径与范围检查；无产品代码变化，未运行构建、模型调用或外部软件。
- 下一步仅在决定实施后：选 5–10 份已生成 Markdown，经现有技能资源入口导入，验收“按索引找到正确页、引用可追溯、拒绝越界、重跑快照仍存在”；再决定是否需要检索服务。
