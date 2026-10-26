# WeKnora 核心能力复刻：PACE 边界与待确认范围

> 前置设计，供主方案汇总；尚未得到实现授权。本稿只读 PACE 与官方文档，不读取其他分工稿、不修改产品文件、不写 schema、不启动服务、不提交。基线与当前有效决定见 `docs/tasks/weknora-core-replication.md:9`、`:14`。WeKnora 的具体功能与组件结论由相应源码分工补齐，本稿不冒充已核对其源码。

## 1. 建议用户确认的产品边界

1. **知识库是共享的平台资源，专家通过官方 MCP 配置使用它。** 原文、解析结果与索引属于知识资源；专家的接入定义属于 `.mcp.json`，检索与引用使用说明属于 `CLAUDE.md` 或官方技能。禁止自创 `.claude/knowledge/` 或第二套智能体循环。依据：`CLAUDE.md:7`、`:38`；`PRODUCT.md:19`、`:23`。
2. **第一阶段做完整文档问答闭环**：多格式上传解析、文档库/目录/标签、chunk 预览编辑、混合搜索与 rerank、专家绑定和有来源的回答、更新/重建/删除、异步任务、导入导出与备份。它不是只有上传和静态 Markdown 读取的演示。范围来自本任务要求；现有缺口见 §2。
3. **Wiki 和外部同步保留为明确后续阶段**，确认按 §5 的顺序交付；若用户要求 WeKnora 核心首轮全部齐备，则把 §5 纳入首轮总验收，不能默认为删掉。依据：本任务要求；现有 SDK/队列边界见 `docs/ARCHITECTURE.md:201`、`:265`。
4. **继续使用现有专家、会话、委派、流式消息、审计和认证**，不复制 WeKnora 的聊天/Agent/多租户体系。当前用户是单管理员，注册关闭；不为未提出的多人租户权限建表。证据：`PRODUCT.md:15`；`packages/api/src/features/auth/better-auth.ts:18`、`:36`、`:69`。
5. **UI 放入现有资源结构**：新增知识库资源入口与详情，专家能力区域选择知识库，聊天内打开引用来源。复用 Page/ResourcePage、表格、编辑器、Markdown、Query/Router；视觉保持现有体系。当前导航为“专家·技能·连接器”，资源页实际有三个页签，不能误报已有知识菜单。证据：`packages/web/src/components/app-shell.tsx:45`；`packages/web/src/components/resource-page.tsx:10`；`CLAUDE.md:66`。

## 2. 已有 / 部分 / 缺失的证据

