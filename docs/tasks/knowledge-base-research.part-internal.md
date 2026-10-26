# 知识库接入调研（事实与约束）

> 只读调研，2026-10-25。区分「读到的事实」与【推断】。无方案推荐。

## 结论摘要

- 平台当前没有任何「知识库 / RAG / chunk / embedding / 向量列」实现，唯一显式决策是 **D-9：不做内置 RAG，流程性知识用 `SKILL.md`，文档检索交给 MCP resource 或外部检索服务**（`docs/DECISIONS-PENDING.md:83-85`）。
- 现状中与「知识」最接近的三种载体是：`CLAUDE.md` + `.claude/rules/*.md`（每次会话进上下文）、`SKILL.md` 及其支持资源（渐进披露，按需读）、原生 auto-memory（`MEMORY.md` + 主题 `.md`，跨 run 持久且模型可读写）（`packages/core/src/workspace.ts:208-276`、`packages/worker/src/index.ts:171-186`、`packages/api/src/features/agents/memory-files.ts:13-16`）。
- 数据库是纯 Postgres 18-alpine，**无 `CREATE EXTENSION`、无 pgvector、无 tsvector/全文索引**，迁移用 drizzle-kit generate + drizzle-orm migrator（`docker-compose.yml:8-24`、`packages/db/migrations/*.sql`、`packages/db/drizzle.config.ts:1-10`、`packages/db/scripts/migrate.js:1-10`）。
- 智能体运行时把工作区 **只读** 挂到 `/workspace`，内置文件工具默认全部禁用；主会话只被允许 Read/Write/Edit 记忆目录、只读 Read 技能 `references/**/*.md`（`packages/worker/src/sandbox/docker.ts:84-89`、`packages/sandbox/src/runner.ts:174-184`、`packages/sandbox/src/memory-permissions.ts:12-14,47-73`）。因此「往工作区放知识文件」不会自动可读，必须扩权限。
- 唯一「模型可调用、平台可控」的运行时能力注入点是 **MCP**：HTTP→MCP 的 `generated` server（`packages/api/src/features/servers/mcp-endpoint.ts:20-62`、`generated.ts:139-283`）与平台自身暴露的 `/mcp`（`agent-tools-endpoint.ts:16-56`、`agent-tools.ts:31-78`）。工具许可按 server 名生成 `mcp__<name>__*`，`mcp__*` 通配无效（`ARCHITECTURE.md:169`、`packages/sandbox/src/runner.ts:172-184`）。
- 已有的文件式分发链路（专家包 ZIP、市场技能安装、`.mcp.json` 导入）**可复用于「知识内容分发」**，但都被白名单/体积卡死：包 1 MiB、解压 4 MiB、技能支持文件 50 个 / 单文件 200 KB；包内只认 `CLAUDE.md`、`.mcp.json`、`.claude/{settings.json,agents,rules,output-styles,skills}`（`packages/shared/src/agent-package.ts:16-41,23-30`、`packages/api/src/features/agent-package.ts:596-620`）。
- 基础设施缺口：**无对象存储 / 无 multipart 上传接口**（唯一二进制上传是 `application/zip` 的专家包导入，bodyLimit 1 MiB，`packages/api/src/features/import/routes.ts:19-23`）；单管理员、无租户隔离（`docs/SECURITY.md`、`DECISIONS-PENDING.md` D-10/D-21，`packages/api/src/features/auth/routes.ts:67-75`）；后台长任务只有 BullMQ run 队列与 eval 队列（`packages/worker/src/index.ts:735,772`）。
- 与第一性原则的张力可以拆成两类：官方目录里确实存在「知识合法载体」（`CLAUDE.md`、`rules/*.md`、技能支持文件、agent-memory），但**没有**任何官方文件约定 chunk/向量/索引；把 chunk 与 embedding 存 DB 不违反「文件是唯一投影」，前提是 DB 只是索引、知识正文仍能按官方文件导出成可移植 `.claude/` 包（`CLAUDE.md:9-16`）。

## 事实清单

