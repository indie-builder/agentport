# TencentDB Agent Memory 调研：记忆分层、接口与 WeKnora 知识库的关系

> 2026-10-25 静态源码调研，只读 GitHub API，未克隆、未安装、未运行任何上游脚本或服务。固定 commit `6a4bb55ea54834d8265ce52024d3e3c75db30d38`（默认分支 `feat/server_team`，2026-10-21），下文路径链接均指该 commit。未实测的结论标「未核实」。配套：[WeKnora 建设方案](weknora-core-proposal.md)、[WeKnora 检索/Wiki](weknora-core-retrieval-wiki.md)。

## 摘要

1. 项目身份确认：`TencentCloud/TencentDB-Agent-Memory`；旧路径 `Tencent/TencentDB-Agent-Memory` 经 GitHub 重定向到同一仓库（`gh api` 返回 `full_name` 已改写），不是另一个项目，也不是 Hy-Memory（README/LICENSE 全文无该词）。
2. 仓库名里的 "TencentDB" 是产品品牌；开源默认存储是 SQLite + 本地文件，`TencentDB` 数据库本身不是运行依赖（另有 MongoDB 实验后端和 TCVDB 迁移脚本）。
3. 真实记忆分层是四层：**L0 Conversation / L1 Atom（episodic、persona、instruction 三类）/ L2 Scenario / L3 Core/Persona**，不是常见 raw/episodic/semantic/profile；另有 context offload 模块使用 L1/L1.5/L2/L4，属不同的上下文压缩命名，不能混为一谈。
4. 记忆本体是「写入 L0 → 异步抽取 L1 → 场景 L2 → 人格 L3」；检索是 FTS5 BM25 + 向量 + RRF，带条数/字符预算/超时上限；删除是显式 API + 可选 TTL，没有找到基于衰减评分的自动遗忘。
5. Chat Memory、Skill、LLM-Wiki 有落地代码与接口；CodeGraph 是桥接上游 `colbymchenry/codegraph`（MIT）的实现，未验证索引引擎是否完全自研。
6. 它**没有自己的 agent loop**：README 明确 MemoryCore `does not host, schedule, or execute the Agent`；Proxy 只做透明的 LLM 请求转发与注入。但它要求在 LLM 请求路径上插一个反代，这是接入 Claude Code 的唯一自动方式。
7. 没有面向 Claude Code 的官方 `MEMORY.md`/`.claude/agents`/filesystem 集成；Claude Code 走 `ANTHROPIC_BASE_URL` 指向 Proxy + `~/.claude/settings.json` 的 `env`。
8. MCP 只覆盖 Knowledge（wiki/code-graph 12 个工具，stdio 转发 HTTP），**没有记忆读写 MCP server**；记忆注入靠 Proxy 改 system prompt。
9. 与 WeKnora 重合：Wiki、代码图、外部数据源、团队/Agent 管理；互补：WeKnora 强在文档解析/OCR/引用定位/多种数据源，本项目强在对话记忆分层与资产治理。PACE 需要的是「独立记忆服务 + 独立知识检索 + 官方 MCP/文件投影」，不宜整体引入其 Proxy 与 Panel。
10. 许可证：LICENSE 正文是 MIT（前置 Tencent 声明，GitHub 识别为 NOASSERTION）；致谢声明 CodeGraph 与 Hermes Agent 代码被复用，两者上游为 MIT；主仓未提供 NOTICE/第三方清单，分发前需按实际依赖核对。
11. 对 PACE 的直接价值：L0→L1→L2→L3 的抽取阈值、字符预算、去重、Prompt 分层覆盖是可借鉴契约；Proxy 注入与 Panel 资产绑定属于应自建的平台侧能力。
12. 本轮未发现可直接替换 Claude Agent SDK 或 Claude Code 官方记忆能力的证据；建议按「记忆服务只提供 REST/MCP，harness 仍用 SDK」的方式评估，不复刻其 Proxy。