| 能力 | 状态与可复用边界 | PACE 证据 |
|---|---|---|
| 专家绑定 | 已有 serverIds、skillIds 和父子各自绑定；知识库选择器/绑定生命周期缺失 | `packages/web/src/pages/agents.tsx:173`、`:915`；`packages/db/src/schema.ts:125`、`:214` |
| 技能与资源文件 | 已有文本支持资源 CRUD、官方目录包与运行渲染；不是文档库、二进制解析或检索索引 | `packages/db/src/schema.ts:143`、`:155`；`packages/api/src/features/skills/routes.ts:12`；`packages/core/src/workspace.ts:413` |
| 原生记忆 | 已有跨 run 记忆与浏览编辑；是智能体自己积累的记忆，不替代共享知识语料 | `docs/ARCHITECTURE.md:197`；`packages/sandbox/src/runner.ts:317`；`packages/sandbox/src/memory-permissions.ts:49` |
| 文件读取 | 部分：主会话可读技能 references 下 Markdown、可读写记忆；不能读任意文档，子智能体文件工具被拒绝 | `packages/sandbox/src/memory-permissions.ts:36`、`:49`；`packages/sandbox/src/runner.ts:174` |
| 模型配置 | 部分：专家有 model 字符串与部署级 Anthropic 网关/密钥；没有知识 embedding/rerank/OCR 模型目录、能力探测和连通验证 | `packages/db/src/schema.ts:71`；`packages/web/src/pages/agents.tsx:153`；`packages/worker/src/config.ts:44`；`packages/worker/src/model-proxy.ts:19` |
| MCP | 已有 HTTP/stdio/generated、工具调用、短期 run token、绑定校验与取消；没有知识工具端点 | `packages/shared/src/mcp.ts:65`；`packages/api/src/features/servers/mcp-endpoint.ts:75`；`packages/worker/src/index.ts:87`；`packages/db/src/repo/runs.ts:275` |
| 包导入导出 | 已有官方文件 ZIP、资源路径校验、父子定义与绑定导出、凭证剥离；没有知识语料包和知识依赖解析 | `packages/api/src/features/agent-package.ts:59`、`:100`、`:312`、`:347`；`docs/ARCHITECTURE.md:180` |
| 异步任务 | 已有 BullMQ/Redis、run/eval 队列、维护与恢复；知识解析/索引/同步任务缺失 | `packages/api/src/queue/producer.ts:118`；`packages/worker/src/index.ts:335`、`:758`；`packages/worker/src/reconcile.ts:270` |
| 聊天与来源 | 部分：已有文本流、工具结果持久化、Markdown 链接；没有知识来源协议、文档定位及引用视图 | `packages/shared/src/chat.ts:26`、`:48`；`packages/worker/src/messages.ts:47`；`packages/web/src/components/markdown.tsx:126` |
| 文档/索引/Wiki/同步 | 缺失：全 schema 没有知识库、文档、chunk、向量、embedding、rerank、Wiki、同步源实体；功能目录未发现对应模块 | `packages/db/src/schema.ts:17` 至文件尾的导出清单；`packages/api/src/features/`、`packages/worker/src/` 的文件清单（本轮 rg 全量定位） |
| 解析/存储依赖 | 缺失专用 PDF/Office/OCR/embedding/rerank 依赖；有 fflate、Postgres/Drizzle、BullMQ、MCP；当前 Postgres 镜像不承诺 pgvector | `packages/api/package.json:12`；`pnpm-workspace.yaml:6`；`docker-compose.yml:8` |
| 备份恢复 | 已有 pg_dump、env、持久工作区及清单校验；独立知识原文件目录尚不在备份内 | `scripts/backup.sh:48`、`:62`；`scripts/backup-lib.sh:234`、`:317`；`scripts/restore.sh:145` |

“缺失”指上述代码范围没有专门实现，不表示 SDK 没有文件工具，更不表示已有技能资源可以充当完整知识库。UI 仅据路由与组件核对，未实操。

## 3. 官方文件与现有 SDK 的最小接入设计

**设计推断，待用户确认**：每个知识库提供一组只读 MCP 工具，例如搜索、按来源读取文档/片段；管理员的上传、编辑、删除走现有认证 REST API。专家依旧绑定 MCP server，知识工具直接调用共享检索服务，避免为它们再做一圈 HTTP→generated→平台 HTTP 的回环。现有 MCP server/node 依赖足够承载协议。依据：`packages/api/package.json:22`；`packages/api/src/features/servers/mcp-endpoint.ts:20`。

