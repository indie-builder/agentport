# WeKnora 核心能力盘点：检索、MCP、Wiki、图谱、数据源、前端

> 只读源码调研，不实现、不执行被调查仓库脚本。源码快照：Tencent/WeKnora commit `e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`（2026-10-24），下文路径均相对该快照根目录（记为 `W/`）。未运行任何 WeKnora 服务，不能据此声称真实交互或检索质量。
> 分报告含未经最终裁决的设计建议；实施范围和官方文件约定以最终总方案为准。WeKnora 的 Wiki frontmatter 是内容元数据，不能称为 Claude 官方字段；关键词检索也不必强制采用特定数据库扩展。
> 配套：[weknora-core-replication.md](weknora-core-replication.md)、[knowledge-base-research-weknora.md](knowledge-base-research-weknora.md)。

## 1. 知识检索

**调用链与证据**

- HTTP：单库 `POST|GET /knowledge-bases/:id/hybrid-search`（`W/internal/router/routes_knowledge.go:252-253`）；外部跨库纯检索入口为 `POST /knowledge-search`（`W/internal/router/routes_chat.go:155` 起，挂在 `/api/v1`）。`GET /knowledge/search` 是按文件名/类型查文档，不等同于跨库 chunk 语义检索。
- 参数：`types.SearchParams`（`W/internal/types/search.go:254-286`）——`query_text`、`query_embedding`、`vector_threshold`、`keyword_threshold`、`match_count`（上限 30）、`disable_keywords_match`、`disable_vector_match`、`knowledge_ids`、`tag_ids`、`knowledge_base_ids`（跨库）、`rerank`。
- 服务：`HybridSearch`（`W/internal/application/service/knowledgebase_search.go:130`）→ `hybridSearchCandidates`（`:159`）→ 按 5× `match_count`、下限 `DefaultRetrievalTopK=50` 过度召回（同文件注释与 `W/internal/types/retrieval_config.go:40-44`）→ 融合 → 截断 → `processSearchResults` 补父块/邻块/关系块。
- 融合：`fuseWithRRF`（`W/internal/application/service/knowledgebase_search_fusion.go:170`），`rrf_k`/向量权重/关键词权重来自检索配置（`W/internal/types/retrieval_config.go:28-38`）；另有去重与无界分数重标定（`fusion.go:99,125`）。
- Rerank：`HybridSearchWithRerank`（`W/internal/application/service/knowledgebase_search_rerank.go:66`），模型来源依次为请求 → 租户检索配置 → 自动探测（同文件 `:15-53`）。关闭时为 `RerankOutcomeDisabled` 诊断。
- 双引擎：`retriever/registry.go`、`retriever/factory.go` 按 KB 绑定的向量库/关键词索引构造；`keywords_vector_hybrid_indexer.go` 同时写关键词与向量索引。
- 全局默认值：`embedding_top_k=50`、`vector_threshold=0.15`、`keyword_threshold=0.3`、`rerank_top_k=10`、`rerank_threshold=0.2`（`W/internal/types/retrieval_config.go:14-38`；前端同名表单 `W/frontend/src/api/retrieval.ts`、`W/frontend/src/views/settings/RetrievalSettings.vue`）。

**检索测试**

- 没有独立的「检索测试」页面：旧 `/platform/knowledge-search` 被重定向为全局命令面板 ⌘K（`W/frontend/src/router/index.ts:123-131`）；「搜索测试」块只出现在 FAQ 管理内（`W/frontend/src/views/knowledge/components/FAQEntryManager.vue:730,5081`），其他检索调试依赖聊天里的 RAG 进度面板（`W/frontend/src/views/chat/components/RagPipelineProgress.vue`）与全局检索配置。

**引用 / 图片 / 出处定位**

- Chunk 存 `SourceLocators`（`W/internal/types/chunk.go:197-200`）；定位类型覆盖 PDF 页+bbox、docx 段块、slide、表格行列、文本 rune 区间、音视频时间、EPUB 节（`W/internal/types/source_locator.go:10-73`）。
- 解析侧 `W/internal/sourceloc/{align,office}.go` 把解析 Markdown 偏移对齐回原文件结构；前端 `W/frontend/src/utils/sourceLocator.ts`、`pdfSourceLocate.ts`、`composables/useCitationPopover.ts` 负责点击引用回跳。
- 图片不是独立对象而是 chunk 类型：`image_ocr` / `image_caption` / `image_vector`（`W/internal/types/chunk.go:20-28`），图片信息在 `W/internal/searchutil/imageinfo.go`，图片检索在 `W/internal/application/service/knowledgebase_search_image.go`。

