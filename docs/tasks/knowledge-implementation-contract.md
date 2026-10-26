# 知识库实现契约（可执行版）

> 2026-10-25。基线 `797edfe`，工作树 `knowledge-base-research`。本文件是执行子代理的唯一契约来源；除本文件外不改产品代码、不提交。
> 上游决定：[核心方案](weknora-core-proposal.md)、[企业来源范围](weknora-enterprise-sources.md)、[PACE 边界](weknora-core-pace-boundaries.md)。冲突时以本文件固定的接口为准，范围仍以上述已确认目标为准。
> 标记 **RTV** 的条目是需要真实运行验证的实现细节，不得当成已验收事实。

## 0. 一句话方案

复用现有 React/Fastify/Drizzle/Postgres/Redis/BullMQ 与 Claude Agent SDK：文档元数据、版本、chunk、任务、同步游标、Wiki 存 Postgres；原件与解析产物存独立持久卷；解析走可配置 Docling HTTP；embedding/rerank 走可配置 OpenAI 兼容 HTTP；检索用 pgvector + 应用侧 `Intl.Segmenter` 分词 + Postgres `tsvector('simple')`；每个知识库自动生成一个内置 `servers.kind='knowledge'`，专家沿用 `agent_servers` 绑定；Wiki 生成由 worker 直接调用现有 `@anthropic-ai/claude-agent-sdk` 的 `query`，用进程内受控 MCP 工具保存草稿，不引入第二套消息循环。

## 1. 不可变边界

1. 不引入第二套 Agent harness；不直接调用 Anthropic Messages API 写循环。Wiki 只用已安装的 `@anthropic-ai/claude-agent-sdk` `query`。
2. 不新增多租户/RBAC；沿用单管理员 `requireAuth`。知识库是共享资源，导入即向绑定专家开放。
3. 不新增独立向量数据库、SQLite、Go 服务或第二套前端状态库。
4. 原有 `stdio/http/generated` server 的 SSRF、密钥、审批、父子边界不变；`knowledge` 只接受 run 短期 token。
5. 原件不存数据库二进制列；工作区仍只读，知识正文不挂载进沙盒。
6. 只做已确认范围：RSS/Atom/JSON Feed、飞书 Wiki/Drive、GitLab 仓库文件（项目/ref/path）。GitLab Wiki/Issue/MR、Lark 国际站、FAQ、图谱、Webhook 不实现，不加空壳。

## 2. 依赖与运行配置（最小新增）

| 项 | 决策 |
|---|---|
| Postgres 镜像 | 换成 `pgvector/pgvector:pg18`（PG18 + vector 扩展），首个迁移 `CREATE EXTENSION IF NOT EXISTS vector;`。**RTV**：确认镜像 tag 与现有数据卷兼容，仅切换镜像不重建库。 |
| 中文关键词 | 应用侧 `Intl.Segmenter('zh', { granularity: 'word' })`（Node 24 内置）。分词结果空格拼接写入 `search_text`；`search_vector` 用 PG 生成列 `GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED`（Drizzle schema 已有 `tsvector` customType 与在途定义），GIN 索引走生成列。若在途 schema 未写生成表达式，P1 在同一迁移里补 `ALTER TABLE ... ALTER COLUMN ... SET EXPRESSION`/重建列，禁止让应用双写 `search_vector`。 |
| 向量列 | Drizzle 无 `vector` 原生类型：在途 schema 已用 `customType` 定义 `vector(1024)`；HNSW 索引手工 SQL。读取时 `fromDriver` 目前 `JSON.parse(value)`，pg 驱动对 `vector` 返回的是 `'[1,2,...]'` 字符串，JSON.parse 可用；**RTV** 以实际驱动输出确认。 |
| Docling | 环境变量 `DOCLING_URL` 必填（HTTP 服务 base URL），可选 `DOCLING_TOKEN`（以 `X-Api-Key` 头发送，对应服务端 `DOCLING_SERVE_API_KEY`）。worker 用 Node 原生 `FormData`/`Blob` 调 `POST {DOCLING_URL}/v1/convert/file`，要求返回 `document.md_content` 与 `document.json_content`，写入 markdown/图片/页码表。**RTV**：按实际部署版本核对字段名；不兼容时只改 `knowledge/parsing.ts` 适配层。 |
| RSS/Atom/JSON | worker 单依赖 `feedsmith`（解析三种 feed）；HTML 正文转 Markdown 用 `turndown`。两个库只允许 worker 使用，owner：P2。 |
| embedding/rerank | DB 内加密 profile（见 §4.9）。`endpointUrl` 是 base URL，实际请求 `POST {endpointUrl}/embeddings`、`POST {endpointUrl}/rerank`。固定 embedding 维度 **1024**；profile 的 `dimensions` 必须为 1024，否则 400。**RTV**：以实际服务响应为准，不兼容只改 `core/knowledge-models.ts`。 |
| Wiki 模型 | 环境变量 `KNOWLEDGE_WIKI_MODEL` 必填，走 worker 现有模型网关/凭证；不新增 Anthropic key。 |
| 新持久卷 | Compose `knowledgedata:/knowledge`，api/worker 均挂载；`KNOWLEDGE_DIR=/knowledge`（本地默认 `./data/knowledge`）。备份纳入；`.worktreeinclude` 不需要（卷不在树内）。 |
| 私网端点 | 环境变量 `KNOWLEDGE_PRIVATE_HOST_ALLOWLIST`（逗号分隔主机名，可含端口）。作用于知识出站：worker 抓取/解析/embedding/rerank，API 的 profile 测试与来源创建校验；名单默认空。普通 MCP server 的 `assertSafeUrl` 不变，用户不能借知识配置把任意 URL 变成可信。 |

## 3. 存储布局与删除边界

```
$KNOWLEDGE_DIR/
  blobs/<sha256 前2位>/<sha256>            # 原件，按内容寻址，只读
  docs/<documentId>/<versionId>/markdown.md
  docs/<documentId>/<versionId>/images/<n>.<ext>
```

- 上传/抓取先写临时文件计算 sha256，再原子 `rename` 入 `blobs`；同内容复用同一 blob。
- API 不暴露静态目录。读取只走 `GET /api/knowledge/versions/:versionId/content`（原件）与 `.../markdown`（解析正文），响应 `Content-Disposition` 使用清洗后的标题。
- 版本切换：新版本解析、切块、embedding 全部成功后在**一个事务**里更新 `knowledge_documents.current_version_id`；失败保留旧版本继续可查。
- 重新索引 = 新建一个版本（复制 markdown/原件引用、重新 embedding），完成后原子切换，避免新旧向量混合。
- 删除文档：先 `UPDATE knowledge_wiki_sources SET stale=true` 关联页，再删 document（cascade versions/chunks/tags/文档标签关系），blob 不立即删。
- `cleanup` job 按 `knowledge_document_versions.blob_sha256` 无引用且超过 24h 才删 blob/解析目录。
- 外部源删除/失权：文档置 `status='disabled'`（不物理删、不参与检索），保留历史引用；只有用户显式 `documents=delete` 才物理删除。
- 删除知识库：删内置 server、全部行、所有 blob（入 cleanup 队列），消息中已保存的引用快照不回收，UI 显示“来源已删除”。
- 备份/导出：备份归档新增根条目 `knowledge/**`；数据包导出不含向量、密钥、运行游标。

