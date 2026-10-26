# 知识库核心能力实施

## 目标与当前有效决定

用户最新指令：腾讯Memory暂不集成，按已确认知识方案实施。必须覆盖完整知识处理/检索/引用闭环、Wiki、Feeds、飞书和GitLab同步，现有原生记忆保留。FAQ未明确必需，图谱/图片语义检索非本次默认范围。Feeds暂按RSS/Atom/JSON理解。

实施依据：[已确认范围](weknora-core-proposal.md)、[来源范围](weknora-enterprise-sources.md)。不另造Agent harness；官方文件/MCP接入、PACE视觉技术栈不变。用户未授权commit/push/merge，本轮以验证后的未提交差异交付。

## 基线与已有差异

- HEAD `797edfeaabd39b040d01736c49273da18347ea92`，已有worktree `knowledge-base-research`，不另改main。
- 已有 `docs/DECISIONS-PENDING.md` 修改及此前十九份知识/记忆调研文档，均本会话成果；不覆盖不提交。
- ce-work引擎：native（仓库config仅auto_babysit:false，无engine绑定/偏好）；项目规则要求Opus设计与review，Sonnet执行，主会话编排。
- 并行规则按项目和用户不提交要求适配：已有产品代码基线已提交，新模块独占文件，验证/依赖/生成锁文件由主会话单点管理；不能为技能的“干净提交波次”擅自提交研究记录。

## 验证环境

- node v24.22.0，pnpm 12.15.0，Docker server 29.8.0。
- `pnpm install --frozen-lockfile` 成功；shared/core构建成功。
- 单独测试容器 `pace-knowledge-research-pg`，绑定127.0.0.1:55432，使用测试账户/数据库pace_knowledge，不改当前应用数据库。
- 镜像pgvector/pgvector:pg18拉取成功；隔离库CREATE EXTENSION及查询确认vector 0.8.7。
- 不启动另一套固定端口Compose，不动主checkout现有postgres/redis；队列集成验证注意现有worker，使用隔离数据/namespace。

## 当前执行单元

- Opus固定共享schema/数据库/任务/REST/MCP/UI契约，输出 `knowledge-implementation-contract.md`。
- Sonnet独占 `packages/worker/src/knowledge/sources.ts` 及对应测试：飞书/GitLab/RSS只读适配，现不动DB/manifest。
- Sonnet独占 `packages/worker/src/knowledge/parsing.ts` 及对应测试：文本/Docling解析及结构感知分块，现不动DB/manifest。
- 后续按契约派发共享基础、API/MCP、任务索引/Wiki、Web、导入导出/部署整合的独占执行单元。

## 验证策略

新增行为先观察失败测试，再实现；测试外部HTTP在真实fixture server，不mock业务结果。按改动范围运行Vitest/typecheck/build及真实浏览器。数据库generate/migrate只在明确隔离验证环境执行，结果记录；最终Opus独立审查。真实模型/飞书/GitLab凭据未提供时不假称联网验收通过，使用fixture证明协议与生命周期，说明实际限制。

基线：首次运行出现 `Failed to resolve entry for package "@agentport/db"`（JSON汇总显示旧文件的55通过，但当前运行套件失败）；构建db后重跑，5个suite、55 tests全部通过，0失败。未改业务代码。shadcn在线索引请求TLS失败，UI复用组件改读官方组件页与本地已安装源码，不引新组件。

## 本地交付结论

已完成范围内产品实现及本地验证，详细结果以 [交付验证](knowledge-delivery-verification.md) 为准：完整Vitest178文件1449测试全过；标准超时无缓存e2e（3条＋登录）4/4通过；全仓typecheck/build、焦点与项目契约、Compose/shell检查通过；全仓lint退出0但106警告/1提示保留。最后测试格式整理后的定向54测试全过。独立Opus10项问题定点复核无确认阻塞残留。未提交/推送/合入，未对主库做镜像切换/迁移；真实Docling/企业凭据/模型质量未验收。

## 当前交付快照（以下优先于后文历史流水）

用户A选择已实施，Tencent Memory暂缓。知识库资源/文档/来源/Wiki/任务/模型管理、检索引用、受控MCP、专家绑定、语料包、备份恢复、调度对账与清理均已落盘。独立Opus原10项问题已逐项复核有修复，见 [最终修复复核](knowledge-final-fix-verification.md)；正式e2e用例仍在编写，不能标整体验证完成。