## 2. MCP 只读工具

- 工具目录：`W/internal/mcpserver/server.go:207-221` —— `list_knowledge_bases`、`search_knowledge`、`grep_chunks`、`list_documents`、`read_document`、`ask`、`wiki_search`、`wiki_read_page`、`wiki_index`、`add_document`、`update_document`、`delete_document`。
- 只读集合即前 5 个加 3 个 wiki 工具：都挂 `readOnlyEndpointAnnotations`（`W/internal/mcpserver/tools_retrieve.go:25,60-98`；`tools_wiki.go:20-52`）。
- 鉴权/scope：Streamable HTTP、无状态（`server.go:118-121`），请求经 endpoint 鉴权后由工具白名单与 KB scope 过滤（`server.go:1-18` 注释、`W/internal/mcpserver/scope.go`），路由在 `W/internal/router/routes_mcp_endpoint.go`。`grep_chunks` 用关键词索引取候选再正则过滤（`tools_retrieve.go:60-73`）。
- 若要复刻，应只取只读子集；`ask` 会进入 WeKnora 自己的 agent loop，不移植。

## 3. Wiki 自动生成、追溯、版本、人工编辑

**生成链**：文档入库后置 → 任务队列（asynq）→ `wikiIngestService.Handle`（`W/internal/application/service/wiki_ingest.go:721`）→ 批内 Map（每文档抽取实体/概念 + 摘要 + chunk 引用）→ Reduce（按 slug 合并写页）→ 去重（`wiki_ingest.go:2443`）→ 重建索引页（`:2245`）→ 链接回填（`wiki_linkify.go`）。

- 并发与幂等：`wiki_ingest.go:31-66` 注释说明 Lite 模式进程内锁、标准模式按行 claim + 按 slug 分布式锁；`IngestBatchSize`/`IngestMapParallel`/`IngestReduceParallel`/`IngestMaxInflight` 可调（`W/internal/types/wiki_page.go:537` 起 `WikiConfig`）。
- 抽词与抽取粒度：`focused|standard|exhaustive`，另有 `content_instructions`/`extraction_instructions`（同上）。
- 来源追溯：`WikiPage.SourceRefs`（文档级，`<knowledge_id>|<title>`）与 `ChunkRefs`（chunk 级，`W/internal/types/wiki_page.go:191-278`）；引用分类链在 `W/internal/application/service/wiki_ingest_cite.go:257`，解析/合并 `:368,488`。
- 版本：`WikiPage.Version` 只在用户可见字段变化时递增、`LastEditSource` ∈ `pipeline|agent|user|revert`、`WikiPageRevision` 为不可变快照支持 diff/revert（`wiki_page.go:278-412`）；清理策略见 `WikiRevisionPruneRequest`（`:371`）。
- 人工编辑/更新：REST 在 `W/internal/router/routes_knowledge.go:345-388`（pages CRUD、move、revisions/revert、folders、index、graph、stats、search、rebuild-links、lint、auto-fix、issues）；handler `W/internal/handler/wiki_page.go`；健康检查 `W/internal/application/service/wiki_lint.go:94,346`。
- 删除传播：源文档删除触发 wiki retract/死链清理（`wiki_ingest.go:653,1671,1780,1853`；tombstone `:306`）。

## 4. 知识图谱（可选依赖）

- 由 `NEO4J_ENABLE` 单开关控制（`W/docker-compose.yml:294-299`），驱动 `github.com/neo4j/neo4j-go-driver/v6`（`W/go.mod:42`）。
- 服务：`W/internal/application/service/graph.go`（LLM 抽实体/关系、PMI 0.6 + 强度 0.4 计权、间接关系衰减 0.5）与 `graph_search.go`；同步写 chunk 关系字段 `RelationChunks/IndirectRelationChunks`（`W/internal/types/chunk.go:179-181`）。
- 前端入口是 KB 的 `graph` tab（`W/frontend/src/views/knowledge/KnowledgeBase.vue:99`）与 `W/frontend/src/views/knowledge/settings/GraphSettings.vue`；wiki 侧另有 wiki 内链图（`GET .../wiki/graph`）。
- 结论：独立基建（Neo4j）与独立抽取成本，属增值模块；没有它检索与 Wiki 仍成立。

## 5. 数据源同步