## 1. 身份、固定点与许可

| 项 | 值 | 证据 |
|---|---|---|
| 仓库 | `TencentCloud/TencentDB-Agent-Memory`，默认分支 `feat/server_team` | `gh api repos/...` |
| 旧路径 | `Tencent/...` 301 重定向至 `TencentCloud/...` | 同一 API 返回 `full_name: TencentCloud/...` |
| 固定 commit | `6a4bb55ea54834d8265ce52024d3e3c75db30d38`（fix(panel): report generated User Key copy failures #1673） | API commits |
| 发布 | 最新 `v2.0.3-beta.1`（2026-10-13，tag commit `badbd217...`）；最新非 beta `v2.0.2`（2026-10-09）；`v2.0.0` 2026-08-03 | releases/tags |
| 许可 | 根 `LICENSE`：Tencent 声明 + MIT 全文；`MemoryCore/package.json` 为 `MIT`；GitHub license 字段 `NOASSERTION` | [LICENSE](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/6a4bb55ea54834d8265ce52024d3e3c75db30d38/LICENSE) |
| 附加依赖 | README 致谢称 CodeGraph 模块与 Skill 管理「uses code from」`colbymchenry/codegraph` 与 `NousResearch/hermes-agent`（两者仓库 license=MIT）；无 NOTICE/THIRD-PARTY 文件 | 根 README Acknowledgements |
| 运行时 | Node `>=22.16.0`；MemoryCore npm 包 `@tencentdb-agent-memory/memory-tencentdb-v2` 标 `MIT` | `MemoryCore/package.json` |

## 2. 真实记忆分层（按原文）

- **L0 Conversation**：原始对话全文与时间戳，用于核对原话与来源（[v3 API §3.1](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/6a4bb55ea54834d8265ce52024d3e3c75db30d38/MemoryCore/v3-api-memorycore-doc.md)）。
- **L1 Atom**：从对话抽出的原子记忆，`type` 仅 `episodic` / `persona` / `instruction` 三种；有 `background`、`content`、版本号。
- **L2 Scenario**：按项目/场景组织的 Markdown 场景文件，支持目录树、`summary`、版本、全量列举（`/v3/scenario/ls|read|write|rm|count`）。
- **L3 Core / Persona**：单份 `persona.md`，稳定画像与高层认知，读写走 `/v3/core/*`。
- **Proxy 的注入口径**与 Core 略有差异：Proxy README 把 L1 称为「session-level key memory（模型按需工具召回）」、L2 称「Agent Profile 注入 system prompt」、L3 称「Team/Global memory 注入」。两处命名不完全一致，引用时须注明出处。
- 另有 `src/offload/` 上下文卸载模块，内部用 L1/L1.5/L2/L4 表示工具输出压缩级别，与上述记忆分层无关（[src/offload/index.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/6a4bb55ea54834d8265ce52024d3e3c75db30d38/MemoryCore/src/offload/index.ts)）。

## 3. 写入 → 抽取/压缩 → 存储 → 检索 → 更新/遗忘/删除

**写入**
- 在线：Proxy 在每轮结束后调用 Core，把对话切片写 L0，并同步调 `/v3/skill/conversation/add` 做 Skill 归档（[MemoryProxy/README.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/6a4bb55ea54834d8265ce52024d3e3c75db30d38/MemoryProxy/README.md)）。
- 轮次对象：`/v3/session/add`，`source: online|offline`，body ≤32 MiB，写 `sessions/<source>/<team>/<user>/<session>/<started_at>-<id>.json`；**不幂等**，重试会重复写。
- 批量：`/v3/conversation/add`，每次 1–100 条消息，成功后 `notifyPipeline` 异步触发 L1。