- 推荐复用 `servers` 的 HTTP 连接和 `agent_servers`：知识库记录关联受平台管理的 server；只有知识库生命周期能创建/更新该内置连接，普通 HTTP 输入仍按原策略校验。运行前将受控端点渲染为标准 HTTP `.mcp.json`，签发/校验 run token，并沿用父子 server 边界。这里新增的是资源关系及内置服务适配，不是新智能体定义格式。证据：`packages/db/src/schema.ts:17`、`:214`；`packages/core/src/workspace.ts:407`；`packages/sandbox/src/sub-agent-permissions.ts:46`。
- **不能直接填写 localhost 了事**：http 和 generated 在创建/修改、导入和测试连接时都调用 `assertSafeUrl`；生产环境拒绝任何解析到私网的地址，开发仅特定 loopback 白名单例外。内置知识连接须按服务身份和平台生成的精确端点分流，不能给任意用户 URL 加通用私网开关。证据：`packages/api/src/features/servers/routes.ts:118`、`:234`；`packages/api/src/features/agent-package.ts:1050`；`packages/api/src/features/servers/test-connection.ts:102`；`packages/api/src/features/servers/ssrf.ts:98`、`:106`。
- 当前运行时只对 generated 注入 run token 并改写沙盒可达 URL；知识内置 HTTP 接入必须同步改动这一调用方、API token 校验、连接预览与测试探针，不能仅加 UI。现有 `/mcp/:serverId` 只接受 generated，不可误称直接可用。证据：`packages/worker/src/index.ts:101`；`packages/api/src/features/servers/mcp-endpoint.ts:88`；`packages/worker/src/config.ts:41`。
- MCP **服务端**根据凭证及绑定决定可访问的库；不能只相信模型传来的 knowledgeBaseId、run header 或前端选择。父子分别绑定的 server 继续受 PreToolUse 边界约束。当前短期 token 覆盖父/启用子级绑定的 run，不能把它描述为已具备独立子 agent 身份凭证。证据：`packages/api/src/features/servers/mcp-endpoint.ts:29`、`:92`；`packages/db/src/repo/runs.ts:199`、`:275`；`packages/sandbox/src/sub-agent-permissions.ts:69`。
- `allowedTools` **仅自动批准**，不是工具白名单，也不覆盖 `disallowedTools`；裸工具禁用会移除工具，逐调用边界放 PreToolUse。保留 `settingSources:['project']` 和现有 sandbox；本阶段不需要放开任意文件、Bash 或子级文件权限。证据：`packages/sandbox/src/runner.ts:309`；`packages/core/src/workspace.ts:110`；官方权限文档（下方 URL）；已安装 `sdk.d.ts:1609`、`:1631`。
- 技能只补检索步骤/回答格式，或可选携带静态 Markdown 快照到 `.claude/skills/<slug>/references/`；文档二进制、向量、同步状态留在平台资源，不能伪装成官方目录能力。需顺带修正生成文案里“不要 Read 技能文件”与实际 references 放行的矛盾。证据：`packages/core/src/workspace.ts:233`、`:269`；`packages/sandbox/src/memory-permissions.ts:61`；官方技能文档（下方 URL）。
- `.mcp.json`、检索使用说明、必要官方 permission settings 必须可导出，去掉平台 sidecar 后其他 Host 仍能按标准连接远程服务；资源内容不强制塞进定义 ZIP。导出不带短期/长期 token，缺少连接凭证或资源时明确报缺失，不能自动执行导入内容。证据：`packages/api/src/features/agent-package.ts:59`、`:100`、`:149`；`docs/ARCHITECTURE.md:199`、`:203`。
- 跨 PACE 导入需要确认“绑定已有知识资源 / 单独导入语料后重绑 / 保持远程端点”哪一项；稳定资源名称和公开端点必须存在于官方连接定义，不能仅把本地 DB ID 存 sidecar。侧车只记平台映射，不得成为读取知识的唯一入口。依据：`PRODUCT.md:49`；`packages/api/src/features/agent-package.ts:60`。

官方与本地核对记录：

- https://code.claude.com/docs/en/mcp ：根 `.mcp.json`、HTTP `type/url/headers`、环境变量引用是官方格式；导出凭证宜引用专用环境变量名，不能假定 Anthropic 凭证变量能在远程 headers 中展开。
- https://code.claude.com/docs/en/agent-sdk/permissions ：allow/deny/PreToolUse 的真实语义；没有“allowedTools 覆盖禁用”的用法。
- https://code.claude.com/docs/en/agent-sdk/skills ：技能是文件系统制品，`settingSources` 影响发现、`skills` 控制调用；限制技能不会移除磁盘文件。新官方文档对技能可见性的表述已比旧项目文档更新，不能照抄 `docs/ARCHITECTURE.md:170` 当当前 SDK 的全部行为。
- 主 checkout 实际 sandbox 解析的类型：`/Users/xbjt/Documents/myself/agentport/packages/sandbox/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` → pnpm 的 `@anthropic-ai+claude-agent-sdk@0.3.303_@anthropic-ai+sdk@0.135.0…/sdk.d.ts`；核对 `:1615`、`:1635`、`:2257`、`:2297`、`:2320`。已装版本与最新依赖声明可能不同，正式实现须用锁定安装版本跑真实加载验收。