- 连接器接口：`Validate / ListResources / ResolveResourceAncestors / FetchAll / FetchIncremental`（`W/internal/datasource/connector.go:11-50`），可选 `StreamingConnector` 以 fetch→ingest→checkpoint 方式断点续传（`:60-120`）。
- 具体源：`W/internal/datasource/connector/` 下 `feishu`、`notion`、`confluence`、`yuque`、`seafile`、`gitlab`、`dingtalk`、`rss`、`ima`（9 个）。
- 计划任务：robfig/cron，`ValidateSyncSchedule`（`W/internal/datasource/scheduler.go:25`），叠加 `HasRunningSync` 与 `asynq.TaskID`（按 ds+分钟）双重去重（`:37-52`）。
- 增量/删除传播：`DataSource` 有 `SyncMode(incremental|full)`、`SyncDeletions`、`ConflictStrategy(overwrite|skip)`、`LastSyncCursor`、`SyncLogRetentionDays`（`W/internal/types/datasource.go:70-134`）；删除在 `applyFetchedItem` 中按 `IsDeleted` 查 `external_id`（限定该 ds）→ `DeleteKnowledge` + `HardDeleteKnowledge`（`W/internal/application/service/datasource_service.go:895-960`），失败单独计数 `DeletionFailed`。
- 凭据：`Config` 注释为 AES-256-GCM 加密 JSON（`W/internal/types/datasource.go:86-88`），并有独立 credentials 子资源与「更新即整组替换并立即校验」（`W/internal/handler/datasource_credentials.go`、`W/internal/application/service/datasource_service.go:270-354`）。

## 6. 前端主要页面与状态

- 路由：`/platform/knowledge-bases` 列表、`/platform/knowledge-bases/:kbId` 详情（`W/frontend/src/router/index.ts:112-121`）；详情有 `documents|wiki|graph|gallery` 四个 tab，按 KB 类型裁剪（`KnowledgeBase.vue:99-135`）。
- 列表：`KnowledgeBaseList.vue`（含合并/排序逻辑与测试）；详情主容器 `KnowledgeBase.vue`（131 KB，单文件承载上传、文档树、批量操作、解析状态）。
- 设置：`views/knowledge/settings/*`（分块、向量库、解析器、模型、图片管线、存储、分享、数据源及同步日志、图谱）。
- Wiki：`views/knowledge/wiki/WikiBrowser.vue`（无内容空态 `:404-410`、索引加载/空态 `:659-681`、图谱未就绪 `:133-153`、搜索无结果 `:230-231`、后台任务/issue 状态条 `:61,197-204`）、`WikiRevisionDrawer.vue`（版本对比/回退）、`WikiFolderActions.vue`；API `frontend/src/api/wiki/index.ts:347`。
- 数据源：`DataSourceSettings.vue`、`DataSourceEditorDialog.vue`、`DataSourceSyncLogs.vue`。
- 全局检索入口已收进命令面板（`GlobalCommandPalette.vue`），不是独立页。

## 7. 三类归属

**A. 用户要的知识库核心闭环（缺一不可）**

1. 文档入库 → 解析/切块 → 关键词 + 向量双索引（含增量重解析、删除清理）。
2. 统一检索 API：混合召回 + 阈值 + 条数 + 单库/多库 + 过滤；rerank 可选。
3. 结果可追溯：文档、chunk、原文位置（页/段/表/时间）与可点开的引用。
4. 智能体可调用：只读 MCP 工具（搜索、grep、列文档、读文档、列库）。
5. 前端最小面：库列表、库详情文档区、检索/引用展示、同步状态。

**B. 增值模块（阶段化，不是首版前提）**

- Wiki 自动生成（Map/Reduce、去重、索引页、死链修复、lint/auto-fix、版本与人工编辑）。
- 知识图谱（Neo4j + LLM 实体关系抽取 + 图检索）。
- 数据源连接器（9 源、流式断点续传、删除传播、cron、凭据管理、同步日志）。
- 多模态：图片 OCR/caption/向量、图片检索、Gallery；FAQ 专用库；问题生成；自动打标签；摘要画像。

**C. 与 PACE 已有聊天 / Agent / 技能 / 记忆重复的部分**

- 聊天与 `ask` 类问答：PACE 已有聊天与 Claude Agent SDK 运行底座，不复制 WeKnora 的 agent loop 与 RAG 进度 UI。
- 「Wiki 生成」的编排本身：等价于一次带工具的生成任务，PACE 已有 agent/skills；不新增第二套模型网关或任务编排语义。
- 记忆：PACE 已有 `agent-memory`（`packages/api/src/features/agents/memory-files.ts`）与只读挂载白名单（`packages/sandbox/src/runner.ts:174-181`）；WeKnora 的 Wiki 是共享知识产物，不能当作 agent 私有记忆替代。
- MCP：PACE 已有 servers 功能与 `.mcp.json` 注入；可复用协议和绑定概念，但新增内置知识工具仍需实现服务分派、库范围校验和运行凭证。仅增加 server 记录不能闭环，现有 `/mcp/:serverId` 只接受 generated。