## 4. 数据库表（Drizzle，字段即契约）

ID 全部 `newId()`，前缀加入 `packages/db/src/id.ts`：
`knowledgeBase: 'kb'`, `knowledgeFolder: 'kfd'`, `knowledgeDocument: 'kdoc'`, `knowledgeVersion: 'kdv'`, `knowledgeChunk: 'kchk'`, `knowledgeTag: 'ktag'`, `knowledgeJob: 'kjob'`, `knowledgeSource: 'ksrc'`, `knowledgeSourceRange: 'krng'`, `knowledgeSyncRun: 'ksyn'`, `knowledgeWikiPage: 'kwp'`, `knowledgeWikiVersion: 'kwv'`, `knowledgeWikiSource: 'kws'`, `knowledgeModelProfile: 'kmp'`.

时间列一律 `timestamp with timezone`；JSON 列使用 `jsonb` + `$type`；所有外键明确 `onDelete`。

### 4.1 knowledge_bases

| 列 | 类型/约束 |
|---|---|
| id | text PK |
| slug | text not null，`uniqueIndex` |
| name / description | text not null |
| status | text enum `active/disabled` not null default active |
| server_id | text not null unique → servers.id `onDelete cascade` |
| embedding_profile_id | text not null → knowledge_model_profiles.id `onDelete restrict` |
| rerank_profile_id | text null → ... `onDelete set null` |
| settings | jsonb `{ chunkTokens: number; chunkOverlap: number; wikiAutoUpdate: boolean }` not null |
| created_at / updated_at | timestamptz |

### 4.2 knowledge_folders

`id`, `base_id` → bases cascade, `parent_id` → self `onDelete cascade`, `name`, `path` text（`/a/b` 物化路径）, `created_at`。唯一 `(base_id, path)`；索引 `(base_id, parent_id)`。

### 4.3 knowledge_tags 与 knowledge_document_tags

`knowledge_tags`：`id`, `base_id` cascade, `name`, `created_at`。唯一 `(base_id, name)`。
`knowledge_document_tags`：`document_id` cascade, `tag_id` cascade。唯一 `(document_id, tag_id)`；索引 `(tag_id)`。组合主键，不单独生成 TypeID。

### 4.4 knowledge_documents

| 列 | 说明 |
|---|---|
| id / base_id | base cascade |
| folder_id | → folders `onDelete set null` |
| title | text not null |
| source_type | enum `upload/url/feishu_wiki/feishu_drive/gitlab/feed/manual` |
| source_id | text null，外部稳定 ID（飞书 token / GitLab `project:ref:path` / `feedURL:itemId`） |
| source_url | text null |
| source_path | text null，源层级路径 |
| mime_type / size_bytes | not null / bigint |
| status | enum `pending/processing/ready/failed/disabled` |
| current_version_id | text null（不做 FK，避免循环；版本删除前先清空） |
| content_hash | text null，当前版本源内容指纹 |
| metadata | jsonb（源端额外字段） |
| last_synced_at | timestamptz null |
| created_at / updated_at | timestamptz |

索引：`(base_id, status, updated_at desc)`；`(base_id, folder_id)`；唯一部分索引 `(base_id, source_type, source_id) WHERE source_id IS NOT NULL`。
身份规则：外部来源只按 `source_id` 匹配，绝不用标题；`upload/manual` 的 `source_id` 为空。

### 4.5 knowledge_document_versions

`id`, `document_id` cascade, `version` int, `blob_sha256` text, `markdown_sha256` text, `original_filename`, `mime_type`, `size_bytes` bigint, `source_revision` text null（commit sha / 飞书 edit_time / feed 指纹）, `parse_status` enum `parsed/parse_failed`, `page_map` jsonb `[{page,startOffset,endOffset}]`, `images` jsonb `[{name,sha256,mimeType,page}]`, `embedding_profile_id` text not null, `created_at`。唯一 `(document_id, version)`；索引 `(blob_sha256)`。

### 4.6 knowledge_chunks

`id`, `base_id` cascade, `document_id` cascade, `version_id` cascade, `folder_id` null, `ordinal` int, `kind` enum `text/table/image`, `heading` text null, `content` text, `search_text` text（应用侧分词结果）, `search_vector` `tsvector` generated always as `to_tsvector('simple', search_text)` stored（GIN 索引，应用不写）, `embedding vector(1024)` null, `enabled` bool default true, `edited_by_user` bool default false, `page_from` / `page_to` int null, `token_count` int, `metadata` jsonb, `created_at`, `updated_at`。
索引：唯一 `(version_id, ordinal)`；GIN `(search_vector)`；HNSW `(embedding vector_cosine_ops)` `WHERE enabled`；`(base_id, document_id)`。
Drizzle 对 `vector` 类型、HNSW `opclass`/部分索引的生成支持有限：在途 schema 已用 `customType` 定义向量列；`db:generate` 后手工补 HNSW 索引 SQL 到同一迁移文件，禁止改其他生成内容。**RTV**：`\d knowledge_chunks` 确认 GIN/HNSW 存在且查询走 HNSW。
检索条件固定为：`chunks.enabled AND documents.status='ready' AND documents.current_version_id = chunks.version_id AND chunks.embedding IS NOT NULL`。禁用/旧版本/失效文档不召回。

### 4.7 knowledge_sources / ranges / sync_runs

`knowledge_sources`：`id`, `base_id` cascade, `type` enum `feishu_wiki/feishu_drive/gitlab/feed`, `name`, `config` jsonb（baseUrl/project/ref/paths/feeds、`syncDeletions: boolean` 等非敏感项）, `secrets_encrypted` text null（AES-256-GCM，复用 `encryptSecrets`）, `status` enum `active/paused/auth_error/disabled`, `sync_cron` text null（5 段，UTC）, `cursor` jsonb not null default `{}`, `last_sync_at`, `last_sync_status` null, `last_error` null, `created_at/updated_at`。