**抽取与压缩（阈值取自 [src/config.ts](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/6a4bb55ea54834d8265ce52024d3e3c75db30d38/MemoryCore/src/config.ts)）**
- L1：后台抽取默认开启，`enableDedup=true` 智能去重，单会话上限 `maxMemoriesPerSession=20`；offload 路径下待处理工具对 ≥4 强制触发，单批最多 20 对。
- L2 场景层：配置中 `l2DelayAfterL1Seconds=10`、`l2MinIntervalSeconds=900`、`l2MaxIntervalSeconds=3600`；`persona.maxScenes` 默认 **15**，场景备份10份。`l2NullThreshold=4` 属于 **offload** 配置，不能当成场景记忆管线已核实的触发条件。实际调度还需跟踪pipeline实现，本轮不把配置值等同运行结果。
- L3：每累积 50 条新记忆生成一次（`triggerEveryN`），备份 3 份；可选 `triggerMode=jev` 在 L2 更新后即时判定是否刷新 L3（默认 `current`，按累计计数）。
- 「压缩」在代码里有两个不同含义：L2 场景归纳，以及 offload 的上下文压缩（0.5 温和 / 0.85 激进压缩比）。二者不能相互替代。

**存储**
- MemoryCore：SQLite + 本地文件，默认目录 `~/.memory-tencentdb/memory-tdai`；FTS5 提供 BM25（Node 二进制若无 FTS5，关键词检索会静默返回空，只能退回向量）。
- 可选：MongoDB 后端（实验，`start-all-mongo.sh`，含 mongot 原生 BM25），SQLite 与 Mongo 之间**不自动迁移**。
- 随包提供 `migrate-sqlite-to-tcvdb` / `export-tencent-vdb` 脚本，说明 Tencent Cloud VectorDB 是可选目标；默认是否启用未核实。
- MemoryKnowledge：独立 SQLite（`knowledge_wiki`、`knowledge_code_graph`、审计表）+ 数据目录（clone、wiki 素材、BM25 索引）。
- 云端形态另有 COS + kernel-sts 作为 Proxy/SaaS 存储后端。

**检索**
- L1：`keyword`（FTS5 BM25）/ `embedding`（向量余弦）/ `hybrid`（RRF 融合），默认 hybrid。
- 默认 `maxResults=5`、`scoreThreshold=0.3`、单条与总字符预算、整体超时 5000ms，超限降级跳过。
- L2 全量注入 + 场景导航（由模型判断相关性）；L3 直接注入 system prompt。注入的 `memory-tools-guide` 限定每轮 `tdai_memory_search` + `tdai_conversation_search` 合计 ≤3 次。
- 关键词检索依赖 FTS5；跨库/多租户过滤靠 `team/agent/user/task` 四元组。

**更新 / 遗忘 / 删除**
- 更新：`/v3/atomic/update`（版本自增，注意 update 返回字符串 `"v{n}"`、query/search 返回 number）、`/v3/scenario/write`、`/v3/core/write`；Skill 用乐观锁 `expected_version`。
- 删除：`/v3/conversation/delete`（≤5000 message 或 ≤100 session）、`/v3/atomic/delete`（≤5000）、`/v3/scenario/rm`、`/v3/chat-memory/clear`（清空 L0–L3 内容但保留资产/ACL）。
- 遗忘：只有 `capture.l0l1RetentionDays` TTL（默认 0=关闭，非零须 ≥3 天）+ 每日 03:00 cleaner；**未找到**基于时间衰减、访问频率或置信度的自动遗忘/降权机制（未核实，仅按 config 与 API 表面判断）。
- 记忆与资产分离：删除内容不等于撤销资产的归属与绑定；`expires_at` 只出现在 `meta_asset` 上。

## 4. 四个资产的实际实现程度