新鲜验证：
- 全仓typecheck、构建、焦点规范、project contract和compose config已通过。
- 完整Vitest最近一次：177文件通过、1文件跳过；1445 tests通过、2跳过、0失败。随后最终前端40文件383tests全过。最新后台完整回归仍在运行，收齐后更新。
- 实际浏览器：第四页签建库→上传中文Markdown→独立Redis真实worker解析索引→检索命中；分块编辑保存重索引后检索新正文；原文查看、390px窄屏、Feed连续两次同步。模型是本地协议夹具，不是真实效果评测。
- 真实SDK→CLI→本地协议mock→受控工具→Wiki真实落库与取消清理已验证，未调用付费模型。
- 主会话独立重跑backup.sh→restore.sh到独立库/目录，DB关键行、二进制原件/Markdown、记忆文件、manifest及权限一致，反向检查通过。

主库不做迁移或镜像切换；备份演练仅自造数据。所有变更未提交/推送/合入。真实飞书/GitLab凭据、真实Docling部署与模型质量尚未验收。

## 进度

- [x] 依赖/隔离环境/共享契约与数据迁移
- [x] 解析/分块/来源/摄取/检索/受控MCP/专家绑定
- [x] Wiki生成、草稿发布、引用版本、更新失效与任务调度恢复
- [x] 第四资源页签、完整管理入口、聊天来源、模型与库设置
- [x] 语料包、图片往返、容器卷备份/恢复/故障回滚、正式文档
- [x] 独立Opus已确认问题定点复核
- [x] 最后完整测试收齐、正式e2e与验证边界记录


部署配置（已完成并校验）：
- `docker-compose.yml` postgres 切换为 `pgvector/pgvector:pg18@sha256:2358f...`（PG 18.6 + vector 0.8.7，实测镜像内扩展文件存在）；原镜像留在注释里。
- 新增 `knowledgedata:/knowledge` 卷，api 与 worker 同时挂载；worker 增加 `DOCLING_URL`/`DOCLING_TOKEN`/`KNOWLEDGE_WIKI_MODEL`/`KNOWLEDGE_PRIVATE_HOST_ALLOWLIST`。
- `.env.example` 增加 `KNOWLEDGE_DIR` 与上述变量说明。
- `docker compose config --quiet` 通过。
- **未执行**：真实`pgdata`卷镜像切换与迁移。当前同为PG18，不能据此称必然不可逆升级；实际部署仍先备份并验证卷兼容性，本轮不操作主应用数据库。

数据修正（主会话）：
- `disableDocumentsBySource` 原按 `source_id` 过滤，但 worker 写入的是 `metadata.knowledgeSourceId`，导致按来源禁用/删除永远命中 0 行；已改为按 metadata 过滤。
- `syncDeletions` 未在 shared schema 声明，被 zod strip 后 worker 读不到，删除传播会静默失效；已加入各来源 config（feed 的 `url` 同时改为可选，兼容按 range 指定订阅地址）。

SDK核验：已安装 `createSdkMcpServer`、`tool`、`options.mcpServers`、`abortController`、`maxTurns`、`maxBudgetUsd` 均存在；Wiki 生成可沿用现有 `query`，无需自建消息循环。未运行真实模型验收。

实施观察（18:53 快照）：`shared/src/knowledge.ts`、ID前缀、servers kind 与读联合的 knowledge 成员已落；`shared` typecheck 退出0。数据库知识表与迁移尚未出现。

更正一处先前误判：`knowledgeServerSchema` **有意不加入** `serverInputSchema`。契约 §6.5 采用读写类型分离——`serverKindSchema`/读联合包含 `knowledge`，用户可提交的 `serverInputSchema` 只含 `stdio/http/generated`，否则普通连接器接口可伪造内置知识连接。因此“未接入输入联合”不是缺口；真正的缺口是 worker `toEntry` 与 API 预览仍对行执行 `serverInputSchema.parse`，知识库行会解析失败，须由 P1 按 kind 分派并用共享 `knowledgeMcpEntry` 统一构造条目。