`knowledge_source_ranges`：`id`, `source_id` cascade, `kind` enum `wiki_space/wiki_node/drive_folder/gitlab_project/feed`, `external_id` text, `ref` text null, `paths` jsonb `string[]`, `enabled` bool。唯一 `(source_id, kind, external_id, coalesce(ref,''))`（Drizzle 用表达式唯一索引）。
范围必须非空；空数组创建时 400，不解释为全企业。

`knowledge_sync_runs`：`id`, `source_id` cascade, `status` enum `queued/running/succeeded/failed/cancelled`, `started_at/ended_at`, `cursor_before/cursor_after` jsonb, `stats` jsonb `{listed,created,updated,disabled,failed}`, `error` null, `created_at`。索引 `(source_id, created_at desc)`。

### 4.8 knowledge_jobs

`id`, `type` enum `ingest/reindex/sync/wiki_generate/cleanup`, `base_id` null, `document_id` null, `source_id` null, `status` enum `queued/running/succeeded/failed/cancelled`, `step` text null, `progress` int default 0, `attempts` int default 0, `error` text null, `payload` jsonb not null, `created_at/started_at/ended_at`。索引 `(status, created_at)`、`(base_id, created_at desc)`、`(document_id)`。
BullMQ jobId = `knowledge_jobs.id`；worker 只认领 `queued`（条件更新）。

### 4.9 knowledge_model_profiles

`id`, `kind` enum `embedding/rerank`, `name`, `endpoint_url`, `model`, `dimensions` int null（embedding 必填且=1024）, `secrets_encrypted` text null, `enabled` bool, `created_at/updated_at`。唯一 `(kind, name)`。
API 永不回传 `secrets_encrypted`；响应只回 `hasSecret: boolean`。worker/API 内部用 `decryptSecrets`。

### 4.10 Wiki

`knowledge_wiki_pages`：`id`, `base_id` cascade, `slug`, `title`, `status` enum `draft/published/stale/failed`, `current_version_id` text null, `created_at/updated_at`。唯一 `(base_id, slug)`。
`knowledge_wiki_versions`：`id`, `page_id` cascade, `version` int, `markdown` text, `source_chunk_ids` jsonb `string[]`, `model` text, `generated_by` enum `sdk/manual`, `created_at`。唯一 `(page_id, version)`。
`knowledge_wiki_sources`：`page_id` cascade, `document_id` null `onDelete set null`, `version_id` null `onDelete set null`, `chunk_id` null `onDelete set null`, `stale` bool default false。唯一 `(page_id, chunk_id)`；索引 `(document_id)`。

## 5. Shared Zod 契约（`packages/shared/src/knowledge.ts`）

只定义前端与 API 共用的 wire 形状；worker job payload 也在同文件。所有导出从 `shared/src/index.ts` 再导出。

```ts
export const knowledgeBaseInputSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).default(''),
});
export const knowledgeBaseSchema = knowledgeBaseInputSchema.extend({
  id: z.string(), serverId: z.string(), status: z.enum(['active','disabled']),
  embeddingProfileId: z.string(), rerankProfileId: z.string().nullable(),
  settings: z.object({ chunkTokens: z.number().int().min(200).max(4000),
    chunkOverlap: z.number().int().min(0).max(1000), wikiAutoUpdate: z.boolean() }),
  createdAt: z.string(), updatedAt: z.string(),
});
export const knowledgeDocumentSchema = z.object({ /* id, baseId, folderId, title,
  sourceType, sourceUrl, sourcePath, mimeType, sizeBytes, status, currentVersionId,
  tags: z.array(z.string()), lastSyncedAt, createdAt, updatedAt */ });
export const knowledgeChunkSchema = z.object({ /* id, documentId, versionId, ordinal,
  kind, heading, content, enabled, editedByUser, pageFrom, pageTo */ });
export const knowledgeSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(500), folders: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]), limit: z.number().int().min(1).max(50).default(10),
  rerank: z.boolean().default(true),
});
export const knowledgeSearchHitSchema = z.object({ /* chunkId, documentId, versionId,
  title, heading, quote, pageFrom, pageTo, sourceUrl, score */ });
export const knowledgeJobSchema = z.object({ /* id, type, status, step, progress,
  attempts, error, createdAt, startedAt, endedAt */ });
export const knowledgeSourceInputSchema = z.discriminatedUnion('type', [/* 四种 */]);
export const knowledgeWikiPageSchema = z.object({ /* id, baseId, slug, title, status,
  currentVersionId, updatedAt */ });
```

Job payloads（`knowledgeJobPayloadSchema` 判别联合）：

```ts
{ type:'ingest', documentId }                     // 上传完成/外部条目首次入库
{ type:'reindex', baseId, documentIds?: string[], chunksOnly?: boolean }
// chunksOnly=true：不建新版本，只给当前版本 embedding 为空的 chunk 补向量（chunk 编辑后用）
{ type:'sync', sourceId, syncRunId }
{ type:'wiki_generate', baseId, pageId?: string, title?: string,
  instruction?: string, sourceDocumentIds?: string[] }
{ type:'cleanup', baseId?: string }
```

MCP 工具结果 wire（`knowledgeMcpResultSchema`，服务端与前端共用解析）：

```ts
search -> { hits: Array<{ chunkId, documentId, versionId, title, heading, quote,
  pageFrom, pageTo, sourceUrl, score }> }
read   -> { documentId, versionId, title, sourceUrl, markdown, truncated }
list   -> { items: Array<{ documentId, title, folderId, tags, sourceType, updatedAt }>,
            nextCursor: string | null }
```

## 6. 模块导出（函数名固定，执行包按此实现）

### 6.1 `packages/db/src/repo/knowledge.ts`（P1）

```ts
createBase(db, input: { slug; name; description; embeddingProfileId; rerankProfileId; settings }): Promise<Row>
getBase / getBaseByServerId / listBases / updateBase / deleteBase
createFolder / listFolders / renameFolder / moveFolder / deleteFolder
upsertTag / listTags / deleteTag / setDocumentTags / listDocumentTags
createDocument / getDocument / listDocuments / updateDocument / disableDocumentsBySource
createVersion / getVersion / setCurrentVersion / listVersions / deleteVersionsExcept
insertChunks / replaceChunks / listChunks / patchChunk / deleteChunk / listChunksMissingEmbedding
createJob / getJob / listJobs / claimJob / finishJob / requestCancel
createSource / getSource / listSources / updateSource / deleteSource
replaceRanges / listRanges
createSyncRun / finishSyncRun / listSyncRuns
createWikiPage / getWikiPage / listWikiPages / saveWikiVersion / rollbackWikiPage
markWikiStaleByDocument / listWikiVersions
createModelProfile / listModelProfiles / getModelProfileWithSecret / updateModelProfile
```