## 8. 与 PACE 的映射（设计建议，非实现）

- **检索与索引**：在现有 Postgres/队列上设计知识元数据与派生索引。中文关键词可采用应用侧分词或数据库扩展，向量索引可评估 pgvector；均需先做样本验证。核心复刻范围应包含关键词与语义召回，不把早期阶段二/三设想当成已确认方案。embedding/rerank 的后台模型访问也不必强制经过面向沙盒的 Anthropic 消息代理。
- **只读 MCP**：按 `search_knowledge / grep_chunks / list_documents / read_document / list_knowledge_bases` 五个工具面做本平台内部 server；scope 按库授权，工具一律只读。
- **Wiki 生成**：用本项目现有 Claude Agent SDK 承担抽取、合并的模型任务，通过受控工具将页面保存为内容资源，支持引用、版本和人工编辑。页面内容可投影到官方支持的技能 `references/*.md`，但 `source_refs` 等是应用内容元数据，并非 Claude 官方配置字段；不另造 `.claude/wiki` 定义。现有只读工作区不能直接被写入，须明确生成工具的写入口与权限。
- **前端**：只借信息结构（列表→详情→文档/检索/产物 tab→引用侧栏），视觉与组件一律用本项目 `DESIGN-SYSTEM`/shadcn；不移植 Vue 栈。
- **图谱 / 连接器**：作为后续模块；图谱若做，先评估 Postgres 递归查询或现有关联表能否满足，避免为可有可无的图引入 Neo4j。连接器先做一个（如 RSS/语雀）验证增量、删除、凭据三件事，再扩展。

## 9. 代价与阶段（按依赖排序，不含具体人日）

| 阶段 | 内容 | 新增依赖 | 主要代价 |
|---|---|---|---|
| P0 | 入库/切块、关键词检索、只读 MCP 五工具、最小前端 | 替换 Postgres 镜像或加全文扩展；新表；worker 任务 | 解析器选型、中文分词、权限边界 |
| P1 | 向量索引 + RRF + rerank、引用定位、检索测试面 | pgvector、embedding/rerank 路由 | 模型代理扩容、索引重建、评测基线 |
| P2 | Wiki 生成与版本/人工编辑（SDK 驱动） | 无新基础设施（复用队列与沙盒） | 生成质量、并发写冲突、来源追溯与删除传播 |
| P3 | 数据源同步 | cron/队列 + 加密凭据 | 每源 OAuth/权限模型、增量游标、删除一致性 |
| P4 | 图谱、图片、FAQ、Gallery | Neo4j / 多模态模型 / 对象存储 | 独立运维与抽取成本，收益需实测 |

> 代价判断依据：WeKnora 的 Go 服务 148 MB 源码里，wiki 单文件 3,683 行、详情页单文件 131 KB，说明「全量复刻」主要是长期维护成本而非一次性开发成本；PACE 应按闭环裁剪，不照搬其模块数量。

## 10. 必须由用户确认的真实分歧

1. **知识形态：原文检索，还是整理后的 Wiki？** 两者可以组合（检索负责精确取证，Wiki 负责综述与导航），但决定首版主产物是 chunk 还是页面，进而决定 P0/P2 的先后。
2. **文档来源与体量未提供**：格式（PDF 扫描件 / Office / 网页 / 对话记录）、单库规模、是否需要多库与共享、是否中文为主——这些直接决定解析器、全文检索扩展与是否引入向量库，本轮不假设。
3. **是否接受新增基础设施**：pgroonga/pgvector 镜像替换、embedding/rerank 外部调用、可选 Neo4j；每一项都要用户确认运维代价。
4. **D-9**（`docs/DECISIONS-PENDING.md`）现状是「不做内置 RAG」；推进任一阶段都需先更新该决定并留痕。
5. **来源可信边界**：WeKnora 源码仅作资料，许可证为仓库根 `LICENSE`，复刻的是能力与数据流，不复制代码。

## 11. 未验证项

- 未运行 WeKnora，任何检索效果、Wiki 质量、同步稳定性均为源码推断，无实测。
- 未核对 WeKnora 各连接器第三方 API 的当前可用性。
- PACE 侧 pgroonga/pgvector/embedding 路由的实际可行性沿用 `knowledge-base-research.md` §2 的结论，未在本轮重新验证。