数据层实测（本轮真实执行）：
- `packages/db/src/schema.ts` 已新增知识表与 `servers.kind='knowledge'` 约束；`repo/knowledge.ts` 1195 行、59 个导出函数，覆盖契约 §6.1；`repo/index.ts` 已导出。
- 迁移 `0033_steep_nico_minoru.sql` 含 `CREATE EXTENSION IF NOT EXISTS vector` 与手工 HNSW 语句。
- 在隔离库 `pace_knowledge`（127.0.0.1:55432，重置 public schema 后）执行 `pnpm db:migrate` → `migrations applied`。
- `pg_indexes` 确认 `knowledge_chunks_search_idx`（GIN）、`knowledge_chunks_embedding_idx`（HNSW，`WHERE enabled AND embedding IS NOT NULL`）真实存在；`information_schema` 确认 `search_vector` 为 `ALWAYS` 生成列、表达式 `to_tsvector('simple', search_text)`。
- `db` typecheck/build 与 `shared` build 均退出 0。
- 已修复 `schema.ts` 中 `authUsers` 注释与 `export` 拼接同一行的问题（本次改动引入）。
- 尚未运行：P1 的 kind 分派接线、知识表仓库层单测（该包当前无测试目录）。

既有库迁移演练（补充实测）：用 `pg_dump --schema-only` 还原主库结构到独立库 `pace_knowledge_existing`，再补 `drizzle.__drizzle_migrations` 数据（39 条）。首次 `pnpm db:migrate` 因迁移记录为空而重复建表失败，原因是用 schema-only 还原时 `drizzle.__drizzle_migrations` 只有表无数据；补数据后重跑 → `migrations applied`。随后验证 `servers_kind_check` 存在且知识表 15 张已建；插入 `kind='knowledge'` 的 servers 行成功、删除成功。结论：该迁移可在既有库上增量执行，但真实部署仍须先备份，且演练未覆盖大量既有数据与长事务场景。

## 当前有效状态与下一步（用户选择 A 后更新）

用户明确选择 A：知识库是第四资源页签，不再重复征询位置。Tencent Memory 仍暂缓。

**此前“后端全部完成/专家链路打通”表述撤回**：独立 Opus 审查发现真实的跨模块接线与数据问题，见 [审查整改](knowledge-review-findings.md)。测试通过只证明对应用例，不能替代完整运行验收。当前仍在整改，不提交、不启动真实主栈。

独占单元正在补齐：知识页面完整管理入口、专家绑定与聊天引用/定义导出、来源完整性/多范围/飞书凭据、解析/定位/图片与模型边界、Wiki/定时同步/重启恢复、API取消/草稿发布/归属、语料包、macOS容器卷备份/正确镜像digest。

主会话使用3305独立应用、55432隔离PG与56379独立Redis进行真实浏览器检查，已有建库与详情截图；没有对主应用运行迁移或镜像切换。详情标题、列表数量已发现问题待修。详细记录见 [运行验证](knowledge-runtime-verification.md)。

已到达的模块文件还需集成、定向测试、真实页面验证，再作最终独立评审。现有原生记忆保持原状。

补充（19:04）：发现契约要求的共享 `knowledgeMcpEntry` 缺失，worker 与预览侧均无 `knowledge` 分支。已由主会话在 `shared/src/mcp.ts` 补该单点构造器（URL 由平台拼 `/mcp/:serverId`，请求头带 run token 与 run id），新增 `shared/test/knowledge-mcp-entry.test.ts` 两条测试并通过；shared typecheck/build 通过。worker 与预览的 kind 分支仍待 P2/P4 接线。

待修问题（P2 进行中，主会话复核发现）：
1. `ingestion.ts:346` 重建向量只取 `listChunks` 首页 200 条。
2. `ingestion.ts:371` 与 `:563` 只取 `listDocuments` 首页 200 条：超出部分既不重建也不参与远端删除比对，任务仍会报成功。
两处都需按 `nextCursor` 循环到结束，并补“超过单页”的用例；在修好前不得声称重建与删除传播完整。