## 4. 最小完整第一阶段：功能与验收边界

以下均为**建议实现范围**，不是已完成事实；依据为本任务要求和 §2 代码缺口。

| 项目 | 必须交付的用户行为与边界 | 验收 |
|---|---|---|
| 知识库、目录、标签 | 创建/重命名/删除库；文档目录树、移动、标签筛选、搜索与分页；目录和标签不是互相替代 | API 与资源页完成 CRUD；删除展示绑定影响 |
| 上传、多格式解析 | 批量上传；建议首批 PDF（含扫描件 OCR）、DOCX、PPTX、XLSX、MD、TXT、HTML、CSV；保留原文件与类型/大小/来源；具体矩阵待解析组件报告与用户确认，不能对未验证格式显示成功 | 每种格式有真实样本；中文、表格、页码、空文件、损坏、密码保护和超限有明确结果 |
| 解析、chunk | 展示解析正文与源页/章节/表格位置；可调整分块参数、预览、编辑/禁用/新增/删除 chunk，并重建受影响索引；不能把生成 Markdown 误称原文件 | 修改 chunk 后搜索命中更新；重解析覆盖人工编辑前明确提示，并定义保留/放弃编辑策略 |
| 混合搜索、rerank | 关键词与语义召回、融合、rerank；按库/目录/标签过滤；有独立检索测试页可看召回来源/分数/最终顺序；缺模型配置或失败必须可诊断 | 中文、专名、编号、表格、无答案查询集；有无 rerank 可对照，未配置时明确能力状态 |
| 模型与设置 | 知识专用 embedding、rerank、OCR/视觉所需配置与连接验证；复用现有密钥加密，不把它们塞进专家聊天 model 字段；模型/维度变化触发明确重建 | 正确凭证可执行；错误模型/维度/认证可识别；配置不可泄漏。现有聊天代理仅放行 Messages/count_tokens/models，不可假定支持 embeddings/rerank（`packages/worker/src/model-proxy.ts:19`） |
| 更新/重建/删除 | 替换原文、重新解析、重建整个库；任务失败时保留上一可用版本；新索引就绪再切换，删除停止并清理关联任务/索引/原文；不存在的资料不会继续被搜索命中 | 更新失败旧版仍可查；删除期间任务完成也不得复活已删文档；检索不混合新旧 chunk |
| 异步任务 | 排队/处理中/成功/失败/取消；步骤进度与可读错误、重试、失败恢复；任务持久状态在 DB，BullMQ 负责执行；单独知识任务通道，不挤进聊天 run 类型 | 断 worker 重启可恢复；重复投递不重复发布；取消/删除/重试都有实测，沿用现有恢复模式（`packages/worker/src/reconcile.ts:270`） |
| 专家使用 | 专家能力区绑定知识库，父子分别配置；MCP 搜索返回文档/版本/chunk/页码或段落位置/来源 URL/摘录；现有聊天继续回答 | 真实 SDK 初始化连接成功、真实模型调用知识工具、父/子/未绑定负例，不能只检查 `.mcp.json` 文本 |
| 引用与回溯 | 回答含可点击来源，打开原文与命中片段；来源记录由服务端检索结果产生，保留版本定位，不能只相信模型编造的编号 | 流式/刷新历史/分支后引用仍能打开；更新后旧引用定位旧版本或明确过期；删除后显示已删除。历史聊天已引用正文是否一并清理需单独确认 |
| 导出、备份 | 专家官方接入文件随定义包导出；知识原文件+目录标签+人工编辑+处理配置独立资源导出/导入；索引可重建，不能只导向量 | 新环境导入并补凭证后专家真实可查；独立备份恢复后原文件、资源关系与可重建信息齐全 |