约定：写 `current_version_id` 与 `embedding_profile_id` 必须同一事务；`claimJob` 用 `UPDATE ... WHERE status='queued' RETURNING`；列表接口一律 cursor（`createdAt,id`）分页。

### 6.2 `packages/core/src/knowledge-models.ts`（P2）

```ts
export interface EmbeddingProfile { endpointUrl; model; apiKey?: string; dimensions: 1024 }
export interface RerankProfile { endpointUrl; model; apiKey?: string }
embedTexts(profile, texts: string[], signal?: AbortSignal): Promise<number[][]>
rerankDocuments(profile, query, documents: string[], signal?): Promise<Array<{ index: number; score: number }>>
segmentForSearch(text: string): string
```

失败的分类固定为 `auth | rate_limit | timeout | bad_response | unavailable`，写入 job error，不重试 auth/bad_response。

### 6.3 `packages/worker/src/knowledge/`（P2）

- `sources.ts`（在途执行单元已用此名；对外导出 `KnowledgeConnector`）：
```ts
export interface SourceItem {
  sourceId: string; sourceUrl: string | null; sourcePath: string | null;
  title: string; mimeType: string; revision: string;
  content: Buffer | { markdown: string };
}
export interface KnowledgeConnector {
  test(config, secrets, signal): Promise<{ ok: boolean; error?: string }>;
  listRanges(config, secrets, signal): Promise<Array<{ kind; externalId; name; ref?; paths? }>>;
  sync(input: { config; secrets; ranges; cursor; signal;
    onCheckpoint(cursor): Promise<void> }): AsyncIterable<SourceItem>;
}
export const connectors: Record<'feishu_wiki'|'feishu_drive'|'gitlab'|'feed', KnowledgeConnector>;
```

来源配置与凭证字段（`config` 存非敏感项，`secrets` 加密）：

| type | config | secrets | ranges |
|---|---|---|---|
| `feishu_wiki` | `{ appId, baseUrl? }`（`baseUrl` 仅 Lark 国际站扩展，首批不启用） | `{ appSecret }` | `{ kind:'wiki_space', externalId: spaceId }` 或 `{ kind:'wiki_node', externalId: nodeToken }` |
| `feishu_drive` | `{ appId, baseUrl? }` | `{ appSecret }` | 必须至少一个 `{ kind:'drive_folder', externalId: folderToken }`；空即 400 |
| `gitlab` | `{ baseUrl, projectId, ref }` | `{ token }` | `{ kind:'gitlab_project', externalId: projectId, ref, paths }`，`paths` 为空表示整仓（仍受扩展名白名单） |
| `feed` | `{}` | `{}` | 每个 feed URL 一项 `{ kind:'feed', externalId: feedUrl }` |

- `sourceBase.ranges` 在 shared schema 已是 `.min(1)`；API 不再二次判空。
- `listRanges` 只用于连接测试/资源选择；真正同步只取已保存的 `knowledge_source_ranges`，空集合不执行、不解释为全量。
- GitLab 首批一个来源只对应一个 `projectId + ref`；多项目 = 多个来源，避免 config 与 ranges 双写漂移。
- `parsing.ts`（在途执行单元已用此名）：`parseWithDocling(input: {filename,mimeType,data}): Promise<{ markdown; images; pageMap }>`；`chunkMarkdown(markdown, pageMap, {chunkTokens,overlap}): ChunkDraft[]`，优先按标题/段落，表格整体保留。分块与解析同文件，避免跨包接口漂移。
- `ingestion.ts`：`runIngest(job)`、`runReindex(job)`、`runSync(job)`、`runCleanup(job)`。
- `queue.ts`：`startKnowledgeWorker(config)` 返回 `{ close() }`；队列名 `KNOWLEDGE_JOBS_QUEUE` 在 shared 定义。

### 6.4 `packages/api/src/features/knowledge/`（P3）

- `routes.ts`：基础库/文档/chunk/检索/任务/profile CRUD + 上传 + 导出。
- `retrieval.ts`：`searchKnowledge(db, baseId, query): Promise<Hit[]>`；关键词与向量各取 top 50，RRF(k=60) 融合取前 30，再按 base 的 rerank profile 重排取 limit；embedding 不可用时只返回关键词结果并在响应带 `degraded: true`。
- `service.ts`：`ensureKnowledgeServer(db, base)`、`createJob(...)`、`enqueueKnowledgeJob(job)`（BullMQ `getKnowledgeQueue`）。
- `wiki-routes.ts`（P5 所有，P3 只注册）：Wiki 页面 CRUD/生成/回退。
- `package.ts`：`exportKnowledgeBase(db, id)` / `importKnowledgeBase(db, zip)`，ZIP 由 `fflate` 处理，格式 `agentport/knowledge@1`。

### 6.5 内置 MCP（P4）

`packages/api/src/features/knowledge/mcp.ts`：

```ts
export function buildKnowledgeServer(input: {
  db; baseId; serverId; runId: string | null; secretKey: string;
}): McpHttpHandler
export const KNOWLEDGE_TOOL_NAMES = ['knowledge_search','knowledge_read','knowledge_list'] as const;
```

- 路由 `/mcp/:serverId` 对 `kind='generated'` 走原逻辑；`kind='knowledge'` 走本模块。
- 鉴权只接受 run token：`getRunToken` 返回可用 hash 且 `isRunBoundToServer(runId, serverId)` 为真；不接受长期 token。无效一律 401。
- 绑定决定可见库：server.config.knowledgeBaseId 是唯一库；工具参数不得跨库；若参数带 `baseId` 且不等于绑定库，返回工具错误（不是静默降级）。
- 库 `status != 'active'` 时三个工具都返回 `BASE_DISABLED` 工具错误；`knowledge_read` 只读当前版本且要求文档 `status='ready'`，历史引用走 REST 版本接口。
- 三个工具只读；不提供写入、上传、删除、重建工具。结果按 §5 wire 返回 JSON 文本，`quote` 截断 1200 字符。

**server 接线（选型：新增 `kind='knowledge'`，不复用 generated）**。理由：generated 的 schema 要求 `baseUrl`、会生成长期 `mcpToken`、出现在 server 列表并允许编辑/测试，复用会让内置连接继承这些用户可控语义；独立 kind 才能保证“无长期 token、URL 由运行时拼、用户不可编辑”。

**读写类型分离（与在途代码一致）**：`knowledge` 只出现在“读/运行时”联合，不进入用户输入联合：
- `serverKindSchema` 含 `knowledge`（DB 与读路径需要）。
- `serverInputSchema` / `ServerInput` 仍只有 `stdio/http/generated`（用户创建/导入天然无法提交 `knowledge`），不需要额外别名 schema。
- `serverSchema` 改为 `z.discriminatedUnion('kind', [stdio, http, generated, knowledge].map(withIdFields))` 或等价的读联合，使 `toApiServer` 返回 `kind:'knowledge'` 不需要类型断言。
- `knowledgeServerSchema` 保持只描述读形状（`name/description/config.knowledgeBaseId`），不加入 `serverInputSchema`。

