# 以 WeKnora 为对照补齐 Agentport 知识库能力

## 目标与当前有效决定（2026-10-31）

用户已明确授权：以本地 WeKnora 核心知识库为完整参照，先拆缺失任务，再并行补齐 Agentport，包含管理与智能体结合。FAQ 属于本轮核心实现；无需再次询问是否进入实现。
历史记录（2026-10-31 收口前）：当时未授权 commit/push/merge；该事实保留，不据此改写。本轮用户已明确授权 commit、push 与创建 PR，仍不授权 merge；生产部署、共享库迁移、新增独立服务与付费真实模型请求仍未授权。外部依赖只阻塞对应能力，不阻塞其余工作。
本文件是当前执行契约；项目待办仅在 `docs/REMAINING-TODOS.md` 登记入口。任务 ID 是验收索引，不要求每项启动一个代理。

## 基线、证据与写入范围

- Agentport：`fed3e5af303f748649448dbbeaa0baf8a6ea0b2c`，分支 `feat/knowledge-weknora`；worktree `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/knowledge-weknora`。主 checkout `/Users/xbjt/Documents/myself/agentport` 保持干净。
- 建树时两处均干净；本架构代理接手时仅 `?? docs/tasks/knowledge-weknora.md`，属于环境代理骨架。其他 worktree 不动。
- WeKnora：`/Users/xbjt/Documents/myself/WeKnora`，main `80e8345903ce4af970497de8359b8b4ea4ce4917`，`v0.9.0-45-g80e834590`，核查日 2026-10-30，MIT/Tencent；复用思想，若复制代码必须保留许可声明。
- 事实基础为两侧 Opus 深读；本次只定点核对 shared wire、DB schema/repo、REST、retrieval/MCP、解析适配接口。上游证据主入口：`internal/application/service/{knowledgebase_search*,knowledge_process*,chunk.go,knowledge_faq_import.go,wiki_page.go}`、`website-docs/03-features`。
- 环境已完成 `pnpm install --frozen-lockfile`（873 包复用）与 shared/core/db `tsc -b`，退出码 0；Node `v24.22.1`、pnpm `12.15.0`。现有 knowledge suites 基线由另一 Sonnet 执行，结果未到，不预填通过。
- 当前架构代理只写本文件、`docs/REMAINING-TODOS.md` 和 D-9 最新范围；不写产品代码、不运行服务或测试。此为代理边界，不是用户对整个任务的限制。
- 已读 `CLAUDE.md`、`docs/DEV-WORKFLOW.md`、`docs/PITFALLS.md`，已加载 `ub-mode`、API/interface、Postgres 技能；项目授权和 Fastify schema 规则高于技能的默认提交、兼容及 handler 校验示例。

## 方案与不变量