| 资产 | 结论 | 证据 |
|---|---|---|
| Chat Memory | 已实现：L0–L3 全链路 + 面板列表/时间筛选；L1–L3 编辑、L0/L1 搜索在 Roadmap（未发布） | v3 API 109 接口、[ROADMAP.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/6a4bb55ea54834d8265ce52024d3e3c75db30d38/ROADMAP.md) |
| Skill | 已实现：17 个接口，`SKILL.md` 全文 + resources（≤100）+ 版本 + 状态 + 去重/配额 + 对话抽取归档 | v3 API §3.2 |
| LLM-Wiki | 已实现：文档 → LLM 抽取结构化页面 → FTS5 + 链接图；状态机 `draft→pending→processing→ready/failed`；16 接口 + 12 个 MCP 工具中的 4 个 wiki 工具 | [MemoryKnowledge/README.md](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/6a4bb55ea54834d8265ce52024d3e3c75db30d38/MemoryKnowledge/README.md) |
| CodeGraph | 部分自研 + 上游桥接：`src/engines/code/bridge.ts` 调用 CodeGraph；仅公网 HTTPS 仓库优先，私有仓/SSH 仍在完善 | README Notes + 致谢 |

## 5. 本地与云依赖、接口、scope

- **最小本地依赖**：Node 22.16+、一个 OpenAI 兼容 LLM（抽取/生成）；embedding 可关闭（默认关闭远程 embedding，靠 BM25）。不需要 Postgres、Redis、向量库。完整三件套（Core 8420 + Hub 8125/8424 + Proxy 8096）用 Docker 镜像 `agentmemory/memory-{core,hub,proxy}`；MongoDB 可选，ClickHouse/Langfuse/Opik 可选。
- **记忆 API**：全部 `POST /v3/*`，信封 `{code,message,request_id,data}`；鉴权 `Authorization: Bearer <KERNEL_AUTH_TOKEN>` + `x-tdai-service-id`，元数据面再加 `x-tdai-user-key`；数据面强制 `team_id + agent_id + user_id`，`task_id` 可选，缺省回落到 `default` 桶。`/v3/session/add` 例外：身份只从 Header 取。
- **知识 API**：`POST /v3/wiki/*`（16）、`/v3/code-graph/*`（14）、`/v3/tools/list|call`（2）、`/v3/internal/llm-binding/*`（3）、`/v3/auto-sync/*`（2）；信封无 `request_id`；鉴权仅 `x-tdai-service-id`（可选 Bearer）。
- **Proxy**：`POST /:agent/:spaceId/v1/messages`（Anthropic）与 `/v1/chat/completions`（OpenAI）原样转发；管理面仅有 6 个 `/v3/*` ops 接口，其中 4 个无鉴权（源码注释与实现不一致）。
- **MCP**：只有 `MemoryKnowledge/bin/mcp.mjs` → `src/mcp/server.ts`，stdio，工具转发到本机 HTTP；工具为 `code_search/code_explore/code_callers/code_callees/code_impact/code_node/code_status/code_files` 与 `wiki_search/wiki_read/wiki_list/wiki_graph`。**没有 memory 的 MCP server**。
- **Scope 维度**：Team / Agent / User / Task（不是 project）；资产可见性 `private|team|restricted|agent`，ACL 按 User/Role/Agent。服务端只有 `x-tdai-service-id` 区分实例，没有独立项目概念。

## 6. Agent loop 与 Claude Code 集成

- **不自带 agent loop**：`MemoryCore` README 原文「An Agent is a caller and a managed metadata entity; MemoryCore does not host, schedule, or execute the Agent itself.」Proxy 也自称透明反代，只加 session init、注入、回写、鉴权、计费。
- 因此「只做记忆服务、不另造 harness」在协议上成立：可只跑 MemoryCore + 自建 MCP/REST 适配；Proxy 只是为「改一行配置就接入」提供的旁路。
- **Claude Code 官方集成**：没有 `MEMORY.md`、`.claude/agents/*.md`、`SKILL.md` 目录注入或 filesystem 挂载。官方做法是 `ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default` + `ANTHROPIC_AUTH_TOKEN=sk-mem-...`，或写 `~/.claude/settings.json` 的 `env`；首次会话用 CC 原生 `AskUserQuestion` 让用户选 team→agent→task；session id 取 `x-claude-code-session-id`。
- 历史会话导入：`agents/claude-code/asset-import.md` 说明把本地历史灌成资产，属一次性导入而非运行时集成。
- 代价：必须让 CC 的模型流量过代理，等于把模型网关交给第三方组件；这与 PACE「模型代理 + 沙盒 + 官方 SDK」自建路径重叠且可能冲突。