代价是下列所有按 kind 分派的调用方必须同时加分支，全部由 **P1** 完成（P2/P4 不再碰）：

- `packages/shared/src/mcp.ts`：`serverKindSchema` 加 `knowledge`；`knowledgeServerSchema` 描述读形状；`serverSchema` 用读联合纳入 knowledge；`serverInputSchema` 不带 knowledge；`knowledgeMcpEntry(apiUrl, serverId, runId, token)` 统一构造运行时/预览条目。
- `packages/core/src/tools.ts`：**不改**。`toMcpJsonEntry` 只接受 `ServerInput`（不含 knowledge）；knowledge 条目由 `knowledgeMcpEntry` 直接构造，避免把内部 kind 塞进通用输入类型。
- `packages/api/src/features/servers/repo.ts`：`toApiServer` 返回 `{ ...base, kind:'knowledge', knowledgeBaseId }`，不生成/回显 `mcpToken`；`splitInput` 只写 `{ knowledgeBaseId }`，拒绝外部 headers；`ServerPatch` 不接受该 kind。
- `packages/api/src/features/servers/test-connection.ts`：knowledge 直接返回 `{ ok: true, tools: 3 }` 的本地实现结果，不发外部请求（真实连通性由 run smoke 验证）。
- `packages/api/src/features/agent-package.ts`：knowledge server 不写入导出包；导入时遇到该 kind 拒绝并给 warning。
- `packages/api/src/features/servers/routes.ts`：列表过滤 `kind='knowledge'`；创建/导入继续用 `serverInputSchema`（天然不含 knowledge，无需别名 schema）；knowledge 的 PATCH/DELETE 返回 404/403，只能经知识库生命周期管理（P4 负责行为）。
- worker `toEntry` 与 API 预览 `agents/workspace.ts` 的 `toEntry`：当前都对行 `serverInputSchema.parse(...)`，knowledge 行会解析失败。必须先按 `kind` 分支：knowledge 用 `knowledgeServerSchema` 读取 `config.knowledgeBaseId` 并跳过 `previewMcpEntry` 的通用路径，直接构造 `{ type:'http', url: `${apiUrl}/mcp/${server.id}`, headers: { Authorization: Bearer <runToken>, 'x-…-run-id': runId } }`。两者共用同一段逻辑（放 `shared/src/mcp.ts` 的 `knowledgeMcpEntry(apiUrl, serverId, runId, token)`），避免预览与运行时漂移。
- web `servers.tsx`/`agents.tsx` 的 `kind === 'generated'` 分支：knowledge 只按普通 http 展示名称，不显示工具编辑器；知识库专门页面由 P6 提供。
- 知识 server 的 `config` 只由平台写入 `{ knowledgeBaseId }`；URL 永远运行时拼 `/mcp/:serverId`，不接受用户输入。

### 6.6 Wiki（P5）

`packages/worker/src/knowledge/wiki.ts`：

```ts
export async function runWikiGenerate(job, deps: {
  db; config; signal: AbortSignal;
  saveDraft(input: { pageId; markdown; sourceChunkIds }): Promise<void>;
}): Promise<void>
```

执行方式固定为：

1. `knowledge_jobs` 认领后创建 `AbortController`；取消时 abort。
2. 用已安装 SDK 导出的 `createSdkMcpServer` + `tool`（`sdk.d.ts:633`、`:10079` 静态确认）注册三个工具：`wiki_search`、`wiki_read`、`wiki_save_draft`。工具闭包绑定 `baseId` 与 jobId，不接受外部 URL/库 ID；`wiki_save_draft` 只写 `knowledge_wiki_versions` 草稿并设置页面 `draft`，不发布。
3. 调 `query({ prompt, options: { mcpServers: { knowledge: server }, allowedTools: ['mcp__knowledge__wiki_search','mcp__knowledge__wiki_read','mcp__knowledge__wiki_save_draft'], settingSources: [], permissionMode: 'dontAsk', maxTurns: 12, maxBudgetUsd: 0.5, abortController } })`；模型取 `KNOWLEDGE_WIKI_MODEL`。不启动沙盒、不写工作区、不新增 agent 行。工具 handler 直接调用本次 `runWikiGenerate` 的 `deps.saveDraft`，不经过 HTTP/MCP 端点。
4. 只有 job 仍为 `running` 时接受保存；结束把 job 置 succeeded/failed。失败保留上一已发布版本。
5. 发布/回退走 REST 人工动作；自动更新只生成 draft 并把 `status='stale'` 供人确认。

**与聊天 run 的关系**：Wiki 生成使用独立 `knowledge_jobs` 行与独立队列，不创建 `agent_runs`、`conversations`、`messages`，不占聊天并发额度、不出现在运行历史；其成本只记在 `knowledge_jobs.payload` 之外由 SDK 结果读取后写入 `knowledge_wiki_versions.model` 与 job 日志，不做 run 计费聚合。

**人工 chunk 与重解析冲突**：chunk 被 `edited_by_user` 标记后，`reprocess`/`reindex` 一律新建版本、不继承人工 chunk；API 在提交前要求 `confirmOverwriteManualChunks: true`，否则 409，响应 `manualChunkCount`。旧版本保留可查，直到用户删除版本或文档。

## 7. REST 路由（全部 `requireAuth`，除 MCP 端点）

路由文件用 `typed(rawApp)`；body/params/querystring 全部走 schema，handler 不 `safeParse`。上传走 base64 JSON 而非 multipart，避免新增 multipart 依赖：`PUT /api/knowledge/bases/:id/documents/upload`，body `{ filename, mimeType, dataBase64 }`，`bodyLimit: 48 MiB`，解码后上限 32 MiB。