缺口 3（P3 前必须补）：`repo/knowledge.ts` 没有文档物理删除函数（仅有 `disableDocumentsBySource`）。契约 §7 要求 `DELETE /api/knowledge/documents/:id` 与删除知识库时真正删除数据；当前无法落库，会被静默当成禁用。需在 P1 文件追加 `deleteDocument(db,id)`（级联版本/分块/标签关联，返回是否删除），API 层再按契约做 Wiki stale 标记与审计。

缺口 4（P4 前必须补）：预览侧不一致。`worker/src/index.ts:97` 已按 `knowledge` 调 `knowledgeMcpEntry`；但 `api/src/features/agents/workspace.ts:34` 的 `toEntry` 没有 knowledge 分支，会落到 generated 分支并带上 `_note`，与运行时渲染漂移。必须改为同样调用 `knowledgeMcpEntry`（以 `/mcp/:id` + 占位 token 生成预览），并加一条“预览与运行时条目一致”的测试。
→ **已由主会话修复**：`workspace.ts` 增加 knowledge 分支调用共享构造器；新增 `packages/api/test/knowledge-entry-parity.test.ts` 与 `packages/shared/test/knowledge-mcp-entry.test.ts`，共 3 条通过；api/worker typecheck 通过。

P2 分页修复已完成（主会话复核）：
- `ingestion.ts` 新增 `listAllPages()`，`reembedMissing`/`runReindex`/`runSync` 删除比对均遍历全部分页。
- 新增 3 条超单页用例，红→绿有真实输出（250 文档、50 chunk、50 删除）。
- `queue.ts` 超时改为 `failed` 并清理 cancel key（修复重投递被误 abort）。
- **测试库陷阱**：这些用例读 `process.env.DATABASE_URL`，直接 `pnpm exec vitest` 会连接 `.env` 里的主开发库（`localhost:5432`，无知识表），导致 15 条 23514 约束失败。必须显式传隔离库：
  `DATABASE_URL='postgres://pace_knowledge:…@127.0.0.1:55432/pace_knowledge' pnpm exec vitest run packages/worker/test/knowledge-{ingestion,queue,sources}.test.ts --project backend` → 3 套 31 条全通过。
  已确认主开发库未被污染（knowledge 表 0 张、约束仍为旧三值）。

来源适配（主会话新增）：`packages/worker/src/knowledge/connector-adapter.ts` 把 `sources.ts` 的 `readSource` 快照接口适配为 ingestion 的 `KnowledgeConnector` 表，`queue.ts` 改为从该适配器加载 connectors。sources.ts 当前 16 条测试通过、无新增依赖（自实现 XML/HTML 抽取）。

尚未补：`deleteDocument` 仍未实现；维护对账（超时 running→failed、Redis 丢失重入队）与 sync_cron 调度未实现；parsing.ts 未落地，worker 会警告后空启动。

`deleteDocument` 已由主会话补齐（`repo/knowledge.ts:425`），db typecheck 通过。

解析接入（主会话）：
- 安装 `turndown@7.2.4`（依赖）与 `@types/turndown@5.0.6`（注意：不存在 7.x 类型）。安装后解析测试 21 条真实通过。
- 新增 `parsing-adapter.ts`：`parseForIngestion` 把 blocks+locator 转成 markdown+pageMap；`chunkForIngestion` 复用结构感知切块（chunkTokens×4 换算字符、overlap 同步换算）。新增 4 条测试通过。
- 图片抽取尚未实现：`images` 明确返回空数组，不伪造条目。
- 重试策略修正：`isRetryableKnowledgeError` 增加 `KnowledgeParseError` 分支，`parser_unavailable/upstream_http/upstream_failure/aborted` 可重试，`unsupported/invalid_input/partial_success` 不重试；新增 3 条测试通过。此前解析故障完全不会重试，属于真实缺口。

知识队列已并入 `queue/producer.ts` 的 `getKnowledgeQueue()`，随 `closeProducer()` 统一释放；`service.ts` 不再自建单例。

检索层实测边界（隔离库真实执行）：
- `to_tsquery('simple','知识 库')` 报 `syntax error in tsquery`；必须用 `plainto_tsquery`/`websearch_to_tsquery` 或显式 `&` 连接。API 实现统一用 `plainto_tsquery`。
- 空串与纯标点（如 `!!!`）返回空 tsquery：不报错但零命中，不能退化为全量查询，也不能 500。测试须覆盖。