| 能力 | 现状 | 证据 |
|---|---|---|
| 知识库/RAG 决策 | 明确「不做内置 RAG」，交给 SKILL.md / MCP resource / 外部检索 | `docs/DECISIONS-PENDING.md:83-85`；`docs/CAPABILITY-GAP.md:161,338` |
| 代码中是否存在 RAG/知识相关实现 | 无。`grep -riE 'knowledge\|rag\|embedding\|vector'` 在产品代码里只命中 connector 描述文案 | `packages/api/src/features/servers/connector-catalog-data.ts:33` |
| 全文检索（Postgres FTS） | 缺失。schema 无 `tsvector`、无 GIN 文本索引；仅有审计的 `text_pattern_ops` 前缀索引与消息复合索引 | `packages/db/src/schema.ts:297-302,515-524`；`packages/db/migrations/*.sql` 无 `CREATE EXTENSION` |
| 向量能力 | 缺失。无 pgvector 依赖、无 `vector` 列、compose 未装扩展 | `packages/db/src/schema.ts` 全文；`docker-compose.yml:8-24`；`packages/db/package.json` |
| Postgres 版本/镜像 | `postgres:18-alpine`（digest 固定），仅暴露 127.0.0.1:5432 | `docker-compose.yml:8-24` |
| 迁移工具 | drizzle-kit generate 产 SQL；运行时 `drizzle-orm/node-postgres/migrator`；compose 有一次性 `migrate` 服务 | `packages/db/drizzle.config.ts:1-10`、`packages/db/scripts/migrate.js:1-10`、`docker-compose.yml:52-64`；迁移共 33 个（0000–0032） |
| ID 约定 | TypeID `<prefix>_<uuidv7 base32>`，前缀表集中定义；新增实体需加前缀 | `packages/db/src/id.ts:7-31`；`CLAUDE.md:83` |
| 现有「知识」载体：CLAUDE.md | 由 `agents.system_prompt_md` 渲染，含工具/技能/子智能体清单 | `packages/core/src/workspace.ts:208-276,407-457`；`ARCHITECTURE.md:161,186` |
| 现有载体：`rules/*.md` | 有 CRUD + 落盘；`globs` 写 frontmatter `paths` | `packages/core/src/workspace.ts:92-108`；`packages/db/src/schema.ts:168-186`；`packages/worker/src/index.ts:187-198` |
| 现有载体：技能支持资源 | `skill_files` 表，路径安全相对路径，单文件 200 KB | `packages/db/src/schema.ts:142-162`；`packages/shared/src/agent.ts:126-136` |
| 现有载体：原生 auto-memory | `WORKSPACES_DIR/<slug>/agent-memory/`，rw 挂 `/mnt/agent-memory`；`autoMemoryEnabled=true`、`autoMemoryDirectory` | `packages/sandbox/src/runner.ts:58,317-321`；`packages/worker/src/index.ts:531-541,587-597`；`DECISIONS-PENDING.md:467-471` |
| 记忆的 API/UI | 列表/读/写/删；文件名白名单、200 KB 上限；前端「长期记忆」页签 | `packages/api/src/features/agents/memory-files.ts:8-21,104-228`；`packages/api/src/features/agents/routes.ts:576-650`；`packages/web/src/pages/agents.tsx:804,816,2159` |
| memory 召回事件 | SDK 会发 `memory_recall` 系统消息（select / synthesize） | `node_modules/.../claude-agent-sdk/sdk.d.ts:5417-5440` |
| 文件工具权限 | 内置工具默认禁用；主会话可读写记忆目录 `.md`、只读技能 `references/**/*.md`，其余拒绝 | `packages/core/src/workspace.ts:114-133`；`packages/sandbox/src/runner.ts:174-215`；`packages/sandbox/src/memory-permissions.ts:47-73` |
| 工作区挂载 | `/workspace:ro`；额外挂载仅 memory(rw) 与 sdk-sessions(rw) | `packages/worker/src/sandbox/docker.ts:33-49,84-89`；`packages/worker/src/index.ts:584-598` |
| SDK 调用位置 | 容器内 runner，`query({ cwd:'/workspace', settingSources:['project'], ... })` | `packages/sandbox/src/runner.ts:309-360` |
| 宿主端有无直连 SDK | 没有；api 不执行，worker 只落盘与启动容器 | `ARCHITECTURE.md:32-38,105-114` |
| MCP 能力注入 | `createMcpHandler` 每请求重建；generated server 走 `fetch` 转发上游 HTTP | `packages/api/src/features/servers/mcp-endpoint.ts:16-62,75-128`；`generated.ts:139-206,209-283` |
| 平台自身即 MCP | `/mcp` 把已启用智能体变成 `run_<slug>` 工具；单 `PLATFORM_MCP_TOKEN` | `packages/api/src/features/servers/agent-tools-endpoint.ts:16-56`；`agent-tools.ts:26-84` |
| MCP resource 能力 | SDK/CLI 有 `ListMcpResources`、`ReadMcpResource`、`ReadMcpResourceDir` 内置工具定义；平台未使用、也未放行 | `node_modules/.../claude-agent-sdk/sdk-tools.d.ts:996,1033,1043,3613,3636`；`packages/sandbox/src/runner.ts:174-184` 无对应 allow 规则 |
| 导入/导出（专家包） | 官方 `.claude/` ZIP；1 MiB / 解压 4 MiB / 6000 entries；只读校验路径不修复 | `packages/shared/src/agent-package.ts:15-41`；`packages/api/src/features/export/routes.ts:12-34`；`packages/api/src/features/import/routes.ts:19-73` |
| 包内路径白名单 | 仅 CLAUDE.md、.mcp.json、settings.json、sidecar、agents/rules/output-styles 单层 `.md`、skills/**；其余 400 | `packages/api/src/features/agent-package.ts:596-620,684-688` |
| 市场技能安装 | skills.sh 搜索 + 快照下载落 `skills`/`skill_files`；500 文件 / 单文件 200k 字符 / 总 10M 字符 | `packages/api/src/features/market/install.ts:9-15,75-116`；`routes.ts:36-60` |
| 技能导入/下载 | 只接受官方 `SKILL.md`（正文 ≤128 KiB）；下载复用运行时渲染 | `packages/api/src/features/skills/routes.ts:22-31,73-112` |
| `.mcp.json` 导入 | 受限 HTTP/stdio 导入，bodyLimit 8 MiB，凭证加密，不执行 | `packages/api/src/features/servers/routes.ts:79,141-146` |
| 认证/多租户 | 单管理员 better-auth + httpOnly cookie；`requireAuth` 校验用户名等于 `ADMIN_USER`；无 tenant 列 | `packages/api/src/features/auth/routes.ts:67-75`；`docs/SECURITY.md:73`；D-10/D-21 |
| 上传能力 | 无通用上传；无 multipart；无对象存储/S3 依赖 | `packages/api/package.json` 依赖表；`packages/api/src/app.ts` 只注册 Fastify 默认解析器 |
| 请求体上限 | 聊天消息 64 KB；专家包 1 MiB；`.mcp.json` 导入 8 MiB；generated 上游响应 1 MiB | `packages/shared/src/chat.ts:17-21`；`packages/shared/src/agent-package.ts:16`；`packages/api/src/features/servers/routes.ts:146`；`generated.ts:191` |
| 后台任务 | BullMQ：`agent-runs`（并发 `AGENT_MAX_CONCURRENT` 默认 2，排队 >100 拒 503）、`eval-runs`（并发 1）、维护队列 | `packages/worker/src/index.ts:735,759-772`；`packages/shared/src/run-stream.ts:4`；`packages/api/src/features/chat/routes.ts:102-104` |
| 长任务上限 | 单 run 默认 `timeoutMs` 600s（API 配置 600s）；`/mcp` invoke 上限 30 分钟、并发 4 | `packages/db/src/schema.ts:83`；`packages/api/src/config.ts:28`；`packages/api/src/features/servers/agent-invoker.ts:10-11` |
| 并发闸门 | MCP 上游执行 4 槽 / 排队 8；审批等待独立 4 槽 | `packages/api/src/plugins/concurrency.ts:2-38` |
| 限流 | 全局 600/min；chat 20/min；`/mcp` 60/min；登录 10/min | `packages/api/src/plugins/security.ts:46-74` |
| 可观测性 | `/health/{live,ready,metrics}`、pino 结构化日志、`/api/runs` trace、`/api/audit`；无 token 级/检索级指标 | `docs/OPERATIONS.md:376-392`；`packages/api/src/plugins/metrics.ts:6-16` |
| 备份 | `pg_dump` + `workspaces/`（含 agent-memory、sdk-sessions）+ env，tar.gz 0600 | `docs/OPERATIONS.md:216-232` |
| 前端页面 | 导航只有 对话/运行/定时/专家·技能·连接器/评估/健康/审计；无知识页 | `packages/web/src/components/app-shell.tsx:44-66,78-82` |
| 官方 `.claude` 合法文件集 | CLAUDE.md、rules/*.md、settings.json、.mcp.json、skills/<n>/SKILL.md、commands/*.md、output-styles/*.md、agents/*.md、workflows/*.js、agent-memory/<n>/ | https://code.claude.com/docs/en/claude-directory |
| 官方知识分层机制 | CLAUDE.md 支持 `@path` 导入（递归最多 4 跳，展开进上下文）；rules 可 `paths` 作用域；技能正文按需加载、支持文件需在 SKILL.md 里链接 | https://code.claude.com/docs/en/memory ；https://code.claude.com/docs/en/skills |
| SDK 关键选项 | `settingSources`、`skills`、`plugins`（仅 local）、`additionalDirectories`、`autoMemoryEnabled/autoMemoryDirectory` | `sdk.d.ts:2297,2320,2066,1562,9310-9314` |
| `client_composed` 副作用 | 该轮**跳过 turn-start 附件装配**：嵌套 CLAUDE.md、rules、技能/工具清单与提醒都不会随该轮附加 | `sdk.d.ts:6444` |
| 沙盒 SDK 版本 | `@anthropic-ai/claude-agent-sdk@0.3.310`（lock） | `packages/sandbox/package.json:14`；`pnpm-workspace.yaml:30` |

## 自然接入点

四个可行接入面，按「是否需要新基础设施」排列；只列代价，不推荐。

1. **generated MCP server（HTTP→MCP）**：新增一条 `servers`（kind=`generated`）+ `api_tools` 行，即可让智能体获得 `mcp__<name>__<tool>`；工具由 api 进程 `fetch` 上游 HTTP（`generated.ts:139-206`）。代价：需要一个真实的上游 HTTP 检索服务（平台自身或其他服务）；工具定义按 DB 重建、无状态；审批/超时/SSRF/1 MiB 响应切边都继承现有语义（`generated.ts:180-205`、`ssrf.ts`）。绑定后必须显式加入 `agent_servers`，`allowedTools` 才会生成 `mcp__<name>__*`（`ARCHITECTURE.md:169`）。
2. **http MCP 指向平台自身新端点**：`.mcp.json` 里写 `url = ${SANDBOX_API_URL}/...` + 短期 token，与 generated 同一鉴权模式（`ARCHITECTURE.md:160`、`mcp-endpoint.ts:91-105`）。代价：新增端点需自带 API 侧鉴权与 run 绑定校验，否则成为新的越权面；沙盒 `SANDBOX_EGRESS=none` 时整体不可用（`packages/worker/src/index.ts:68-72`）。
3. **技能支持资源（`skill_files` → `.claude/skills/<slug>/references/**`）**：零新基础设施，纯文件投影，导出/导入/市场安装链路全复用；模型可用 `Read` 只读打开（`packages/sandbox/src/runner.ts:176-178`、`memory-permissions.ts:63-73`）。代价：只有 `references/` 子目录可读；无检索，只能靠 SKILL.md 描述引导按需读；单文件 200 KB、每技能 50 文件（`packages/shared/src/agent.ts:135`、`packages/shared/src/agent-package.ts:39`）；正文加载进上下文的成本由模型自己承担。
4. **`CLAUDE.md` / `rules/*.md` 直接承载**：每次会话必进上下文，零工具需求（https://code.claude.com/docs/en/claude-directory、memory 文档）。代价：token 常驻开销；`client_composed: true` 下该轮附件装配被跳过，实际生效范围需实测确认（`sdk.d.ts:6444`、`packages/sandbox/src/runner.ts:296-305`）；rules 只有 50 条 / 100 KB 级（`packages/shared/src/agent-package.ts:39,50`）。

补充可选面（均未接通，代价更高）：`plugins`（SDK 支持 local plugin，但平台未接入本地插件包，`ARCHITECTURE.md:196`、`sdk.d.ts:2066`）；MCP resources（SDK 有 `ListMcpResources/ReadMcpResource` 工具定义，但平台默认不放行内置工具，`sdk-tools.d.ts:996-1050`、`runner.ts:174-215`）。

## 硬约束

- **文件是唯一投影，DB 只是编辑来源**；「支持某能力」以「能生成官方文件、SDK 真加载」为准（`CLAUDE.md:9-16`）。任何 KB 实现必须能回答「导出成 `.claude/` 包时长什么样」。
- **工作区只读 + 内置工具默认禁用**：新增可读目录必须同时改 `DEFAULT_DISALLOWED_TOOLS`、runner `allowedTools`、`createFileBoundaryHook` 三处，否则模型看不到（`workspace.ts:114-133`、`runner.ts:174-215`、`memory-permissions.ts:12-14`）。
- **工具许可按 server 名逐个生成**，`mcp__*` 通配无效；新增工具必须绑定 server 并出现在 `agent_servers`（`ARCHITECTURE.md:169`）。
- **导入路径白名单**：包内出现白名单外路径直接 400；新增「knowledge 目录」必须同步 `AGENT_PACKAGE_PATHS` 与 `isKnownPath`，否则导出包无法自导入（`agent-package.ts:596-620,684-688`、`shared/agent-package.ts:23-30`）。
- **体积天花板**：专家包 1 MiB（含 sidecar）、解压 4 MiB、entries 6000；技能 50 文件 / 单文件 200 KB；聊天消息 64 KB（`shared/agent-package.ts:16-18,34-41`、`shared/chat.ts:17-21`）。真实文档集必然超限，这是「文件式知识分发」的硬墙。
- **无上传/无对象存储**：只有 ZIP 一条二进制入口，且 bodyLimit 1 MiB（`import/routes.ts:19-23`）。要接 PDF/Office 文档，先要新增上传与存储。
- **单管理员、无租户**：所有知识默认全平台可见；按 agent 隔离只能靠 `agent→server/skill` 绑定关系（`auth/routes.ts:67-75`、D-10/D-21）。
- **D-9 仍是现行决策**：做内置 RAG 需要先推翻该决策并在 `DECISIONS-PENDING.md` 留痕（`DECISIONS-PENDING.md:83-85`、`CLAUDE.md:100`）。
- **DB 只承担事务/索引/运行记录**，不能把内部 JSON 等同于完整文件包（`DECISIONS-PENDING.md:209`，D-22）。

## 未确认项

- `client_composed: true` 是否导致项目 `CLAUDE.md` / `rules` 完全不进上下文，或仅跳过「每轮附件」而 `project` source 仍在 init 加载 —— SDK 注释只说跳过 turn-start 附件装配（`sdk.d.ts:6444`），需真实模型实测。
- MCP resources（`resources/list`、`resources/read`）在 SDK 非交互模式下是否对模型可用；官方 MCP 文档只说明发起了 `resources/*` 发现、SDK 模式下 `list_changed` 只刷新工具列表（https://code.claude.com/docs/en/mcp）。平台侧 `ListMcpResources/ReadMcpResource` 是否被 `dontAsk` 拒绝也需实测。
- Postgres 18-alpine 官方镜像是否预装 `vector` 扩展（本仓库未使用，未验证）；如要走 pgvector 其镜像 tag 与安装方式需单独确认。
- 单个 run 的真实上下文预算（模型窗口 vs 工具输出 25k token 默认上限）在平台侧未记录，`MAX_MCP_OUTPUT_TOKENS` 未被设置。
- 技能 `references/**` 之外的支持文件（如 `assets/`、平铺 `reference.md`）在平台权限下是否可读：官方允许任意同目录文件，但平台 hook 只放行 `references/`（`memory-permissions.ts:63-73`），二者不一致。
- 备份/恢复是否能覆盖未来新增的知识存储（当前 manifest 只含 database.dump / workspaces / env，`docs/OPERATIONS.md:220-225`）。