## 7. 与 WeKnora 知识库 / Wiki / Feeds 的重合与互补

- **重合**：Wiki 自动生成与链接图、代码索引/影响分析、外部源导入（KS 有 wiki-source `iwiki`、code-source Git/SSH/Basic/Bearer；Core 有 TAPD/Jira 任务源）、团队/Agent/成员管理、面板。
- **WeKnora已核实覆盖**：文档解析/OCR、chunk来源定位、多数据源、检索配置与引用回跳；这些是两项目职责比较，不代表经测试证明质量更强。
- **TencentDB候选具有**：对话记忆 L0–L3 分层、抽取触发配置与不同层级的注入策略，以及Skill版本和资产scope。此处不是说PACE已实现这些能力，也没有同样本质量比较结论。
- **Feeds**：Tencent Memory 没有订阅源摄取；其 Auto-Sync 只针对 code-graph 定时拉 git，不可当 RSS/Atom 用。
- **结论**：记忆与知识是两条管线，共享团队/Agent scope 与资产台账，但数据模型、检索路径、生命周期不同。PACE 已确认的 WeKnora 方案继续负责文档知识；记忆能力应作为独立服务另评，不并入知识库项目。

## 8. 可执行验证计划（本轮不跑）

1. 在独立受控构建/容器环境评估固定release，不从下载资料目录直接执行包脚本；先核对依赖与安装入口，再仅运行MemoryCore并连接获准模型或mock endpoint，验证健康状态与FTS5能力。下列接口实验本轮均未执行。
2. 用 curl 走 `/v3/conversation/add` → `/v3/atomic/query` → `/v3/scenario/ls` → `/v3/core/read`，核对 L1 抽取条数是否受 `maxMemoriesPerSession` 限制、去重是否生效。
3. 灌入互斥事实（如「用 Postgres」→「改用 SQLite」），检查 L1 是否新增而非改写、`atomic/update` 版本是否自增；再验证 `/v3/chat-memory/clear` 后资产与绑定是否保留。
4. 分别关掉 FTS5 与 embedding，记录检索退化行为（应回落到单一通道，而不是报错或全量返回）。
5. MCP：`KNOWLEDGE_API_URL` 指向本地 KS，用 `npx @modelcontextprotocol/inspector` 验证 12 个工具与 `data.isError` 语义（code=0 但 HTTP 500 的特例）。
6. Claude Code 对比实验：A 组直连 SDK，B 组经 Proxy，比较首轮注入内容、session 绑定、上下文膨胀与缓存命中；本轮不执行，避免污染当前环境与凭证。
7. 许可与依赖审计：对镜像做 SBOM，确认 CodeGraph/Hermes 复用部分的 MIT 声明在分发物中完整保留。

## 9. 未确认与风险

- 「TencentDB」在开源版是否为真实数据库依赖：仅有 TCVDB 迁移/导出脚本与品牌命名，默认路径未核实。
- CodeGraph 索引引擎自研比例、私有仓能力成熟度：README 自述仍在完善。
- 记忆「遗忘」是否还有未暴露在配置里的衰减逻辑：仅按 config/API 面判断「没有」，未逐文件读完。
- Proxy 管理面 4 个接口无鉴权是源码事实；照搬会把 LLM 网关暴露为未加固面。
- 记忆注入通过改写 system prompt 实现，CC 侧无法用官方 settings 关闭单次注入；与 PACE 的只读工作区、官方文件投影原则不匹配。