```
GET    /api/knowledge/bases
POST   /api/knowledge/bases
GET    /api/knowledge/bases/:id
PATCH  /api/knowledge/bases/:id
DELETE /api/knowledge/bases/:id
GET    /api/knowledge/bases/:id/folders
POST   /api/knowledge/bases/:id/folders
PATCH  /api/knowledge/folders/:folderId
DELETE /api/knowledge/folders/:folderId
GET    /api/knowledge/bases/:id/tags
POST   /api/knowledge/bases/:id/tags
DELETE /api/knowledge/tags/:tagId
GET    /api/knowledge/bases/:id/documents?folderId&tag&status&q&cursor
PUT    /api/knowledge/bases/:id/documents/upload
GET    /api/knowledge/documents/:documentId
PATCH  /api/knowledge/documents/:documentId      # title/folderId/tags/status
DELETE /api/knowledge/documents/:documentId
POST   /api/knowledge/documents/:documentId/reprocess
GET    /api/knowledge/documents/:documentId/chunks?versionId&cursor
POST   /api/knowledge/documents/:documentId/chunks
PATCH  /api/knowledge/chunks/:chunkId             # content/enabled：重算 search_text，embedding 置 NULL，入队 chunksOnly 补向量
DELETE /api/knowledge/chunks/:chunkId
GET    /api/knowledge/versions/:versionId/content # 原件流
GET    /api/knowledge/versions/:versionId/markdown # text/markdown；文档状态走 X-Knowledge-Document-Status 响应头
GET    /api/knowledge/bases/:id/search?q&folders&tags&limit&rerank
POST   /api/knowledge/bases/:id/rebuild
GET    /api/knowledge/jobs?baseId&status&cursor
GET    /api/knowledge/jobs/:jobId
POST   /api/knowledge/jobs/:jobId/retry
POST   /api/knowledge/jobs/:jobId/cancel
GET    /api/knowledge/bases/:id/sources
POST   /api/knowledge/bases/:id/sources
PATCH  /api/knowledge/sources/:sourceId
DELETE /api/knowledge/sources/:sourceId?documents=keep|delete
POST   /api/knowledge/sources/:sourceId/test
POST   /api/knowledge/sources/:sourceId/sync
GET    /api/knowledge/sources/:sourceId/runs
GET    /api/knowledge/bases/:id/wiki-pages
POST   /api/knowledge/bases/:id/wiki-pages
GET    /api/knowledge/wiki-pages/:pageId
PATCH  /api/knowledge/wiki-pages/:pageId          # title/markdown 人工版本
POST   /api/knowledge/wiki-pages/:pageId/generate
POST   /api/knowledge/wiki-pages/:pageId/rollback
GET    /api/knowledge/model-profiles
POST   /api/knowledge/model-profiles
PATCH  /api/knowledge/model-profiles/:profileId
DELETE /api/knowledge/model-profiles/:profileId
POST   /api/knowledge/model-profiles/:profileId/test
GET    /api/knowledge/bases/:id/export
POST   /api/knowledge/bases/import
```

业务规则：
- 创建库必须带可用 embedding profile；`ensureKnowledgeServer` 自动建 `servers` 行（`kind='knowledge'`, name `kb-<slug>`，config `{knowledgeBaseId}`，`mcpToken` 不生成）。
- 知识 server 不出现在 `/api/servers` 列表，不允许通过 servers API 修改/删除；删除库时一并删。`serverInputSchema` 不含 `knowledge`，用户无法通过创建/导入伪造内置连接。
- 上传/同步/重建/清理由 API 写 `knowledge_jobs` 后入队；返回 `202 { jobId }`。
- embedding/rerank profile 创建/更新时校验 `endpointUrl` 非空且 `dimensions=1024`；`test` 端点发一次最小请求并把分类结果写回响应，不落 job。
- `PATCH /documents/:documentId` 若把 `status` 从 `disabled` 改回 `ready`，必须当前版本 chunk 齐全，否则 409。
- `POST /documents/:documentId/reprocess` body 可为 `{ confirmOverwriteManualChunks?: boolean }`；存在人工 chunk 且未确认时 409 + `manualChunkCount`。
- 删除库或文档前检查 `agent_servers` 绑定：库删除直接级联解绑并在审计记录；文档删除不阻断，返回 `wikiPagesMarkedStale`。
- 错误统一 `fail(code, message)`；业务冲突 409 `CONFLICT`，范围为空 400 `INVALID_INPUT`。

## 8. Worker 队列与任务语义

- 新队列 `KNOWLEDGE_JOBS_QUEUE='knowledge-jobs'`，shared 导出常量与 `knowledgeEnqueueOptions(jobId)`（`attempts: 3`, 指数退避, `jobId` 去重）。
- worker 启动时同时启动 `startKnowledgeWorker`；维护/对账新增：把长时间 `running` 且超过 `2 * timeout` 的 job 置 failed、把 Redis 丢失但 DB queued 的 job 重新入队（沿用 `reconcile.ts` 模式）。
- 每次认领条件更新 `queued → running`；终态只写一次；取消写 `cancelled`，运行中取消通过 Redis cancel key + `AbortController`。
- 同步检查点：每 50 条或 30 秒写 `knowledge_sync_runs.cursor_after`，失败不推进游标；列举失败绝不触发批量 disable。
- 定时同步：`sync_cron` 非空时，worker 复用 `scheduler.ts` 的 `upsertJobScheduler` 模式注册 `knowledge-sync:<sourceId>` 调度器，到点只创建 `knowledge_jobs(type='sync')` 并入队；不在 Redis 里保存凭证。`sync_cron` 置空即移除调度器。手动 `POST .../sync` 与定时共用同一去重键 `sourceId + syncRunId`。
- 任务超时：ingest/sync 30 分钟、reindex 2 小时、wiki_generate 15 分钟；超时由 worker 内部 `AbortController` 与 job 截止时间共同保证，终态 `failed` 并保留游标/旧版本。
- Feeds：条目自然滚出窗口不删除；更新按 `sourceId` 覆盖，内容不变跳过。GitLab：只读选定 `project_id + ref + paths` 的文件，沿用参考实现的扩展名白名单（pdf/docx/pptx/xlsx/md/txt/html/csv/图片），其余忽略；删除来自 compare 的 `OldPath` 且受 `config.syncDeletions` 控制。飞书：Wiki 按空间/节点，Drive 必须显式 folder token，列举不全暂缓删除。

## 9. 前端接入（复用现有模式）

- `packages/web/src/lib/api.ts`：新增 `api.knowledgeBases/list/...` 方法，错误沿用 `ApiError`。
- `packages/web/src/lib/queries.ts`：`knowledgeBasesQuery`、`knowledgeDocumentsQuery(baseId, filters)`（infinite）、`knowledgeDocumentQuery(id)`、`knowledgeJobsQuery(baseId)`、`knowledgeSearchQuery`（mutation/`useQuery` with enabled）、`wikiPagesQuery(baseId)`。变更后就地 `invalidateQueries`。
- 路由：`/knowledge` 与 `/knowledge/$baseId`（`_shell` 内），页面骨架用 `Page/PageHeader/PageToolbar/PageSection`；导航资源区新增“知识库”入口。
- 专家编辑页：server 选择器显示 `kind='knowledge'` 条目（按知识库名分组），沿用 `agent_servers`；父子各自绑定。
- 聊天引用：从已持久化的 tool 结果中识别 `mcp__<server>__knowledge_search`，按 §5 wire 解析；点击 hit 调 `GET /api/knowledge/versions/:versionId/markdown` 打开原文并高亮 quote。无结构化引用事件改动；不修改 `ChatEvent`。
- 检索测试页：展示关键词/向量/融合分数与耗时；`degraded` 时明确提示向量不可用。