引用的最小传输方式先复用 MCP 文本结果与 Markdown 来源链接，服务端保存可信来源定位，UI 增加来源查看；不必先扩展整个聊天事件协议。当前 runner 只提取 text，单字段超过 256KiB 会截断，structuredContent/大段 JSON 不能被假定原样持久化。检索返回有限摘录、按来源读取全文；若需要结构化来源事件，必须连同 runner/shared/worker/web 历史路径一起修改。证据：`packages/sandbox/src/runner.ts:66`、`:124`、`:414`；`packages/shared/src/chat.ts:48`；`packages/worker/src/messages.ts:47`。

原文件建议放独立持久知识目录，元数据/正文/chunk/任务状态放现有 Postgres；不把数据库二进制列当默认文件仓库，不提前引入第二套向量数据库。先评估 PostgreSQL 原生检索与成熟向量扩展能否满足真实中文样本，再决定额外检索组件；本稿不写表、索引、维度或规模阈值。现有依据：`docker-compose.yml:8`；`packages/db/src/schema.ts:1`。

## 5. Wiki、同步与后续能力：保留范围及进入条件

| 阶段 | 明确保留的能力 | 进入条件与待确认内容 |
|---|---|---|
| 第二阶段 Wiki | 基于知识原文生成页面/目录、带来源引用、人工修改、增量更新/重新生成、任务状态；复用现有 Markdown/编辑器与 Claude Agent SDK | 第一阶段文档版本/引用闭环已稳定；确认自动生成还是人工触发、页面变更冲突和重建是否覆盖人工内容。需要 LLM 的生成用现有 SDK，不引入 WeKnora Agent harness（`CLAUDE.md:58`；`packages/web/src/components/markdown.tsx:1`） |
| 第三阶段同步 | Web URL 与选定外部源导入、手动/定时同步、变更/删除识别、增量重建、同步记录、失败重试、凭证与取消 | 先确认具体源（网站/文件夹/Git/对象存储/协作文档等）与公开/私网；沿用现有调度与任务机制，但知识同步不能伪装成聊天任务（`packages/worker/src/scheduler.ts:202`）。远程抓取使用真实 SSRF 边界，私网源需明确部署路径，不默认放开通用私网 |
| 条件能力 | FAQ/问答对、图谱、音视频/多模态检索、共享/多用户 ACL | 由 WeKnora 源码盘点和用户需求决定是否属于核心；不能因参考项目有就一并带入，也不能无说明删去。当前只有单管理员基线（`PRODUCT.md:15`） |

阶段是交付顺序，不是认定 Wiki/同步没有价值；确认时逐项注明本次总目标是否包含。

## 6. 选型与改动面清单（只列设计，不实施）

选择顺序：① 先复用 PACE 的官方文件、MCP、数据库、BullMQ、编辑器和聊天；② 评估 Postgres/已装依赖的原生能力；③ 缺口再评估解析/OCR/中文检索/embedding/rerank 开源组件，记录固定版本、许可、维护、部署依赖、代表样本效果；④ 仅补平台整合代码。组件具体候选由组件分工提供，本稿没有完成外部选型，不能声称已选定。依据：`CLAUDE.md:38`；`packages/api/package.json:12`；`pnpm-workspace.yaml:6`。