保留现有 shared/core/db/api/worker/web 分层，不创建 `packages/knowledge` 或第二套 agent loop；现有组件、队列、解析器、全文/pgvector、文件内容寻址与版本发布全部复用。
库仍一对一对应 `servers.kind='knowledge'`，由 `agent_servers` 绑定，`shared/src/mcp.ts` 的 `knowledgeMcpEntry` 是唯一文件投影。根 `.mcp.json` 为父与启用子绑定并集；子 frontmatter 用 `mcpServers` 名称引用，PreToolUse 按各自绑定裁剪；run token 和服务端固定 base 是最终读取边界。知识正文不挂进沙盒、不混 memory；`settingSources:['project']` 不变，不扩外部授权。
SDK 官方资料已由调研核对：`https://code.claude.com/docs/en/agent-sdk/{mcp,permissions,sub-agents}`；本地 `packages/sandbox/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 的 AgentDefinition/tools/disallowedTools/mcpServers、settingSources。allow 不替代服务端边界，deny 优先；本任务无需新增 SDK 选项。
旧版继续可用直到新版本完整原子发布；取消不发布；模型空间不混用；外部源完整枚举后才允许删除；Feed 滚动窗口永不以缺失条目证明删除。Qoder 视觉及 DESIGN-SYSTEM 布局、shadcn/Base UI/Tailwind 保持。

## 完整对照矩阵

> 本矩阵是 2026-10-30 开工时的能力基线，不是当前缺失清单；状态列按开工基线保留，用于对照本轮补齐范围，不据此把全部行改判“已完成”。任务 ID 是本轮范围索引，当前实现与真实验收状态以文末「当前状态」为准。

状态：**已实现**指已有源码与既有本地证据；**部分**指完整链路有缺口；**缺失**指本轮需补；**真实服务待验收**不等于功能缺失，也不等于已验收。

| 能力 / WeKnora 实际范围 | Agentport 现状 | 状态 | 本轮任务与行为验收 |
|---|---|---|---|
| 文档上传、URL、手写 | 32MiB 上传、URL/manual 新建、Docling + 本地解析 | 部分 | K-M1：手写可改正文，先保存草稿后发布；失败旧版仍可搜 |
| 目录、标签、批量移动/复制/删除/处理、目录上传 | 单条目录/标签已有；上传 path 仅作标题 | 部分 | K-M2：目录层级真实落库，批量结果逐项可见，复制保留内容/标签 |
| 版本列表、选择/回退 | 原子切版与历史存储已有，文档无完整 REST/UI | 部分 | K-M3：可读旧版并回退，旧字节不变，跨文档版本拒绝 |
| 阶段进度、取消、重试、重解析/重建 | 队列/job/reconcile/scheduler 已有 | 部分 | K-C1/C2/M4：撤权不复活、人工修改需确认；专用 reprocess 全版计数已修，不重复修 |
| 同步来源撤权与范围调整 | sourceId 在 metadata，无 range 归属；PATCH ranges 不即时撤权 | 部分 | K-C1：缩范围/停用/删源 keep 后下一次 search/read/list 即不暴露；旧 worker 不可重新发布 |
| 人工 chunk 与溯源 | 原地改正文仍带原页码；新增未标 editedByUser | 部分 | K-C2：增改删创建新文档版本，人工定位不冒充原件，历史引用不改写 |
| Feed 全文更新 | 全文失败退摘要且 hash 改动可覆盖原全文 | 部分 | K-C3：已有全文遇抓取失败仍完整保留，初次摘要明确标识 |
| 结构分块、父子块与窗口 | Markdown 表格/代码/页码已有，无父子关联；adapter 丢 blocks/locator | 部分 | K-P1：结构 locator 落库，child 命中可展开同一 parent，重复短文本不误定位 |
| 关键词 + vector RRF + rerank | Intl.Segmenter + pgvector1024，50+50→30，rerank 可选 | 部分 | K-R1：文本相似度门槛、分数分栏、路径候选/降级可解释，rerank 失败可见 |
| 管理检索测试 | 只有 q/limit 控件 | 部分 | K-U2：folders/tags/rerank/门槛及诊断可操作，URL 状态刷新保留 |
| FAQ 标准问/相似问/反例/多答案/启停/导入导出/命中测试 | 无 FAQ 实体语义；Feeds 不是 FAQ | 缺失 | K-F1/F2：全部本轮实现；编辑/导入→发布→专家命中→启停撤出→往返一致 |
| Wiki 草稿、发布、版本、回退、stale | 已有；人工 save 实际等于发布 | 部分 | K-W1：保存草稿不改线上；发布前核来源，撤权后不可消费 |
| Wiki 主题目录、链接、来源与贡献差异 | 缺目录/links/版本贡献差异；专家工具只检索文档 | 部分 | K-W2/R2/U3：目录/正反链接/来源/前后贡献可看，search/read/list 包含有效已发布 Wiki |
| 图片 OCR/caption、可选原图向量、读图 | SDK 视觉 + Cohere 原图向量 + read_image 已有 | 真实服务待验收 | K-V1：本地 fixture 保回归；真实视觉/Cohere 按配置验证，关闭时无图片向量泄露 |
| 原文定位与引用 | citation 仅 page，原 PDF 尚未复用 BlobPdf；web 只解析 search trace | 部分 | K-P1/U4：document/FAQ/Wiki/read/read_image 都产引用；页/段/行/表定位真实可达，PDF 按页打开 |
| MCP read/list | read 固定 20000 字符截断无续读，list 可含不可读项 | 部分 | K-R2：正文分页读完；list 每项可 read，固定库及父子授权保持 |
| GitHub | Agentport 已有；上游仅占位 | 已实现 / 真实服务待验收 | K-V2：保留优势；真实私库/权限/分页/限流待配置，不能照搬上游占位 |
| GitLab、飞书 wiki/drive、RSS/Atom/JSON Feed | 已实现 adapter/同步；二进制未进 parser、飞书不支持对象可阻断 | 部分 / 真实服务待验收 | K-C4：仓库支持类型用原始字节解析；不支持单项持久错误并继续，真实企业源 K-V2 |
| 其余 9 种来源（Lark wiki/drive、Notion、Confluence、语雀、钉钉、IMA、Seafile、Nextcloud） | 缺 adapter；上游真实注册总计 13 种，不含 GitHub | 缺失 | K-X3：逐种适配与本地 fixture；官方 API/账户/配额逐种确认，真实验收需凭证 |
| 来源远程连接测试、逐项错误与导航 | test 只检查本地配置，只有聚合错误 | 部分 | K-C4/M4：最小只读远程 probe、逐项持久状态/错误、可从失败导航到来源/文档 |
| 知识队列运维指标 | 普通运行指标已有，knowledge queue 缺失 | 缺失 | K-M4：健康指标含知识队列五态，不新增监控服务 |
| 离线检索评估 | 通用智能体文本评估已有，无知识检索标注集评测 | 缺失 | K-E1：输入 query/期望资源或 chunk，输出 Recall@k/MRR/命中与耗时；无强制 LLM judge |
| 音频 ASR | 无 | 缺失 | K-X1：复用来源/版本/检索/引用，新增 ASR endpoint/model 配置与费用后验收 |
| GraphRAG / 实体关系图 | 无；上游 Neo4j 为可选后端 | 缺失 | K-X2：完整跟踪抽取/图查询/来源失效/管理；额外 Neo4j 服务及模型费用未授权 |
| 多存储后端、企业多租户、独立 agent、聊天皮肤 | 当前 PG + 内容寻址适用 | 明确不移植 | 不为参照复制第二执行底座/存储矩阵；视频上游也不支持，不虚构视频差距 |

## 共享契约 A：唯一数据与仓储 owner

**A owner（Sonnet）独占** `packages/shared/src/knowledge.ts`、`packages/shared/src/index.ts`、`packages/shared/src/errors.ts`、`packages/db/src/{schema.ts,id.ts,index.ts}`、`packages/db/src/repo/knowledge.ts`、所有 `packages/db/migrations/**` 生成迁移与 DB knowledge tests。沿现有导出与迁移配置修改，不创建重复文件。其他执行线只消费，缺接口向 A 发请求，不自行修改上述文件。

- 保持现有文档/来源/job 状态值；文档新增 `contentKind:'document'|'faq'|'wiki'`（默认 document）、`disabledReason:null|'manual'|'source'|'range'|'remote'`、`sourceConnectionId:string|null`。后者保留已删来源 ID，不级联清空；来源不存在即不可发布。metadata 不再承担来源授权真相。
- 新增 `knowledge_document_source_ranges(documentId,rangeId)` 联合主键，范围外键删除级联；同一条目可属于多范围。`replaceRanges` 改按现有 `(sourceId,kind,externalId,ref)` 保留 ID 更新、删除失效项；paths 改动重新核所属条目。外部条目必须携带其实际命中的 rangeIds，不能把所有 ranges 都挂给所有条目。
- `replaceSourceScope(db,sourceId,patch): Promise<{source,ranges,disabledDocumentIds:string[]}>` 在同一事务改配置/范围、移除失效归属、撤权所有无有效范围的文档并标 Wiki stale；包括 pending/processing/failed，不只 ready。锁序 source→document（文档 ID 排序）；worker 发布走同一顺序。paths 无法本地证明仍在范围内的文档立即撤权，下一次显式同步确认后才恢复。
- 可消费外部文档须 source 存在且 status 为 active/paused、有启用且覆盖条目的 range、document ready/currentVersion；paused 只暂停调度。auth_error/disabled/删源均不可读；用户手动 disabledReason=manual 不被同步自动恢复。range/source/remote 失效只有后续成功同步重新证明权限才可恢复。
- `PublishGuard` 扩展 `expectedCurrentVersionId:string|null`；发布事务验证版本归属、文档未手动停用、来源/范围仍可读、job running、库 active/profile/settings 未变。既有无 guard 管理切版不得绕过归属/来源检查；新增 `activateDocumentVersion(db,{documentId,versionId,expectedVersionId}):Promise<KnowledgeDocumentRow>` 用于明确回退，不改变停用状态。
- 文档版本新增 `origin:'source'|'manual'|'faq'|'wiki'`、`parentVersionId:string|null`、`metadata:Record<string,unknown>`、`faq:KnowledgeFaq|null`；知识正文/原件仍在既有内容寻址目录，不加正文 DB 影子。列表 wire 增 `isCurrent`/`origin`/`parentVersionId`/`createdAt`，不返回 hash 路径或密钥。
- `KnowledgeLocator` 统一 `{pageFrom?:number,pageTo?:number,startOffset?:number,endOffset?:number,lineFrom?:number,lineTo?:number,headingPath?:string[],sheet?:string,cellRange?:string,bbox?:{left:number,top:number,right:number,bottom:number},parserRef?:string}`；不支持的字段缺省，不编造坐标。offset 沿现有 UTF-16 下标；page/line 从 1 起，bbox 保留解析器原坐标，不声称通用像素。
- `NewChunk` / wire 新增 `parentOrdinal:number|null`（同版本 parent）、`indexRole:'leaf'|'parent'`、`locator:KnowledgeLocator|null`、`editedByUser:boolean`；父块只作上下文不参加排名。无需新增单独父块表；读取按 versionId+ordinal 取，生成迁移时为该实际查询建立索引。
- `editDocumentChunks(db,{documentId,expectedVersionId,mutation,preparedVersion}):Promise<{document:KnowledgeDocumentRow,chunk:KnowledgeChunkRow|null}>`：mutation 为 add/update/delete；preparedVersion 由 API 完成正文文件与新向量准备，事务内 COW 克隆 chunks、重映射 ordinal、插入新版本后切指针。旧版不可更改；content/heading 人工修改与新增设 editedByUser=true、locator/page/image 原件定位置空，留 metadata.originalChunkId 仅供追溯；纯 enabled 修改保留定位。删除也新建版本并标 Wiki stale。
- 所有覆盖解析文本的入口（reprocess/full rebuild/外部更新）使用同一 `confirmOverwriteManualChunks:boolean`，请求不确认时 409 CONFLICT；后台同步不覆盖，写逐项 manual_edit_conflict 并保留旧版。chunksOnly 补向量保留人工修改，不需要覆盖确认。不要重复改已修的 reprocess 全版聚合计数。
- `KnowledgeFaq={question:string,similarQuestions:string[],negativeQuestions:string[],answers:string[],answerStrategy:'all'|'random',isRecommended:boolean}`；新增字段写入默认 all/true，随版本保存、发布、回退和 ZIP 往返；不补旧格式兼容。question≤500，数组各≤50，问句≤500，答案每条≤20000，至少一非空答案，整体正文沿现有手写上限。FAQ 是 contentKind=faq/sourceType=manual 的文档版本数据，不新增 FAQ 表或执行引擎；父 doc 的 enabled/status 与发布指针控制启停，推荐标记不替代启用状态。
- Wiki 页新增 `parentId:string|null`、`position:number`；校验同库/无循环；links 从版本 Markdown 内部 Wiki 链接推导为 `{targetPageId:string,anchor:string|null}[]`，来源沿用 sourceChunkIds。版本历史为权威，不另存一套贡献账本。
- Wiki 显式分开草稿版本与线上 currentVersionId；saveWikiVersion 对 sdk/manual 都只追加草稿，不修改已发布正文。publish/rollback 才切指针并核来源。无线上版本时管理端读最新草稿；MCP 只读 status=published 且来源仍有效的 currentVersion。
- Wiki 搜索索引复用 contentKind=wiki 的内部 document/chunks，版本 metadata 为 `{wikiPageId,wikiVersionId}`；每页一索引文档，发布后用既有 ingest 创建对应版。索引未追上线上指针时暂不召回旧索引；直接 read/list 可用线上版本。索引文档不出现在普通文档列表，不作 Wiki 自动生成来源、不递归生成 Wiki；新建索引任务失败用现有 jobs/reconcile 恢复。
- `knowledge_sync_items` 仅存失败/跳过项：id(TypeID)、syncRunId、sourceId、rangeId|null、externalId、documentId|null、status:'failed'|'skipped'、code、message(≤500)、retryable、createdAt；不存凭证/正文。jobs 增 result 可空（source_probe 结果），新增 job type/payload `source_probe`，正常 ingest/reindex 等不改变。
- A 提供 `listDocumentVersions`（可复用 listVersions）、`activateDocumentVersion`、`editDocumentChunks`、`replaceSourceScope`、`recordSyncItem`/`listSyncItems`、`getReadableDocument`/`listReadableDocuments`、`getReadableWikiPage`/`listReadableWikiPages`、`saveWikiDraft`、`updateWikiPageStructure`、`getWikiVersionDiff`，全部首参 db；readable 接口必须带 baseId 并在内部完成上述源授权判定。既有等价函数直接扩展，不叠加同职责 wrapper。

A 对其余执行线的最小精确调用面如下（等价既有函数可直接改签名并迁移调用，不再套一层）。这里 `PageOptions/Page<T>` 沿用 repo 现有类型，Row 类型沿用 Drizzle 推导；shared 类型必须由 A 在波0落地。

```ts
type PreparedKnowledgeVersion = {
  id: string; // C/W 预先 newId('knowledgeVersion')，先把该目录文件准备完整
  input: CreateVersionInput; // 扩 origin/parentVersionId/metadata/faq
  chunks: NewChunk[]; // 含旧块克隆所需 enabled/editedByUser/locator/parentOrdinal
};
type ChunkMutation =
  | { type: 'add'; ordinal: number }
  | { type: 'update'; chunkId: string }
  | { type: 'delete'; chunkId: string };
replaceSourceScope(db: Database, sourceId: string, patch: SourcePatch & {
  ranges?: KnowledgeSourceRangeInput[];
}): Promise<{ source: KnowledgeSourceRow; ranges: KnowledgeSourceRangeRow[]; disabledDocumentIds: string[] }>;
getReadableDocument(db: Database, baseId: string, documentId: string): Promise<KnowledgeDocumentRow | null>;
listReadableDocuments(db: Database, baseId: string, options: PageOptions & {
  kinds?: Array<'document' | 'faq'>;
}): Promise<Page<KnowledgeDocumentRow>>;
activateDocumentVersion(db: Database, input: {
  documentId: string; versionId: string; expectedVersionId: string | null;
}): Promise<KnowledgeDocumentRow>;
editDocumentChunks(db: Database, input: {
  documentId: string; expectedVersionId: string; mutation: ChunkMutation;
  preparedVersion: PreparedKnowledgeVersion;
}): Promise<{ document: KnowledgeDocumentRow; chunk: KnowledgeChunkRow | null }>;
getReadableWikiPage(db: Database, baseId: string, pageId: string): Promise<KnowledgeWikiPageRow | null>;
listReadableWikiPages(db: Database, baseId: string, options?: PageOptions): Promise<Page<KnowledgeWikiPageRow>>;
recordSyncItem(db: Database, input: Omit<KnowledgeSyncItem, 'id' | 'createdAt'>): Promise<KnowledgeSyncItem>;
listSyncItems(db: Database, sourceId: string, syncRunId: string,
  options?: PageOptions & { status?: 'failed' | 'skipped' }): Promise<Page<KnowledgeSyncItem>>;
```

`KnowledgeSourceRangeInput` 从现有 schema 导出；`SourcePatch` 为现有 source 可编辑列类型。COW 的 preparedVersion 包含完整新正文/新块，不在 repo 读文件或调用模型；C/W 先用预分配 id 写完整版本文件，再在事务中 INSERT 版本及块、检查 expectedVersionId、切指针。失败残留文件沿现有 cleanup 回收，不能先切指针再写文件；已发布版增改时保持 ready/currentVersion，不因后台处理设 processing 而中断旧版读取。A 把现有 createVersion 扩为可接受预分配 id，所有版本号仍在文档行锁内生成。叶块 enabled 默认 true，克隆时不能把旧 disabled 块自动启用。
A 同时提供 `readableDocumentFilter` 为 repo 内唯一 SQL 条件（传现有表别名/固定 baseId），B 的召回 SQL 与 readable repo 共用，不在 API 再造一份源授权真相；Wiki 来源有效性复用此条件。source 锁与 chunk COW 指针冲突是已核实的数据正确性问题，定向真实 PG 测试覆盖，不新增泛化锁框架。
Wiki 专有 repo 入参沿已有 saveWikiVersion 的 `SaveWikiVersionInput` 扩 draft 语义；`updateWikiPageStructure(db,pageId,{parentId?,position?,title?,expectedVersion:string|null})` 返回页，`getWikiVersionDiff(db,pageId,fromVersionId,toVersionId)` 返回契约 D 的 diff。K-W1 的 expectedVersion 在任何 title/结构/正文变动前核对，不先写标题再校验正文。

## 共享契约 B：检索与 MCP wire

owner B（检索）独占 API `features/knowledge/{retrieval.ts,mcp.ts,read-image.ts}`、`packages/core/src/knowledge-models.ts`；SQL 召回可留在现有 retrieval，不迁成新服务。A 提前落所有共享 Zod/type，B 只改调用方。

- `KnowledgeTarget={kind:'document'|'faq'|'wiki',id:string}`；search hit 保留现有 chunkId/documentId/versionId/title/quote 等，新增 `target`、`targetVersionId`、`locator`、`parentContent:string|null`、`scores:{keyword:number|null,vector:number|null,rrf:number,rerank:number|null}`。Wiki 的 documentId/versionId 指内部索引，target/targetVersionId 指 Wiki 页及线上版本；UI 用 target 导航，不能把内部索引当源文档。
- `KnowledgeSearchQuery` 加 `kinds:('document'|'faq'|'wiki')[]` 默认三类、`minVectorScore:number[-1,1]` 默认 0.3、`diagnostics:boolean` 默认 false；保留 q/folders/tags/limit/rerank。0.3 是可配置初值而非已校准质量保证，K-E1 留代表性数据验证。folder 按文档目录、tags 为全部匹配；Wiki 默认不受文档 folder/tag 命中，带这两项过滤时仅返回来源中至少一个文档满足过滤的有效 Wiki。
- `KnowledgeSearchResult={hits,degraded:boolean,warnings:{code:'embedding_unavailable'|'rerank_unavailable'|'wiki_index_pending',message:string}[],diagnostics?:{paths:{keyword:number,vector:number,imageVector:number},fused:number,returned:number,rerank:'off'|'applied'|'unavailable',elapsedMs:number,candidates:{chunkId:string,scores:KnowledgeSearchHit['scores']}[]}}`。diagnostics 仅管理 REST 请求可开启；MCP 不返回候选全文/内部配置，必须完整保留 degraded/warnings。
- score 继续表示最终排名分数，新增 `scoreKind:'rrf'|'rerank'` 明示单位；不在 UI 把两类分数作同一量纲比较。rerank 部分/重复/越界 index 视为失败并保留完整 RRF 列表，不静默丢候选。文本向量在融合前按 minVectorScore 过滤；关键词结果不被向量门槛删除。
- FAQ 标准问/相似问建立可检索 leaf，答案作 parent/响应正文，反例永不进入正向索引。查询与反例复用同一归一化：trim→去 URL→小写→去首尾标点→繁转简→全角转半角→中文间去空格、英文/数字间保留空格；仅归一化精确相等时排除该 FAQ，不新增向量反例算法。过滤后按 documentId 去重并取该条最优命中，文档/FAQ/Wiki 仍共享候选预算，不新增迭代召回 loop。
- FAQ hit 增 `faq:{answers:string[],answerStrategy:'all'|'random',isRecommended:boolean,matchedQuestion:string,questionKind:'standard'|'similar'}`（其他 kind 不带 faq）；answers 在 all 时按存储顺序返回全部，random 时每次 search 对每条 FAQ 等概率选一项，quote 从本次所选答案按既有长度上限生成。随机不参与 embedding/排名/去重；管理详情、导出与 knowledge_read 永远读取完整 answers 和策略，不把随机结果写回版本；read 的分页允许跨完整答案正文续读。
- `KnowledgeSearchQuery` 增 `onlyRecommended:boolean=false`、`faqPriority:boolean=false`、`faqDirectAnswerThreshold:number[-1,1]=0.9`；onlyRecommended 只筛 FAQ，false 不排除可推荐条目，文档/Wiki 不受该字段影响。FAQ 优先是核心可选行为：true 时在反例/可读过滤后将 FAQ 组排在普通结果前，组内仍按最终 score 排名；默认不改变既有混合排序。不复制独立推荐产品流，不新增企业 RBAC。
- `KnowledgeSearchResult` 增 `directAnswer:null|{target:KnowledgeTarget,versionId:string,answers:string[],vectorScore:number}`；仅 faqPriority=true 且最终返回 FAQ 的原始问题向量 cosine≥faqDirectAnswerThreshold 时返回其本次 answers，选 cosine 最高者、并列按 documentId。仅关键词命中/embedding 不可用时为 null；threshold 在 RRF/rerank 前取原始 cosine（FAQ 同时满足 minVectorScore），绝不把 RRF/rerank 当 cosine。默认0.9是待数据校准的初值；管理 REST、FAQ test 与 MCP 共用这些字段，MCP tool 结构化返回 directAnswer，不增平台对话短路或第二套 loop。
- `searchKnowledge(db,baseId,query,options):Promise<KnowledgeSearchResult>` 签名保留，管理 REST 与 MCP 共用授权过滤，FAQ/Wiki 与文档按同一 RRF 候选预算合并；不以未授权来源的 Wiki 衍生内容绕过撤权。
- knowledge_read 输入 `{target:KnowledgeTarget,versionId?:string,offset?:number,limit?:number}`；仅 MCP 默认当前有效发布版，显式 versionId 必须等于当前可读版，否则返回 VERSION_NOT_CURRENT。offset 是 Unicode code point 下标，默认0，limit默认10000/最大20000；响应 `{target,versionId,title,sourceUrl,markdown,offset,nextOffset:number|null,totalCharacters:number,citations:KnowledgeSearchHit[]}`。文档正文来自当前启用 leaf 的阅读顺序，FAQ 来自发布版问答，Wiki 来自有效线上正文；禁止 read 绕过 disabled chunk，不能静默截断无续读。
- knowledge_list 输入 `{kinds?:KnowledgeTarget['kind'][],cursor?:string,limit?:number}`，默认三类、最多50；结果 `{items:{target,versionId,title,folderId:string|null,tags:string[],updatedAt:string}[],nextCursor:string|null}`，统一按(updatedAt,id,kind)倒序分页；只枚举真正可 read 的对象。
- knowledge_read_image 保留 chunkId/format，hit 使用同一 target/locator，受当前版及来源可读约束。四个 MCP 工具名不增加；工具结果用 shared schema，错误保持 isError，固定 code/message，不在参数中开放任意 base。
- MCP 越库/越版本/失效目标：BASE_MISMATCH、BASE_DISABLED、DOCUMENT_NOT_FOUND、WIKI_NOT_FOUND、VERSION_NOT_CURRENT、INVALID_INPUT；不泄露别库对象。HTTP 继续统一 `{code,message,requestId,path?}`，业务沿用 400 INVALID_INPUT /404 NOT_FOUND /409 CONFLICT、CONFLICT_STALE /413 PAYLOAD_TOO_LARGE /503 SERVICE_UNAVAILABLE，不新造错误 envelope。

## 共享契约 C：管理 REST 与上传

owner C 独占 API `features/knowledge/{routes.ts,source-routes.ts,content-routes.ts,service.ts,image-routes.ts,package.ts,package-routes.ts}`、`routes/health.ts`、`plugins/metrics.ts`、API 路由注册点。用 typed(rawApp)+schema 校验，requireAuth、现有审计/SSRF/加密/队列错误收尾保留。下列 URL 均以 `/api/knowledge` 为前缀。

| URL / 方法 | 输入 → 输出与状态 |
|---|---|
| GET `/documents/:documentId/versions` | cursor/limit → `{items:KnowledgeDocumentVersion[],nextCursor}`；版本有 isCurrent/origin/人工编辑摘要 |
| POST `/documents/:documentId/rollback` | `{versionId,expectedVersionId}` → 文档；409 旧指针/不同模型空间需重建，404 外文档版本；保留所有历史 |
| GET `/documents/:documentId/manual` | 管理端读取最新 draft 或当前手写正文 → `{content,versionId,status:'draft'|'published'}`；只允许 manual 非内部 Wiki |
| PUT `/documents/:documentId/manual` | `{content,expectedVersionId}` → 202 `{documentId,jobId}`；先解析成新草稿版，旧发布版保留；POST `/documents/:documentId/publish` `{versionId,expectedVersionId}` → 文档 |
| 既有 manual 新建 / reprocess / rebuild | manual 新建返回 job 后为草稿；reprocess/full rebuild 加 confirmOverwriteManualChunks；无需人工确认时保留原自动原子发布行为 |
| POST/PATCH/DELETE 既有 chunks 路由 | body 加 expectedVersionId，更新/删除只能操作当前版；新增不接受伪造 page/locator；写返回 `{document,chunk:null|KnowledgeChunk,jobId:string|null}`，DELETE 同结构；索引补齐失败明确 job 状态 |
| POST `/bases/:id/documents/batch` | `{documentIds:string[1..100],action:'move'|'copy'|'tag'|'delete'|'reprocess',folderId?:string|null,tags?:string[],tagMode?:'add'|'remove'|'replace',confirmOverwriteManualChunks?:boolean}` → `{results:{documentId,status:'succeeded'|'failed',newDocumentId?:string,jobId?:string,code?:string,message?:string}[]}`；每项事务、部分成功不伪装全成功；只同库操作 |
| 既有 PUT `/bases/:id/documents/upload` | 加 `relativePath?:string`，浏览器目录上传逐文件传；只相对路径，禁止绝对/.. /链接；创建或复用 base/folder 下真实目录，标题取 basename；复用现有路径校验，不解压任意目录归档 |
| 既有 PATCH `/sources/:sourceId` | body.ranges/status/config 走 replaceSourceScope，响应增 `disabledDocumentIds`；授权收缩在响应前生效，不等待下一次 sync |
| POST `/sources/:sourceId/test` | 不再假称本地校验等于连通；本地错误400，否则202 `{jobId}`，source_probe 只读远程凭证与范围首项，不导入/推进 cursor；GET jobs 返回 result `{ok,checks:{rangeId,ok,code?:string,message?:string}[]}` |
| GET `/sources/:sourceId/runs/:syncRunId/items` | cursor/limit/status → `{items:KnowledgeSyncItem[],nextCursor}`，校验 run 属于 source；UI 可跳来源或 document |
| 既有 GET `/bases/:id/search` | 保留现有 q/limit；folders/tags/kinds 用重复 query 参数，rerank/diagnostics 显式布尔 coercion，minVectorScore 数值；响应共享契约 B |

手写草稿状态记在版本 metadata.publication='draft'，发布后原子标记 published，管理端只选真正未发布草稿，不把旧发布版当草稿；若尚无发布版文档仍 pending。publish 成功变 ready，MCP 不可读未发布手写。手写草稿使用既有 ingest，payload 的 `publish:'draft'|'automatic'` 默认 automatic，并保存不可变 `input:{blobSha256:string,filename:string,mimeType:string,expectedCurrentVersionId:string|null}`（以A当前shared唯一schema为准；C早期平铺字段必须迁移到input，不能留两套或被Zod剥除）。FAQ另带具体 `versionId`，`versionMetadata` 如需保留也进shared schema。job创建和重试完整保留这些字段；worker优先消费快照，不运行时读取可变document.contentHash。已发布contentHash不因尚未发布的草稿覆盖。
批量 copy 新建 manual 独立文档和内容快照，复用 Blob/派生正文，保留标签/目录；不继承来源授权或外部同步身份，需 UI 明示“复制为独立文档”；普通复制不改变源。跨库复制本轮不开放，避免混 embedding 空间。
ZIP 包完成 FAQ/Wiki 目录/links/版本字段往返，不带凭证；严格路径/真实解压字节/大小限额保留；不写旧格式兼容层。
知识队列 metrics 扩现有 JSON `/health/metrics` 的 `knowledgeQueue:{waiting,active,delayed,completed,failed}`；API 读取既有 producer Queue。此前 Prometheus 标签写法只是五态示意，项目没有该文本入口，不为它新增路由或采集器。

## 共享契约 D：FAQ、Wiki 与离线评估

owner F 独占 API `features/knowledge/wiki-routes.ts`、worker `knowledge/wiki.ts`，并新增 `features/knowledge/faq-routes.ts`、`faq.ts`、`retrieval-evaluation.ts`、对应专用 tests；新增文件用于真实独立功能，不新建通用框架。路由注册需求由 C 在其注册点一次接入。

- FAQ URL：GET/POST `/bases/:id/faqs`、GET/PUT/DELETE `/faqs/:documentId`，POST `/faqs/:documentId/publish`、PATCH `/faqs/:documentId/status`；创建/更新 body `{title?,faq:KnowledgeFaq,folderId?,tags?,expectedVersionId?}`，更新必带 expectedVersionId，202 `{documentId,jobId}`；保存是草稿，publish body `{versionId,expectedVersionId}` 后可召回；status `{enabled:boolean}` 用现有文档启停与 disabledReason，删除沿用文档删除。POST `/bases/:id/faqs/batch` 输入 `{action:'publish'|'enable'|'disable'|'delete',items:{documentId,versionId?,expectedVersionId?}[],importBatchId?:string}`（1..100条；导入发布允许1..500条，publish 必带两版指针）；普通操作返回契约 C 逐项 results，导入发布另遵循下述整批原子契约。
- FAQ 列表 cursor/limit/q/status/folderId 加 `isRecommended?:boolean`（不传不过滤）；详情固定 `{document,draftVersion,publishedVersion,faq}`，顶层 faq 为最新草稿、无草稿时为发布版，并在各版本保留其自身 faq，不能用顶层草稿覆盖发布版。answerStrategy/isRecommended 保存不立即改线上；停用是明确独立动作，立即撤出 search/read/list。草稿沿 C 的版本 `metadata.publication='draft'`，无发布版为 pending，旧发布版在新草稿解析/embedding/失败期间仍 ready/currentVersion；job 快照携带完整 FAQ 与 publish='draft'。仅标准/相似问生成 leaf，答案为 parent/响应正文，反例无 embedding；worker 必须保留每个正向 leaf 的 `questionKind` 和 `matchedQuestion`，不再生成 negative leaf。
- `FaqTransferEntry=KnowledgeFaq & {enabled:boolean}`；导入/导出 JSON 为 `{items:FaqTransferEntry[]}`。POST `/bases/:id/faqs/import` body `{format:'json'|'csv'|'xlsx',content:string,mode:'append'|'replace',dryRun:boolean}`，mode 默认 append、dryRun 默认 false；xlsx 的 content 为 base64，其余为原始文本。JSON/CSV 原始 UTF-8、xlsx 解码后均≤2MiB，最多500数据行（去重前计数），HTTP 原始 body≤3MiB（容纳 base64/封装）；归一化后所有条目的问答正文 UTF-8 总字节仍≤2MiB，超限413且零写入。默认 answerStrategy=all/isRecommended=true/enabled=true，值不合法报逐项错误。
- CSV 固定列 `question,similarQuestions,negativeQuestions,answers,answerStrategy,isRecommended,enabled`；后三个问答多值列保留本项目原规划的 JSON 数组单元格，布尔为 true/false；不同时支持第二套分隔语法。CSV 导出带 UTF-8 BOM、标准双引号/换行转义，JSON/CSV 导出与导入同形；这与上游 `##` 模板有意不同，避免答案中的字面 `##` 产生歧义。CSV 读取复用 csv-parse@7.0.3；已核 manifest 仅 worker 声明，API 不得跨包偷引。C 在其 API package owner 范围补同版本直接依赖及协调锁文件单一 owner，F 再直接使用；本轮文档修订不改 manifest/锁文件。
- 入库原文仅 trim/去空，判等用 B 的归一化副本；数组去重保序。标准问必填、至少一答案、长度沿 A；与标准问重复的相似问去掉，重复相似/反例去掉，与该条正向问相同的反例剔除并记 partial。跨条目任一正向问归一化冲突为 failed（同标准问的 append 合并除外），单条 CRUD 冲突仍409；不改用向量判重。`contentHash=SHA256(JSON.stringify([normalizedQuestion,sortedUniqueSimilar,sortedUniqueNegative,sortedUniqueAnswers]))`，数组顺序不影响哈希；运营标记不计入 hash，不作为唯一 DB 约束。
- append 先按上游 contentHash 匹配库内最新草稿（无则发布版）：同 hash 且策略/推荐/启用标记相同→skipped；同 hash 但标记变化→merged 草稿，保留标准问原文、相似问/反例归一化去重取并集，answers 与运营字段由本行覆盖；无 hash 命中且无正向问冲突→added 草稿。无 hash 命中但同标准问/其他正向问冲突→failed，不能把上游内容哈希去重改成按标准问自动覆盖答案；修改答案走显式 PUT。批内完全相同行后者 skipped，同正文但标记不同或正向问冲突后者 failed，按输入行序确定。replace 只验证本批自洽，不与即将替换的旧 FAQ 判冲突；批内完全重复跳过，冲突失败，不静默后者覆盖。
- dryRun 与真实导入复用同一解析/校验/判重/合并计划，返回200 `{dryRun,mode,committed:false,importBatchId:null,counts,results}`；不写文档/版本/文件/job、不调用 embedding。真实导入也先校验全批：任何 failed 都返回200同结果且整批零写入；否则一次 DB 事务建立全部新增/合并草稿及既有 ingest jobs，返回202 `{dryRun:false,mode,committed:true,importBatchId,counts,results}`，仅 skipped 的空变更返回200。解析器无法拆行报400；DB/文件准备失败走既有错误机制且不得留下部分可发布版本；队列投递失败沿现有 job/reconcile 恢复，不把计划成功当索引完成。
- `counts={total,success,failed,partialFailed,skipped,added,merged}`；total=success+failed+partialFailed+skipped，success 为无警告有效行，partialFailed 为剔除无效可选问句后仍有效行，added+merged=success+partialFailed。`results:{row:number,status:'success'|'failed'|'partial_failed'|'skipped',operation:'add'|'merge'|'skip'|null,documentId?:string,versionId?:string,expectedVersionId?:string|null,jobId?:string,issues:{field:string,code:string,message:string}[]}[]`；row 从1计数据行（不含表头），dryRun 也返回全量结果与计划计数。committed=false 时 added/merged 仅表示计划，不伪装实际写入；统计不截断、不存大结果新表。
- A 提供 `saveFaqImportDrafts(db,{baseId,importBatchId,mode,expectedState,drafts}):Promise<{items:{documentId:string,expectedVersionId:string|null,jobId:string}[]}>` 与 `publishFaqImport(db,{baseId,importBatchId,items}):Promise<KnowledgeDocumentRow[]>`；drafts 为 `{operation:'add'|'merge',documentId:string,faq:KnowledgeFaq,enabled:boolean}[]`（add 预分配 documentId，merge 指已有文档），items 为 `{documentId:string,versionId:string,expectedVersionId:string|null}[]`，expectedVersionId=null 仅指尚无发布版。import 的 results 在 job 未完成时不返回 versionId，U 轮询既有 job 与 FAQ 详情取得已生成草稿版本，再提交整批 publish。F 先写现有内容寻址输入文件，A 在事务内用既有 ingest job 结构保存 FAQ 快照/publish='draft'；事务不调用文件/模型/队列。expectedState 为本次读取并将修改/替换的 `{documentId,currentVersionId,latestDraftVersionId,updatedAt}` 快照（两版指针 string|null），事务锁定并复核，变更则409且无部分写入。base 内批次用现有版本 `metadata.faqImport={batchId,mode,enabled,expectedVersionId,replaceTargets?}`（expectedVersionId 是创建时线上指针的持久快照，必填且可 null，恢复不得以当前指针重算） 保存，replaceTargets 是待替换旧 FAQ 的同形快照（旧集合最多500条，超限409），无新表/服务；job 快照携同一元数据，W 建版本时原样保留，导入 job 不自动发布。
- replace 草稿就绪前旧 FAQ 完整保留；显式 batch publish 携 importBatchId 和本批全部非 skipped 条目（不能分片），A 复核整批 job 成功/索引齐备、expectedVersionId 及旧 FAQ 集合/快照未变，再同一事务发布新集合、应用目标 enabled、删除快照中的旧 FAQ；append 批发布只切对应条目且应用 enabled。任一失败409且旧集合不变，返回全批 failed results；批发布不允许 enable/disable/delete 混用。replace 全为空/全 skipped 不执行删除并400；放弃或失败不改变线上，删除后的文件按现有 cleanup，不提前删 Blob。普通手工逐条发布不得绕过带 faqImport 元数据的批次原子发布。
- GET `/bases/:id/faqs/export?format=json|csv` 的 query.version='published'|'draft' 默认 published，draft 选每条最新草稿、无则发布版；导出包含完整 answers、策略、推荐、enabled（导入草稿用目标 enabled），不作 random 抽样；同500项/2MiB正文及最终导出 UTF-8 字节限额，超限409不截断。POST `/bases/:id/faqs/test` body `{q,limit?,rerank?,minVectorScore?,onlyRecommended?,faqPriority?,faqDirectAnswerThreshold?}` → 共享 search result，强制 kinds=['faq']；不做另一套检索。C 把 B 新增检索 query 字段接入既有管理 search schema，U 提供答案策略、推荐标记/筛选、append/replace、dry-run 结果与显式整批发布，替换确认显示将删除的旧 FAQ 数量。
- Excel 结论（2026-10-31）：作为“完整参照上游”的核心导入格式必须跟踪实现，不把 CSV 可在 Excel 打开冒充 xlsx 导入；manifest 未发现 exceljs/xlsx/read-excel-file。选择 API 进程内 ExcelJS（npm latest=4.4.0、MIT；官方 README `workbook.xlsx.load(data)`、streaming reader），不自写 ZIP/XML，不加服务；只取第一张工作表、首行为同 CSV 列头、仅字符串/布尔常量单元格，公式/富文本/合并表头/额外非空工作表拒绝并逐行说明，不求值/不执行宏，不支持旧 xls。对比只读库 read-excel-file@9.3.14（MIT、依赖 saxen/fflate/worker-f/unzipper-esm），其文档明确公式返回缓存结果，会失去本契约要求的公式识别，因此不选；ExcelJS 有 jszip/archiver/fast-csv/unzipper 等9个直接依赖，成本更高但能保留单元格类型以明确拒绝公式，仅在 API 引入、不进 web bundle。2MiB 解码文件在送入解析库前先用 API 已装 fflate 的流式解压统计实施32MiB实际解压总字节限额（含 XML/共享字符串），超限立即中止；不得仅信 ZIP 声明大小或在完整 load 后检查。C 统一处理实际依赖/锁文件，F 实现解析；本轮不安装、不据 npm latest 推断近期维护活跃。证据：https://raw.githubusercontent.com/exceljs/exceljs/master/README.md 、https://registry.npmjs.org/exceljs/latest 、https://raw.githubusercontent.com/catamphetamine/read-excel-file/master/README.md 。
- Wiki POST/PATCH pages 扩 parentId/position；GET `/wiki-pages/:pageId/links` → `{outgoing:{targetPageId,anchor}[],incoming:{sourcePageId,anchor}[]}`，同库有效链接，坏链接管理端标记不伪造目标；解析 Markdown AST 复用现有依赖，不用正则充当完整 Markdown parser。
- GET `/wiki-pages/:pageId/diff?fromVersionId=&toVersionId=` → `{fromVersionId,toVersionId,addedLines:string[],removedLines:string[],addedSourceChunkIds:string[],removedSourceChunkIds:string[]}`；先校验两版同页，按行多重集合比较保留重复计数；这是贡献差异，不宣称复杂可视化 merge。
- Wiki 的 title/结构更新与 expectedVersion 校验同事务；保存正文不隐式发布。publish/rollback 继续现有 URL，回退引用失效时409；不把回退洗成有效来源。页面无来源的人工正文可发布，但模型生成正文必须保留来源快照。
- 离线评估 POST `/bases/:id/retrieval-evaluations` 输入 `{cases:{q,expectedTargets:KnowledgeTarget[],expectedChunkIds?:string[]}[],limit?,rerank?,minVectorScore?}`，≤100项/1MiB；返回 `{results:{q,hit,recallAtK,reciprocalRank,elapsedMs,degraded,warnings}[],recallAtK,mrr}`，逐条调用同一 searchKnowledge。期望集合为空400，跨库目标400；每个样本按去重 target 计 Recall，期望 chunk 显式提供时另报 chunkRecallAtK。结果可前端下载 JSON，无需新跑批表/新队列；调用已配置 embedding/rerank 可能有费用，真实计费仅获授权后运行。

## 已复现发布缺陷的补充契约（2026-10-31）

- 来源读取用 `getSourceReadSnapshot` 在来源共享锁下取得配置、加密凭证与范围的一致快照；快照仅在进程内流转，不写用户 wire/日志/版本正文。授权恢复、范围归属和最终发布均在 source→document 锁序内比较该快照，配置或凭证已变则零写入并中止旧同步。
- `setDocumentSourceRanges` 扩为事务内同时完成快照验证、来源属性更新、实际归属替换和非人工停用的恢复；不保留散落的先恢复后检查路径。`PublishGuard` 携同一快照。
- Wiki 文件准备只写内容寻址 blob，不修改索引文档或任务。事务内复用 `publishWikiVersionTx` 的来源校验与 page 锁，再复用/创建同页唯一索引文档并建立带不可变 input/versionMetadata 的 job，一次提交。提交后入队，投递失败由现有 queued 对账补投；失败发布不影响旧排队任务输入。
- 普通手写草稿以 `version.metadata.indexingJobId` 关联生成该版本的任务；发布核同库同文档 ingest/draft/succeeded，以及输入 blob、MIME、文件名和父版本一致。最后落块或返回前取消不得记成功；已发布历史可正常回退。
- 所有版本切换同事务同步目标版本的正文指纹，避免 `currentVersionId` 与 `contentHash` 分离。FAQ 导入保留自身整批发布约束，不借通用回退提前上线。
- 最小接口与测试细节的执行收据为 `/tmp/knowledge-weknora-publication-contract.txt`；本节保留长期有效决定，临时文件不是额外待办来源。上述契约尚在实现与验收，不表示已通过。

## 六条执行线、文件 owner 与波次

| 执行线 | 独占文件边界（均在此 worktree，测试同目录命名归属） | 任务 ID / 依赖 / 完成判据 |
|---|---|---|
| A 公共基础 | 共享契约 A 列明文件与全部迁移，DB tests；shared knowledge 测试 | K-A0→其余所有：先落 Zod/type/schema/repo、错误导出与生成迁移；随机库迁移和仓储行为验证；后续接口修订仍仅 A 写 |
| W 摄取/来源/解析 | worker `knowledge/{ingestion.ts,parsing.ts,parsing-adapter.ts,sources.ts,connector-adapter.ts,queue.ts,reconcile.ts,scheduler.ts}`；worker knowledge tests（排除 wiki） | K-C1/C2/C3/C4/P1：依赖 A；撤权不复活、人工保护、Feed 不退化、逐项失败、probe、locator/父子块、FAQ/Wiki index ingest；K-X3 后续同 owner |
| B 检索/智能体 | 共享契约 B 列明文件；API knowledge-search/MCP/read-image tests；绑定与 sandbox 测试只补断言不改变授权实现 | K-R1/R2：依赖 A；三类消费、诊断、分页、分数、固定库、当前版、父子绑定隔离；不写 worker 文件 |
| C 管理 API/运维/归档 | 共享契约 C 列明文件、对应 API tests；所有注册点 | K-M1/M2/M3/M4：依赖 A；管理/批量/目录/版本/远程 test/metrics/ZIP 全闭环；不写 Wiki/FAQ 实现 |
| U 前端 | web `lib/{api.ts,queries.ts,knowledge-errors.ts}`、`pages/{knowledge.tsx,knowledge-detail.tsx}`、`components/{knowledge-settings.tsx,knowledge-citations.tsx}`、知识 route search、新增必要知识组件与 web tests、`tests/knowledge*.e2e.ts`/seed | K-U1（管理）/U2（检索）/U3（FAQ/Wiki）/U4（引用）：A wire 后可用 HTTP fixture 并行，真实 API 后联调；BlobPdf/Page/Trace 等已有组件直接复用 |
| F FAQ/Wiki/评估 | 共享契约 D 列明文件及专用 tests；worker wiki tests | K-F1/F2/W1/W2/E1：依赖 A，检索评估运行依赖 B；FAQ 管理路由与 Wiki 组织可先并行写；不改 ingest/shared/repo |

波0：A 实现公共契约/迁移/repo；当前基线 Sonnet 独立跑既有套件，无共享文件写入。此串行是真实依赖：其余写入需要确定的 schema/type/事务接口。
波1：A 报出接口可用后，W/B/C/U/F 五线同时实现；U 按固定 wire mock，F 评估只等待 B 的现有函数实现，不阻塞 FAQ/Wiki 管理。C 统一注册新路由，W 统一接入所有 ingest/job 分派，A 统一接口补丁；不得两代理改同一个文件不同区域。
波2：同一 owner 补联调与引用：Wiki 发布索引、FAQ 正反问检索、版本/草稿 UI、source probe result/逐项导航、ZIP、e2e seed。W/C 接口为 source_probe job/result，不从 API 跨包 import worker sources.ts；已安装 adapter 继续原归属。
波3：独立 Opus review，固定 `fed3e5a` 与实际差异清单，重点审来源撤权、版本不可变、FAQ/Wiki 可见性、MCP 父子授权和取消；发现后交原 Sonnet owner 修复并由 Opus 复核。通过后完整运行改动范围验证；无 commit 授权不提交。
波4：K-X1/X2/X3 与 K-V1/V2 按下面外部依赖逐项继续；本地 adapter/fixture 不需新问是否实现，真正的账号、模型消费及服务部署等授权只影响对应真实验收。

## 验收任务与测试证据要求

- K-C1（A/W/C/B）：范围/来源收缩与发布交错的真实 PG 测试；包括 processing 文档、删源 keep、重建 disabled、范围交集仍有效、手动停用不自动恢复；source PATCH 后 MCP search/read/list/read_image/Wiki 派生内容一致撤出。
- K-C2（A/W/C/U）：人工新增/改/删/启停生成新版本、旧版 chunks/hash/引用不变；内容编辑清 locator；外部变化/manual conflict 与已确认 reprocess/full rebuild/chunksOnly 分别验；取消与旧指针竞争不切版。
- K-C3（W）：先成功全文再失败抓取，断言当前版/全文 hash 保留；首次只有摘要可导入且 metadata.contentCompleteness='summary'，后续成功全文变 full，不能由 full 自动降 summary。
- K-C4/M4（W/C/U）：本地真实 HTTP fixture 覆盖认证失败/分页/单项不支持/二进制 PDF/远程 probe；逐项记录可查可导航，失败不推进完整枚举删除判据；metrics 有知识队列数据，不宣称真实企业已测。
- K-P1（W/A/B/U）：复用现有 aligned-table/OCR/CRLF/repeated-text Docling fixtures，真实 adapter→DB→search→引用全程对定位，child 返回 parent；人工改稿无原页假定位；PDF Blob 下载→BlobPdf 指定页，非 PDF 保留下载。
- K-M1/M2/M3（C/U/A）：手写 draft→publish→update draft 仍搜旧版→publish→rollback；旧版选择下载 hash 一致；批量混合成功失败；folder 上传两层同名文件树；同库校验、路径越界、版本归属必须测试。
- K-R1/R2（B/U）：embedding/rerank 失败 warnings 和分数稳定，低相似度过滤、关键词仍保留；三类 target 列表/分页可读、超20000字含 emoji 多页重组无缺漏，父/子分别绑定两库不能互读；MCP source read_image 引用被 web 正确重建。
- K-F1/F2（A/F/W/B/C/U）：all 保序全答、random 仅选一项且不改存储，重复 search 可控制随机源验证边界，管理详情/read/导出始终全答；推荐筛选不等于启停；保存草稿不影响线上策略，发布/回退生效；反例按同一归一化精确排除（繁简/全半角/标点/URL/空格），反例无正向索引。同一 searchKnowledge 验证问题命中、matchedQuestion、FAQ 去重、onlyRecommended、faqPriority/阈值；关键词单独命中不产 directAnswer，RRF/rerank 高分不得越过 cosine 门槛。
- K-F2 导入（A/F/W/C/U）：JSON/CSV 的数组、双引号、多行、字面 ##、BOM 与全字段往返；xlsx 常量单元格导入与公式/多非空工作表/实际解压上限拒绝。append 完全重复跳过/内容哈希命中合并运营字段/同题改答案及跨条目正向问冲突拒绝；replace 不提前删旧，显式全批发布后才替换；dryRun 零 DB/文件/job/模型写入且计数与实际计划相符。覆盖 total 四态等式、added/merged、逐项 field/code/原因、混合有效失败整批不落库、2MiB UTF-8（含多字节中文）/500行边界；真实 PG 验证导入事务失败/索引失败/批发布失败及快照变化保留旧集合，不能用逐项成功拼成原子成功。未接入 Excel 依赖时明确该项待实现，不宣称核心完整对齐。
- K-W1/W2（F/A/W/B/U）：人工 save 保持线上版本；新发布索引追上前无旧 Wiki 命中；来源失效即不可读；目录循环/跨库链接拒绝；版本 diff 与 sourceChunk 增删真实匹配；回退不得复活无效来源。
- K-E1（F/U/B）：固定无模型 fixture 可精确验证 Recall/MRR，评估与管理检索同结果；代表性真实数据校准门槛另列证据，不把默认0.3当效果结论。
- K-U1/U2/U3/U4（U）：只桌面，DESIGN-SYSTEM §10，恰一个 h1；真实 Router URL 筛选/刷新，RHF draft/pending 清理、错误/确认/键盘焦点；e2e 复用 test.setup/session 与隔离 seed。源码 review 不冒充浏览器验收。
- 每线使用根入口定向 `pnpm exec vitest run --project backend <实际受改 knowledge test 文件>`；web 用 `pnpm exec vitest run --project web <实际受改 test 文件>`（先核实际项目 name）；禁止在命令里填猜测的不存在文件。整合运行 `pnpm exec vitest run --project backend knowledge` 与 `pnpm exec vitest run --project web knowledge`，额外受改 metrics/授权/归档测试明确加入。
- 执行前 shared/core/db 产物已知来自当前源码；A 运行 `pnpm db:generate` 并在明确独占随机库地址下运行 `pnpm db:migrate`，再用现有 backend globalSetup 随机 PG/独享临时 Redis 验证，绝不迁共享库/默认 `.env` 库。迁移账本不手改；各代理只删自己的随机库/容器。
- 收口按改动包执行 typecheck/build；前端需要真实 ego-browser/e2e 验收时由主会话单独安排隔离服务，记录根目录/commit/配置绝对路径/URL，不动用户登录。最终报告真实命令、退出码、通过/失败/skip 数与未覆盖项；付费模型/真实外部源另列。

## 当前状态（2026-10-31 收口盘点）

> 本节只记录当前可读状态与真实阶段证据；上方实时契约仍是有效范围与验收标准。计数均来自 `/tmp` 报告，覆盖范围有重叠，**不相加**为产品总量。收口盘点时全部成果尚未提交、推送或合并（历史事实）；本轮随后按用户授权提交、推送并创建 PR（不合并），未迁移共享库、未改用户登录、未调用付费真实服务。

### 已实现能力与独立 PASS 域

- **本轮核心契约已在本地源码落地**：管理/版本与 COW、批量/目录/真实路径上传、FAQ 全量语义（标准/相似/反例/多答案/启停、JSON-CSV-xlsx 导入、JSON-CSV 导出）、Wiki 草稿/发布/目录/链接/贡献差异、统一检索与 MCP 三类目标/分页/诊断、来源撤权与逐项记录、来源 probe、知识队列指标、ZIP/专家包、离线评估、音频 ASR、9 种新增来源 adapter 与本地 fixture、引用定位（PDF 页/段/行/表、音频时码）。官方 SDK 文件 first、共享源与完整快照读取契约未改变。
- **已获独立 Opus PASS 的关键域**：A 三项库存/批次/跨源锁、队列取消与补投、普通 FAQ retry 换绑、ASR core 协议与错误分类、解析原文映射与 CRLF/emoji/重复表格定位、Wiki 发布事务 F9、Confluence 原 6 项、Nextcloud 原 3 项、Seafile downloadlink oid、source API 规范解析、来源入口 ZIP/ID、FAQ JSON 可选数组、Seafile 表单根、FAQ 持久批次、source PATCH/ID/ZIP、Confluence/Seafile/Nextcloud 三叶 mustfix、Lark/HTTP 整改、Notion/语雀原 5 项中的 4 项。对应路径见阶段日志。
- **Notion 最后一项已独立 PASS**：无 `has_more` 的 people/title/richtext 固定通过官方 property-item 读取完整终页。主会话复验48/48；独立36项与13个真实HTTP探针通过，证据 `/tmp/notion-property-independent-review-20261031-results.json`。本轮全部独立审查发现已修复并定点复核通过。
- **目录与历史 mini 浏览器已通过**：真实 FileChooser 选择两层同名文件目录，经上传入口创建正确文件夹关系；两原件哈希与源文件一致。UI 切换 v1/v2 下载各自原件，哈希分别匹配旧/新正文；Wiki 发布 v3 后，已有 v2 检索引用仍按 targetVersionId 打开旧正文。证据 `/tmp/knowledge-weknora-browser-knw-vYwCvi/round-mini/`。持久化聊天 trace 的旧版引用未实测，未伪造会话或调用真实模型。
- **最终构建与类型已验证**：Notion 最后修复后 `pnpm -r typecheck`、`pnpm -r build` 均退出 0，原生 ESM 加载、frozen lock、focus/contract 与 diff 检查通过；全来源11文件194/194。机械格式与未用导入已清，主会话110个受改TS文件 Biome退出0，保留333条warning（323个非空断言、10个可选链建议），无error；日志 `/tmp/knowledge-delivery-biome-final.log`。

### 阶段证据（真实命令结果，覆盖重叠不累加）

| 范围 | 结果 | 报告 |
|---|---|---|
| 后端 knowledge 整组 | 970/970，0 skip；Notion 最后属性修复后 | `/tmp/knowledge-delivery-backend-final.json` |
| 前端 knowledge/BlobPdf/chatOutputs/publicShare | 333/333，0 skip | `/tmp/knowledge-web-expanded-final.json` |
| 仓储/shared 整组 | 157/157，0 skip | `/tmp/knowledge-db-expanded-final.json` |
| 统一检索/MCP/多模态/评估 | 66/66 | `/tmp/knowledge-retrieval-final-integrated.json` |
| 队列/补投/调度 | 30/30 | `/tmp/knowledge-queue-recovery-integrated.json` |
| 归档/ZIP/专家包（含 ASR） | 61/61 | `/tmp/knowledge-archive-audio-integrated.json` |
| 真实发布整链（API→worker→MCP） | 9/9 | `/tmp/knowledge-audio-publishing-final.json` |
| 全来源协议与同步 11 文件 | 194/194 | `/tmp/knowledge-all-sources-final.json` |
| 来源 shared/API/同步/9 类 ZIP 边界 | 68/68 | `/tmp/knowledge-source-boundaries-final.json` |
| 管理/content/FAQ route/retry | 54/54 | `/tmp/knowledge-management-persistence-final.json` |
| 来源入口 PATCH/ID/真实版本 ZIP | 55/55 | `/tmp/knowledge-source-entry-rectified.json` |
| 来源最后协议与入口 | 103/103 | `/tmp/knowledge-source-last-fixes-integrated.json` |
| 来源公共链 | 13/13 | `/tmp/knowledge-source-integration-final.json` |
| 摄取完整性/解析/ASR 整合 | 177/177 | `/tmp/knowledge-ingestion-audio-parsing-integrated.json` |
| FAQ 持久/批次/重试 | 98/98 | `/tmp/knowledge-faq-persistence-final.json` |
| ASR core 根项目 | 89/89 | `/tmp/knowledge-asr-core-root-final.json` |
| Wiki 3 文件 | 53/53 | `/tmp/knowledge-wiki-final-expanded.json` |
| 来源仓储三叶 | 35/35 | `/tmp/knowledge-source-storage-checkpoint.json` |
| 来源整改集成 | 102/102 | `/tmp/knowledge-source-rectified-integration.json` |

历史阶段（已被较新报告替代，仅留阶段记录，不作当前验收）：核心后端 624/624（`/tmp/knowledge-weknora-backend-consolidated.json`）、核心前端 293/293（`/tmp/knowledge-weknora-web-consolidated.json`）。

### 浏览器验收与当前资源

- **冻结 09:45 构建的八组浏览器检查全部 pass**：七页签各一个 h1 + 离线评估 JSON、合法双页 PDF 第 2 页与下载 sha、ASR 有/无时码与下载 sha、FAQ 缺省数组/关闭重开恢复批发布/同 query 二次请求 random、Wiki 人工首稿+组织发布、Seafile 非法根拦截与合法 payload、9 provider 表单。证据 `/tmp/knowledge-weknora-browser-knw-vYwCvi/round-20261031-final/evidence`（53 文件，`checks.json` 8 项均 pass）。该轮有 429、会话 `authenticated=true`、无 401；**只证明本地协议质量，不代表真实 Docling/ASR/语义/企业账号质量，也不能覆盖 09:45 之后的来源/worker/source API 整改**。
- **隔离资源已清理**：TaskSpace80已释放；核对归属后优雅停止API/worker与3467/3477夹具，删除仅本轮`knw_browser_70333f`和独占Redis56381，所有本轮端口不再监听。共享PostgreSQL/Redis保持运行；主checkout干净。遗留worktree `.env` 经核对为本轮复制且与主配置相同后删除，未输出内容。证据及未提交worktree/node_modules保留，收尾记录 `/tmp/knowledge-weknora-cleanup-final.txt`；上述旧PID均已退出。
- 目录历史 mini 浏览器三组 PASS，证据 `round-mini/evidence.json` 与下载原件哈希；TaskSpace80已finish释放。全部测试资产只在本轮隔离库，Wiki当前因验收变为v3，旧版保留，非用户共享数据。

### 阶段日志：早期审查失败 → 修复 → 当前证据

> 只保留每轮真实症状与修复落点，不按轮次重复“待 owner”；同一问题不重复登记。

| 症状 | 修复 | 证据 / 当前状态 |
|---|---|---|
| 来源 PATCH 缩范围不能即时撤权，旧 worker 可重新发布 | source 快照在 source→document 锁序内核验；replaceSourceScope 事务撤权；readable SQL 唯一过滤 | 来源整组 146/146、边界 68/68；独立 PASS |
| 人工改块仍冒充原件、复制丢 enabled | COW 新版本、locator 清空、editedByUser、复制保留启停 | DB 157/157；独立 PASS |
| Feed 抓取失败把原全文降为摘要 | 同 hash 全文保护，仅首次摘要标 summary | 摄取 177/177、发布 9/9 |
| 解析丢 blocks/locator、重复短文本错位 | blocks→adapter→DB→search 贯通；原文映射修正；ASR 仅追加时码 | 解析 92 项 + ASR 整合 177/177；独立 PASS |
| Wiki 发布后索引未入队、撤权锁序 40P01、内部索引入生成来源 | 文件先写 blob、page/index/job 同事务、统一锁序、排除内部索引 | Wiki 53/53、发布整链 9/9；F9 独立 PASS |
| FAQ 批次发布绕过草稿/恢复、retry 仍指旧 job、可选数组缺失 | 持久 expectedVersionId/faqImportJobId、同事务换绑、缺省 []、100 条切片 | FAQ 98/98；独立 PASS |
| xlsx 导入被 ZIP 目录身份绕过限额；JSON/CSV 往返字段丢失 | 共享 ZIP 目录/解压字节限额、ExcelJS 常量单元格、同形导出 | 归档 61/61；独立 PASS |
| 9 来源分页/部分查询/签名附件/根范围等逐项缺陷 | 各 leaf 按官方分页完整性、bytes parser、签名刷新、根路径严格化 | 来源 146/146 + 68/68；Confluence/Nextcloud/Seafile 独立 PASS |
| ASR 时间码/错误分类/空音频与普通文件边界 | 唯一 multipart 协议、真实 segments、无时码不编造、共用 readJsonResponse | ASR core 89/89、发布 9/9；独立 PASS |
| Notion people/title/richtext 无 has_more 被截断仍 complete | 统一走官方 property-item 完整读取 | 修后48项、全来源194项与独立36项/13探针通过；独立 PASS。执行者覆盖的早期临时探针结果未用作红测证据 |
| 知识列表 created_at/id 与 latest version 顺序不一致 | Wiki list/cursor 统一 version DESC + 同页 keyset | 25 foundation + 11 worker Wiki；独立 PASS |
| MCP 微秒游标截毫秒漏页 | 游标保留微秒 + 同微秒 keyset | 3 文件 64 项；独立 PASS |
| 浏览器登录抖动（早期） | 未改 auth；只记录 requestId/authenticated/cookie 存在性，不记录 cookie 值 | 最终轮 authenticated=true、无 401，只有 429 |

### 文档/代码冲突与已替代项（集中保留）

- D-9 的 metadata-only 来源归属不足以范围撤权；以 source/range 表与 readable SQL 为授权真相。
- Wiki 文档原“草稿发布”与人工 save 实际自动发布不一致；现 save 只追加草稿，publish/rollback 才切指针。
- “旧版本保留”与 chunk 原地修改不一致；现人工增改删均生成新版本。
- source test 原名只做本地校验；现改为 source_probe 只读远程。
- MCP shared result 未携带 retrieval 的 degraded/warnings；已补并保留。
- US-8.11 原写“JSON/CSV/xlsx 导入导出”，与契约仅 xlsx 导入、JSON/CSV 导出冲突；已由主协调修正措辞，不声称 xlsx 导出完成。
- 首波派发 prompt、各轮“待 owner/正在复核”的中间态已从本文件收敛；官方 SDK 文件 first、共享源、完整快照与既有不变量不变。

## 外部依赖与真实服务验收边界

| ID | 当前本地落地 | 仍需的真实依赖 / 授权 |
|---|---|---|
| K-V1 | 视觉/Cohere/read_image 客户端与本地 fixture 已落 | 真实 Docling、视觉模型、Cohere embed-v4.0 端点与计费未授权；质量未验 |
| K-V2 | GitHub/GitLab/飞书/Feed adapter 与本地只读 fixture 已落 | 私库 scope、企业空间、限流额度与真实账户未配置 |
| K-X1 | ASR profile `kind=asr`、库 `asrProfileId`、multipart/segments/时码/引用/取消已落；无时码不均摊 | 真实兼容转录 endpoint/model、识别质量与费用未验；模型退役/能力以官方为准 |
| K-X2 | 无（有意不假造无后端图谱开关） | Neo4j 新增服务、备份/内存与抽取模型费用未授权；待依赖，不宣称完成 |
| K-X3a | Lark wiki/drive adapter + fixture 已落 | 真实 Lark 独立域名/租户应用/OAuth scope 未配置 |
| K-X3b | Notion/Confluence/语雀 adapter + fixture 与独立复核已通过 | 真实 token/站点/范围未配置，真实账号与配额未验 |
| K-X3c | 钉钉/IMA adapter + fixture 已落 | 真实应用权限/套餐/operator Union ID 未配置 |
| K-X3d | Seafile/Nextcloud adapter + fixture 已落 | 真实实例 URL、库/WebDAV 范围与凭证未配置 |

共同验收仍为：配置编辑→只读 probe→范围枚举/原始字节→增量→取消/重试→逐项错误→完整枚举才撤旧→专家检索引用→ZIP 往返。源码已落不等于真实服务验收；不新增视频能力，不部署未授权服务。

## 交付状态与保留资源

- 2026-10-31 收口盘点时成果仅在 worktree `feat/knowledge-weknora`，未提交、未推送、未合并且无 Git 授权（历史事实）。随后用户明确授权 commit、push 与创建 PR（仍不授权 merge）；本轮改动已提交到 `feat/knowledge-weknora`、推送 origin 并创建 PR，未合并；未生产发布、未迁移共享库、未改用户登录、未调用付费真实服务。PR 链接以本轮发布结果为准，不在文档中预填编号。
- 自动化 Vitest 报告已备份到 `/tmp/knowledge-weknora-report-backup-unique`；仅清理仓库内纯自动产物，未提交 worktree 不得删除。
- 本地实现、独立复核、最终类型/构建、后端970项、前端333项、全来源194项、机械检查与浏览器八组及mini三组均已取得真实结果，本轮隔离资源已清理。GraphRAG与真实服务质量/账号验收仍按外部依赖表保留，不能称完全追齐WeKnora全部能力；本次按用户授权以已验证的提交、推送与 PR（不合并）交付。