## 10. 凭证、模型与数据保护

- 复用 `APP_SECRET_KEY` 与 `encryptSecrets/decryptSecrets`（AES-256-GCM）加密：来源 `appSecret`/GitLab `token`、embedding/rerank API key。DB 只存密文；API 只回 `hasSecret`。
- Wiki 生成不接触上述密钥；使用 worker 现有模型网关凭证，模型名取 `KNOWLEDGE_WIKI_MODEL`。
- 日志与审计不记录明文凭证、文档正文或向量；任务错误只存分类与截断后的消息。
- 内部知识 server 无长期 token；仅 run token 可用，run 结束即失效。
- 备份与环境变量不写入数据包；数据包含原件与人工内容，导入端按 ZIP 路径规则校验（拒绝绝对路径、`..`、链接、超限条目）。

## 11. 导出、备份与恢复

- 知识库数据包：ZIP 根 `manifest.json`（format `agentport/knowledge@1`, version, base 元数据、文档/标签/文件夹/人工 chunk/Wiki 版本、sha256 清单）+ `documents/<documentId>/original` + `documents/<documentId>/markdown.md`。不含向量、密钥、游标、run 记录。
- 导入：新 ID、新内置 server；embedding/rerank profile 按名称匹配，缺失则明确报错并保留文档为 `pending`，不自动调用外部服务。
- 备份：`scripts/backup-lib.sh` 的 `normalize_member` 根条目白名单加 `knowledge`（当前为 `manifest.json|database.dump|env|workspaces`，位置 `:334`）；`write_manifest`（`:362`）增加 `knowledge.sha256/files/bytes` 并同步 `manifest_fields`、`archive_validate` 的必填/总量校验（`:453`、`:471-486`、`:525`）；`backup.sh` 增加 `KNOWLEDGE_DIR` 拷贝与统计；`restore.sh` 走同一 `ws_swap` 模式恢复；归档仍拒绝绝对路径/`..`/链接。恢复后索引可重建；不把向量写入备份。
- 恢复后索引可重建；不把向量写入备份。

## 12. 执行包（5–7 个，独占文件，禁止交叉）

> 顺序：P1 →（P2 与 P3-A 并行）→（P4 与 P5 并行）→ P3-B → P6 → P7。依赖关系：P2/P3-A 只依赖 P1；P4 依赖 P1 的 server schema 与 P3-A 的检索；P5 依赖 P3-A；P3-B 依赖 P5 的路由文件存在；P6 依赖 P3-B 的 REST 路由；P7 最后。每包只改下列文件；需要跨包改动先在契约变更中登记。文件所有权是排他的：P1 定完 kind 后，`worker/src/index.ts` 的 `toEntry`、`servers/repo.ts`、`agents/workspace.ts` 不再由其他包修改。

### P1 — DB/Shared 基础（sonnet）

- `packages/db/src/schema.ts`（仅新增知识表与 servers 枚举）
- `packages/db/src/id.ts`、`packages/db/src/repo/knowledge.ts`、`packages/db/src/repo/index.ts`
- `packages/db/src/migrations/*`（generate 产物；`servers_kind_check` 需 alter 为含 `knowledge`；手工补 vector customType 与 HNSW 索引 SQL）
- `packages/shared/src/knowledge.ts`（已由在途单元创建；补齐缺失项即可，不重建）、`packages/shared/src/mcp.ts`（读联合含 knowledge、`serverInputSchema` 不含、`previewMcpEntry`）、`packages/shared/src/index.ts`
- `packages/core/src/tools.ts`（不改；仅确认 knowledge 不进入 `ServerInput` 路径）
- `packages/api/src/features/servers/repo.ts`（`toApiServer`/`splitInput`/`ServerPatch` 的 knowledge 分支）
- `packages/api/src/features/servers/test-connection.ts`（knowledge 本地结果分支）
- `packages/api/src/features/agent-package.ts`（knowledge 不导出、导入拒绝）
- `packages/api/src/features/agents/workspace.ts`（预览 `toEntry` 的 knowledge 分支）
- `packages/worker/src/index.ts`（仅 `toEntry` 的 knowledge 分支；不挂载 worker）
- `packages/web/src/pages/servers.tsx`（仅让 knowledge 不进 generated 工具编辑器、不出现在用户可编辑列表）
- 验收：`pnpm db:generate`；`pnpm typecheck` 全仓通过；迁移在空库与现有库各跑一次；`\d knowledge_chunks` 含 GIN 与 HNSW；`packages/api/test/servers.test.ts` 与 `agent-package-zip.test.ts` 回归通过。

### P2 — Worker 摄取（sonnet）

- `packages/worker/src/knowledge/{sources,parsing,ingestion,queue,http}.ts`（`sources.ts`/`parsing.ts` 与在途执行单元一致，不得并行再造同义文件）
- `packages/worker/src/index.ts`（仅挂载 `startKnowledgeWorker`；`toEntry` 已由 P1 改完，P2 不再碰）、`packages/worker/src/config.ts`
- `packages/core/src/knowledge-models.ts`、`packages/core/src/index.ts`（仅新增导出）
- `packages/worker/package.json` + lock（`feedsmith`、`turndown` 及 types）
- 验收：`pnpm --filter @agentport/worker typecheck`；connector 单测用本地 fixture；Docling/embedding 失败分类单测。

### P3 — API 知识与检索（sonnet）

- `packages/api/src/features/knowledge/{routes,retrieval,service,package}.ts`
- `packages/api/src/queue/producer.ts`（仅新增 `getKnowledgeQueue` 并导出入队函数，不改 run/eval 队列）
- `packages/api/src/routes/index.ts`（唯一 owner：注册 `registerKnowledgeRoutes`；该函数内部调用 P5 的 `registerWikiRoutes`，不重复 import）
- `packages/api/src/config.ts`（`KNOWLEDGE_DIR` 校验；`DOCLING_URL` 只在 worker config）
- `packages/api/src/features/servers/repo.ts` 由 P1 完成 knowledge 分支；P3 不改。
- `packages/api/src/features/servers/routes.ts` 由 P4 完成过滤与创建/导入拒绝；P3 不改。
- 分两阶段：A 先交付 `retrieval.ts`/`service.ts`/`package.ts`（P4/P5/P6 的依赖）；B 在 P5 的 `wiki-routes.ts` 已存在后再交付 `routes.ts` 与注册。任何阶段都不允许 typecheck 处于失败状态。
- `packages/api/src/features/servers/repo.ts` 由 P1 完成 knowledge 分支；P3 不改。
- `packages/api/src/features/servers/routes.ts` 由 P4 完成过滤与创建/导入拒绝；P3 不改。
- 验收：`pnpm --filter @agentport/api typecheck`；API 集成测试覆盖建库→上传→job→搜索→删除；`pnpm test` 定向用例。