| 涉及层 | 必须到达的文件与调用方 |
|---|---|
| DB 与共享契约 | `packages/db/src/schema.ts`、`packages/db/src/repo/`、`packages/db/src/id.ts:29`（复用 newId）、迁移；`packages/shared/src/mcp.ts`、`agent.ts`、`agent-package.ts` 及知识资源/任务边界。现有 ID 约束 `CLAUDE.md:83`；变更后 generate+migrate，本轮不执行 |
| API | 新知识资源/任务/检索模块；`packages/api/src/app.ts` 路由注册；`features/agents/routes.ts` 与 workspace 预览；`features/servers/{routes,test-connection,mcp-endpoint,sandbox-probe}.ts`、repo 与 token；`features/agent-package.ts`、import/export；统一 auth/schema/errors/audit 与资源删除/clone/version snapshot 调用方 |
| Core/运行 | `packages/core/src/workspace.ts`、`workspace-input.ts`、`mcp-json.ts`；`packages/worker/src/index.ts`、新知识任务消费者及恢复/调度入口；`packages/sandbox/src/runner.ts` 与 `sub-agent-permissions.ts` 若 MCP 授权需调整；知识正文无需新挂载进 SDK workspace |
| Web | `components/app-shell.tsx`、`resource-page.tsx`；新知识资源路由/页面；`pages/agents.tsx`、`pages/chat.tsx`；`lib/api.ts`、`queries.ts`、来源查看；路由生成产物按 Router 生成，沿用已有无障碍与中文文案规范 |
| 配置/部署 | `.env.example`、api/worker config、Compose、相关 Dockerfile/package manifest/lock；新增知识持久卷、解析服务与检索扩展的实际可用性；embedding/rerank/OCR 密钥和出站配置，具体组件确定后只增加必需项 |
| 导出/恢复 | 专家 ZIP、独立知识资源包、`scripts/{backup,backup-lib,restore}.sh` 的目录/清单/哈希/容量与预恢复副本；DB dump 虽包含新表，新原文件目录仍要显式纳入。当前归档只允许四类根条目，不能加目录后假定自动可恢复（`scripts/backup-lib.sh:317`） |
| 文档 | 确认后同步 `PRODUCT.md`、ARCHITECTURE/OPERATIONS/VALIDATION/PROJECT-BRIEF 的相关段与用户故事；任务记录保留决定，不复制成第二套规范 |

## 7. 验证计划与本轮证据限制

- 实现后按影响范围执行 `pnpm db:generate`、`pnpm db:migrate`、`pnpm typecheck`；Vitest 定向运行知识资源/API、解析样本、检索、异步恢复、删除与来源定位用例。命令入口已核对：`package.json:15`、`:20`、`:24`；本轮未运行，不能宣称通过。
- 复用并扩展 `packages/core/test/workspace-skill-files.test.ts`、`packages/api/test/{agent-package-zip,run-server-scope,mcp-json-import}.test.ts`、`packages/sandbox/test/{runner,sub-agent-permissions,memory-permissions}.test.ts`、`packages/worker/test/{message-persistence,backup-script}.test.ts`，覆盖预览/落盘/导出一致、父子授权、私网拒绝与受控内置连接、消息来源和恢复。
- 新解析/检索 fixtures 放各测试已有约定目录；损坏文件、中文 PDF/Office、OCR、表格、空文档、长文、版本更新与人为 chunk 编辑至少各有真实样本。安全/任务并发需真实测试；涉及队列先停本地 worker（`CLAUDE.md:89`）。
- E2E 继续 `e2e`，登录共享 session；跑“建库→上传→查看任务/chunk→编辑→检索测试→绑定专家→聊天引用→更新/删除→历史引用”和导出/恢复。入口 `package.json:23`；UI 需真实操作，源码截图推断不算验收（`docs/PITFALLS.md:108`）。
- 用代表性中文查询记录关键词/向量/融合/rerank 的真实质量、延迟、成本与资源占用再调参；没有测试数据，不设“超过 N 文档就迁移数据库”一类阈值，也不承诺召回率或吞吐。
- 本轮真实执行：rg 定位功能、schema/依赖/队列/备份全清单；逐文件读取关键边界；realpath 核实主 checkout 安装类型；抓取三份官方 SDK/Code 文档。未执行服务、数据库、下载源码、模型调用或产品测试；下载与 WeKnora 来源固定由主任务处理。

## 8. 等待用户确认的具体项

1. 接受“独立知识资源 + 官方 MCP 接入 + 复用专家/聊天”的边界，以及平台管理的内置 HTTP 连接方案。
2. 第一阶段确认文档格式矩阵、扫描 OCR 与表格保真要求；确认 embedding/rerank/OCR 的服务来源和部署方式。
3. 确认 Wiki、同步属于本次总目标但按后续阶段交付，还是必须首轮一并验收；同步具体源逐一列出。
4. 确认重解析与人工 chunk/Wiki 修改冲突规则、原文删除后历史摘录保留规则、知识资源独立导出/导入方式。
5. 确认解析/向量扩展等所需新增服务后再设计 DB、配置与依赖；本稿没有授权迁移、放开私网、实现或提交。