### P4 — 内置 MCP 与 server 接线（sonnet）

- `packages/api/src/features/knowledge/mcp.ts`
- `packages/api/src/features/servers/mcp-endpoint.ts`（仅 `kind='knowledge'` 分支；鉴权沿用现有 run token 路径）
- `packages/api/src/features/servers/routes.ts`（列表过滤、PATCH/DELETE 禁止；`serverInputSchema` 已天然排除 knowledge）
- 依赖：P1 已完成所有 kind 编译接线与 `toEntry`；P4 不碰 worker、不改 `agent-invoker.ts`、不改 `repo.ts`。
- 验收：run token 正例、无 run/错 server/跨库/未绑定负例；真实 SDK init 显示 knowledge server connected（本地 smoke）。

### P5 — Wiki（opus 设计评审、sonnet 执行）

- `packages/worker/src/knowledge/wiki.ts`
- `packages/api/src/features/knowledge/wiki-routes.ts`
- 依赖：P3-A 的 `retrieval.ts`/`service.ts`（搜索与任务入队）、P1 的 Wiki 表；不依赖 P3-B。
- 验收：生成草稿不覆盖已发布版本；取消中止 SDK；失败保留旧版；回退产生新版本。

### P6 — Web（sonnet）

- `packages/web/src/lib/api.ts`、`packages/web/src/lib/queries.ts`
- `packages/web/src/routes/_shell/knowledge.tsx`、`packages/web/src/routes/_shell/knowledge.$baseId.tsx`
- `packages/web/src/pages/knowledge*.tsx`、`packages/web/src/components/app-shell.tsx`、`packages/web/src/pages/agents.tsx`（专家绑定选择器；该文件不由 P1 修改）
- `packages/web/src/pages/chat.tsx`（仅引用查看器接入）与 `packages/web/src/components/ui/message.tsx`（仅来源入口，如确需改动）
- 依赖：P3-B 的 REST 路由（搜索/文档/任务/Wiki）与 P4 的专家绑定可见性。
- 验收：`pnpm --filter @agentport/web typecheck`；`pnpm test:web`；`pnpm lint:focus`。

### P7 — 部署/备份/e2e（sonnet）

- `docker-compose.yml`、`.env.example`、`.worktreeinclude`（如需）
- `scripts/backup.sh`、`scripts/backup-lib.sh`、`scripts/restore.sh`
- `tests/*.e2e.ts`（新增知识闭环用例）
- 依赖：P1–P6 已合入；备份脚本改动与 P2 的卷路径一致。
- 验收：`pnpm infra:up` 后 migrate 成功；`pnpm backup && pnpm restore` 在测试目录演练；`pnpm test:e2e` 单用例。

## 13. 测试与验证命令（真实执行后才算完成）

```bash
pnpm install --frozen-lockfile
pnpm db:generate && pnpm db:migrate
pnpm typecheck
pnpm exec vitest run packages/api/test/knowledge-api.test.ts \
  packages/worker/test/knowledge-ingestion.test.ts \
  packages/api/test/knowledge-mcp.test.ts \
  packages/worker/test/knowledge-wiki.test.ts
pnpm test:web
pnpm lint:focus && pnpm lint:contract
pnpm test:e2e          # 知识闭环单用例
pnpm backup && pnpm restore   # 按 OPERATIONS 使用隔离目录
```

必须覆盖的负例：范围为空；embedding 认证失败/维度不符；Docling 超时；Docling 返回损坏文件；未绑定/伪造 run token；跨库 chunkId 读取；取消后不得写入；同步列举失败不得批量 disable；删除后搜索不召回；重解析失败保留旧版本；远端删除只 disable；备份归档路径穿越拒绝。

## 14. 明确标注的 runtime 待验证

1. `pgvector/pgvector:pg18` 镜像与现有 `pgdata` 卷兼容性及 HNSW 索引行为。
2. Docling 服务实际响应字段（`document.md_content` / `document.json_content`）与图片、页码结构。
3. `createSdkMcpServer`/`tool` 的静态导出已确认；其运行时工具发现与 `allowedTools` 名称（`mcp__knowledge__*`）仍需真实 SDK init 验证。
4. embedding/rerank 服务的实际请求/响应形状、1024 维、批量上限与限流。
5. 飞书 tenant token、scope 与导出行为；GitLab PAT scope；自建实例私网可达性。均需真实凭证与目标版本，不在本契约内宣称已验证。
6. Feeds 解析库对异常 feed 的容错；Feed 条目 HTML 转 Markdown 的清洗边界。
7. `importKnowledgeBase` 的 ZIP 大小上限与 `fflate` 解压内存；先按 256 MiB 归档上限实现并压测。

## 15. 与在途任务记录的关系

同期任务记录 [knowledge-implementation.md](knowledge-implementation.md) 已登记两个独占执行单元：`packages/worker/src/knowledge/sources.ts`（飞书/GitLab/RSS 只读适配）与 `packages/worker/src/knowledge/parsing.ts`（文本/Docling 解析与分块）。本契约采用这两个文件名作为唯一名称；执行单元完成后再由 P2 接 `ingestion.ts`/`queue.ts`，不重命名、不另建同义模块。任务记录中的进度与验证属于执行侧，继续以其为准；契约冲突时以本文件接口为准并回写任务记录。

工作树已存在在途改动：`packages/db/src/id.ts`（ID 前缀）、`packages/db/src/schema.ts`（`servers.kind` 加 knowledge、vector/tsvector customType）、`packages/shared/src/knowledge.ts`（完整 wire schemas）、`packages/shared/src/index.ts`、`packages/shared/src/mcp.ts`（kind 与 knowledgeServerSchema）。P1 视为“补齐”而非重写：以本契约为准校对字段，不覆盖在途文件；特别是 `schema.ts` 里 `/** ... */export` 的注释拼接错误必须修复合行，`shared/src/mcp.ts` 的读联合改动未完成前不得继续下发 P2/P4。

## 16. 本轮状态

只新增本文件；未改 schema、未生成迁移、未安装依赖、未启动服务、未提交。P1 可直接按 §4/§5/§6.1 开工，但必须先校对工作树中已存在的在途改动（§15），以契约为准补齐而不是覆盖。
