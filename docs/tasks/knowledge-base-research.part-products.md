# 开源知识库 / RAG 产品选型调研（可整体部署、可嵌入）

> 早期研究记录，含已纠正的推断：PACE 当前单管理员；GPL/AGPL 不自动要求独立 API 调用方全部开源。中文 UI 不证明检索质量。采用判断以 [补充汇总](knowledge-base-research-addendum.md) 为准，不能按下文多租户假设直接淘汰候选。

- 核对日期：2026-10-25
- 核对方式：GitHub REST API（`gh api` 读仓库元数据、releases、LICENSE 原文）+ 官方文档页 WebFetch。所有 star / 时间 / 许可证结论附 URL；未能核实的写「未核实」。
- 判定基准：本项目是 Claude Agent SDK 智能体平台，知识库只需要作为一个**检索后端**被 Agent 调用，不需要它的 UI，也不能被它的许可证传染或被它替换前端。

---

## 结论摘要

按「可嵌入性」从高到低排序：

1. **RAGFlow — 首选（若接受 16GB 资源下限）。** 纯 Apache-2.0（LICENSE 全文 201 行，无附加条款），原生自带 MCP server（`POST /api/v1/mcp`），也有纯检索 HTTP API（`POST /api/v1/retrieval`，明确「retrieves chunks」不生成答案），中文文档与 DeepDoc 中文解析是它的主场。代价是 Elasticsearch + MySQL/Postgres + MinIO + Redis 多容器，官方建议 4C/16GB/50GB。
2. **Onyx — 次选（若接受 OpenSearch 与 EE 边界）。** 核心 MIT，`ee` 目录走 Onyx Enterprise License（生产需按席位订阅）。检索 API（`POST /api/search`，明确不生成 LLM 答案）和 MCP server（`search_indexed_documents` 等三个工具）都在 MIT 区，正好是「只取检索结果」的形态。代价：强依赖 OpenSearch + Postgres + Redis + 对象存储，Standard 最低 4C/10GB/32GB；权限同步、SSO、RBAC、多租户、白标都在 EE。
3. **Open WebUI — 轻量可选（UI 是负担）。** LICENSE 是 BSD-3 变体 + 第 4 条品牌条款：删除/修改 "Open WebUI" 品牌在 >50 名最终用户时构成实质性违约。代码许可本身宽松，但它是完整聊天前端产品，做检索后端要绕过 UI，且没有 MCP server。
4. **AnythingLLM — 轻量可选（MIT 最干净）。** 纯 MIT，单容器 + SQLite + LanceDB 默认，自带 `POST /api/v1/workspace/:slug/vector-search` 纯检索接口。短板是只有 MCP 客户端、没有 MCP server，中文/复杂版式解析与混合检索能力弱于前两者。
5. **MaxKB — 中文生态可选（GPL-3.0 需评估分发场景）。** GPL-3.0 全文，单容器内置 PostgreSQL+pgvector，中文产品化最完整。作为独立服务内部使用不触发 GPL 分发义务，但随产品分发镜像则需开源；MCP 面向「应用」而非通用检索工具。
6. **Dify — 谨慎（许可证附加条款）。** 修改版 Apache-2.0，明确禁止未经书面授权「用 Dify 源码运营多租户环境」，并要求保留前端 LOGO。前端条款对纯后端使用不适用，但多租户条款对本平台（本身就是多租户智能体平台）是实质风险。检索 API `POST /datasets/{dataset_id}/retrieve` 形态合适。
7. **FastGPT — 谨慎（中文生态，许可同 Dify 风格）。** 修改版 Apache-2.0，同样限制多租户 SaaS 与 LOGO 移除；MongoDB + PG/Milvus + MinIO + Redis，比 Dify 更重。
8. **Khoj — 淘汰（AGPL-3.0）。** AGPL 对网络服务触发源码开放义务，嵌入商业平台风险不可接受；且 2.0 长期处于 beta。

---

## 对比表

| 项目 | 许可证 | 最近发布 | 部署重量 | 检索能力 | 外部 API / MCP | 中文 | 嵌入代价 | 结论 |
|---|---|---|---|---|---|---|---|---|
| **RAGFlow** | Apache-2.0（无附加） | v1.0.0-rc2（2026-10-16）；v0.27.3（2026-10-23） | 重：4C/16GB/50GB；ES/Infinity + MySQL/PG + MinIO + Redis | DeepDoc OCR/版面/表格，模板化 chunk，多路召回+融合重排，rerank 可配 | `POST /api/v1/retrieval`；MCP `POST /api/v1/mcp`（`ragflow_retrieval` 等 3 工具）；Python SDK | 强（zh 文档、zh locale、DeepDoc 中文） | 多容器常驻 + 独立 API Key 体系；UI 不用即可 | **首选** |
| **Onyx** | MIT（`ee` 目录另许可见下） | v5.0.0（2026-10-24） | 重：Standard 4C/10GB/32GB+2.5x 数据；OpenSearch + PG + Redis + S3 | 混合索引 + 查询改写 + 重排（检索管线内置），61 个 OSS 连接器 | `POST /api/search`（不生成答案）；MCP server（3 工具，`MCP_SERVER_ENABLED`） | 中（multilingual-e5、zh.json；英文优先） | 多容器常驻；RBAC/权限同步/多租户在 EE | **次选** |
| **Open WebUI** | BSD-3 变体 + 品牌条款（>50 用户不可改品牌） | v0.12.4（2026-10-25） | 中：单容器（SQLite）+ 可选 PG/pgvector | 9 种向量库，BM25+向量混合 + cross-encoder rerank，Tika/Docling/PaddleOCR | `POST /api/v1/retrieval/query/collection`；无 MCP server（有 mcpo 反向工具） | 中（zh-CN locale、PaddleOCR-vl） | 完整聊天前端产品，UI 重复且品牌条款约束 | 可选（轻） |
| **AnythingLLM** | MIT | v1.18.0（2026-10-13） | 轻：单容器 + SQLite + LanceDB，无外部 DB | 向量检索为主；OCR loader、多格式 collector；混合检索能力弱 | `POST /api/v1/workspace/:slug/vector-search`；**仅 MCP 客户端** | 中（zh locale、中文文档） | 单容器，账号体系独立但不强绑 | 可选（轻） |
| **MaxKB** | GPL-3.0 | v2.10.8-lts（2026-10-22） | 轻：单容器内置 PostgreSQL+pgvector | embedding/keywords/blend 三种检索模式，命中测试 API | knowledge `hit_test` REST；`/mcp` 面向应用 | 强（中文原生、中文文档生态） | GPL 传染（仅分发时）；MCP 粒度偏应用 | 可选（中文） |
| **Dify** | 修改版 Apache-2.0（禁多租户、禁改前端 LOGO） | 1.18.0（2026-10-23） | 中：≥2C/≥4GiB；PG + Redis + plugin_daemon；向量库可选 pgvector | Hybrid（全文+向量）+ 可选 rerank 模型，TopK/阈值可调；29 个向量库 provider | `POST /datasets/{id}/retrieve`（dataset API key）；可作为应用发布为 MCP server（默认关） | 强（zh_Hans 原生） | 多租户条款 + 多容器 + 独立账号体系 | 谨慎 |
| **FastGPT** | 修改版 Apache-2.0（禁多租户 SaaS、禁改 LOGO） | v4.17.2（2026-10-09） | 重：PgVector 2C4G 起（生产 4C8G+），MongoDB + PG/Milvus + MinIO + Redis | 混合检索 + 重排，QA 拆分导入，中文文档友好 | OpenAPI；双向 MCP；`searchTest` API（内部鉴权） | 强（中文原生） | 组件最多；许可条款同 Dify 风格 | 谨慎 |
| **Khoj** | AGPL-3.0 | 2.0.0-beta.28（2026-03-26） | 中：Postgres+pgvector、可选 searxng/沙盒 | 双塔向量 + cross-encoder 重排 | `GET /api/search`；**无 MCP server**（只有客户端） | 弱（无 i18n） | AGPL 网络使用触发开源义务 | **淘汰** |
| **Kotaemon** | Apache-2.0 | v0.12.0（2026-05-31） | 轻：本地文件 + LanceDB/Chroma，无外部 DB | 混合检索（全文+向量）+ rerank，多模态解析，GraphRAG 示例 | **无 REST API**（Gradio UI）；仅 MCP 客户端 | 弱（无 i18n） | 只能整体嵌 Gradio UI 或当库 import | **淘汰** |
| **Quivr** | MIT | v2.0.0-alpha.7（2026-10-14） | 重：PG17 + S3 + Weaviate + Temporal | 词法/语义/混合检索，canonical 回源重授权 | REST v0 + OpenAPI 3.1 | 未核实 | V2 自述「不要上生产」，仓库已迁 The-Vibe-Company | **淘汰** |
| **Verba** | BSD-3-Clause | v2.1.3（2025-07-14） | 中：Weaviate + 前后端 | 金标准 RAG 演示级 | 未核实 | 未核实 | 仓库已归档停止维护 | **淘汰** |

---

## 逐项笔记

### Onyx（原 Danswer）

- 许可证：根 LICENSE 明确「`ee` 目录下内容走 Onyx Enterprise License，其余 MIT Expat」。三个 ee 目录：`backend/ee/LICENSE`、`web/src/app/ee/LICENSE`、`web/src/ee/LICENSE`。EE 许可要求「生产环境使用需已同意 Onyx Subscription Terms 并按席位持有有效许可」，禁止再分发/再许可。<https://github.com/onyx-dot-app/onyx/blob/main/LICENSE>，<https://github.com/onyx-dot-app/onyx/blob/main/backend/ee/LICENSE>
- EE 内容实测：`backend/ee/onyx/external_permissions/`（24 项，含 google_drive/slack/jira/confluence/sharepoint 等 ACL 同步）、`backend/ee/onyx/server/{billing,license,analytics,enterprise_settings}`。OSS 区仍有 61 个连接器目录与 `backend/onyx/access/`（基础访问控制）。
- 活动度：stars 32,959，最后 push 2026-10-24T23:15Z，最新 release v5.0.0（2026-10-24）。<https://github.com/onyx-dot-app/onyx/releases>
- 部署：Standard 最低 4 vCPU / 10 GB / 32 GB + ~2.5x 索引数据；Lite 2 vCPU / 2 GB / 10 GB，但「Onyx Lite does not include indexing」「does not use the vector database or background workers」。<https://docs.onyx.app/deployment/getting_started/resourcing>，<https://docs.onyx.app/deployment/overview>
- 后端硬依赖：compose 生产文件含 `opensearch`、`relational_db`（Postgres）、`cache`（Redis）、`minio`/`object-store`、`inference_model_server`、`indexing_model_server`、`background`、`mcp_server`。向量索引只有 OpenSearch 实现（`backend/onyx/document_index/opensearch/`），不支持仅 Postgres。<https://github.com/onyx-dot-app/onyx/blob/main/deployment/docker_compose/docker-compose.prod.yml>
- 对外接口：`POST /api/search` 返回 `results[]`（citation_id/title/content/link/source_type/updated_at），文档明确「no LLM answer generated」，权限 `read:search` 在 basic 内。<https://docs.onyx.app/developers/api_reference/search/search>
- MCP：`backend/onyx/mcp_server/`，工具 `search_indexed_documents`、`search_web`、`open_urls`；开关 `MCP_SERVER_ENABLED`（默认 false）。<https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/mcp_server/tools/search.py>
- Anthropic：README 声明支持 Anthropic/OpenAI/Gemini 等；可选 embedding 含 `intfloat/multilingual-e5-base|small`。<https://github.com/onyx-dot-app/onyx/blob/main/backend/onyx/configs/embedding_configs.py>

### RAGFlow

- 许可证：LICENSE 为标准 Apache-2.0 全文（201 行），无附加条款；`internal/admin/license_ee.go` 同样是 Apache-2.0 头。<https://github.com/infiniflow/ragflow/blob/main/LICENSE>
- 活动度：stars 92,826，最后 push 2026-10-25T05:55Z；v1.0.0-rc2（2026-10-16），同时维护 v0.27.3（2026-10-23）。<https://github.com/infiniflow/ragflow/releases>
- 部署：官方建议 4C/16GB/50GB；默认 compose profile = `elasticsearch`，文档引擎可切 `infinity`/`opensearch`/`oceanbase`/`seekdb`/`gaussdb`/`vastbase`，元数据库可切 `postgres`（默认 mysql）；另有 MinIO、Kvrocks/Redis、NATS、TEI embedding 服务。<https://github.com/infiniflow/ragflow/blob/main/README.md>，<https://github.com/infiniflow/ragflow/blob/main/docker/.env>
- 解析：DeepDoc 做版面分析、OCR、表格识别（1.0 开源版为 CPU 推理）；支持 Word/PPT/Excel/PDF/扫描件/图片/网页/结构化数据；模板化 chunking，多路召回 + 融合重排序，LLM/Embedding/Reranker 均可在「模型提供商」页替换。<https://github.com/infiniflow/ragflow/blob/main/README_zh.md>
- 对外接口：`POST /api/v1/retrieval`（question/dataset_ids/document_ids/similarity_threshold/vector_similarity_weight/rerank_id/keyword/highlight/metadata_condition/use_kg…），另有 dataset/document/chunk 全套 CRUD 与 Python SDK。<https://github.com/infiniflow/ragflow/blob/main/docs/references/http_api_reference.md>
- MCP：内置。`POST /api/v1/mcp`（9380 端口，Streamable HTTP，每请求自带 `Authorization`），可选独立 listener `:9382/mcp`（`host` / `self-host` 模式）；工具 `ragflow_retrieval`、`ragflow_list_datasets`、`ragflow_list_chats`。<https://ragflow.io/docs/v1.0.0-rc2/use_ragflow_as_mcp_server>，<https://ragflow.io/docs/mcp_tools>
- Anthropic：`conf/models/anthropic.json` 内置 Anthropic 工厂（`https://api.anthropic.com`，`v1/messages`）。
- 不适合场景：想要单容器 / 只跑 Postgres / 2GB 内存的部署。

### Dify（知识库 / RAG 模块）

- 许可证：修改版 Apache-2.0。附加条款：① 未经书面授权不得「用 Dify 源码运营多租户环境」（一个 tenant = 一个 workspace）；② 使用其前端时不得移除 LOGO/版权，但「该限制不适用于不涉及前端的用法」；另注明外观设计专利。<https://github.com/langgenius/dify/blob/main/LICENSE>
- 活动度：stars 159,468，最后 push 2026-10-25T08:18Z，release 1.18.0（2026-10-23）。
- 部署：官方最低 ≥2 Core / ≥4 GiB；compose 含 `api`、`api_websocket`、`worker`、`worker_beat`、`web`、`db_postgres`（或 mysql）、`redis`、`sandbox`、`plugin_daemon`、`knowledge_fs*` worker 若干、`agent_backend`、`ssrf_proxy`、`nginx`。<https://docs.dify.ai/en/self-host/quick-start/docker-compose>，<https://github.com/langgenius/dify/blob/main/docker/docker-compose.yaml>
- 向量库：`VECTOR_STORE` 可切（默认 weaviate），`api/providers/vdb` 下有 29 个实现，含 pgvector/pgvecto-rs/qdrant/milvus/chroma/opensearch/elasticsearch/oracle/opengauss/tidb-vector → 可用仅 Postgres 存向量（Redis 仍需）。<https://github.com/langgenius/dify/tree/main/api/providers/vdb>
- 检索能力：Hybrid Search（全文+向量同时执行，可配权重或 rerank 模型），TopK 默认 3、score threshold 默认 0.5（仅在 rerank 阶段生效）。<https://docs.dify.ai/en/cloud/use-dify/knowledge/create-knowledge/setting-indexing-methods>
- 对外接口：`POST /datasets/{dataset_id}/retrieve`，用 dataset API key（非 app key）。源码路由 `api/controllers/service_api/dataset/hit_testing.py`。<https://docs.dify.ai/en/api-reference/knowledge-bases/retrieve-chunks-from-a-knowledge-base-test-retrieval>
- MCP：可把**应用**发布为 MCP server（Access Point → MCP Server 卡片，默认关闭，生成唯一 URL）；另有把 MCP 工具接入 Dify workflow 的反向能力。<https://docs.dify.ai/en/guides/application-publishing/publish-mcp>
- Anthropic：官方插件 `langgenius/dify-official-plugins/models/anthropic`（独立插件仓 Apache-2.0）。<https://github.com/langgenius/dify-official-plugins/tree/main/models/anthropic>
- 风险：本项目自身是多租户平台，「用 Dify 源码运营多租户环境」正需要商业许可；不能只看 Apache-2.0。

### AnythingLLM

- 许可证：MIT 全文（Copyright Mintplex Labs Inc.）；`TERMS_SELF_HOSTED.md` 只是数据/隐私说明，明确「core 以 MIT 提供」，含可选匿名遥测（可关）。<https://github.com/Mintplex-Labs/anything-llm/blob/master/LICENSE>，<https://github.com/Mintplex-Labs/anything-llm/blob/master/TERMS_SELF_HOSTED.md>
- 活动度：stars 67,526，最后 push 2026-10-24T01:34Z，release v1.18.0（2026-10-13）。
- 部署：单容器 `mintplexlabs/anythingllm`（`--cap-add SYS_ADMIN`，挂 `/app/server/storage`）；Prisma 默认 SQLite（`file:../storage/anythingllm.db`），可切 Postgres；向量库默认 LanceDB，可切 pgvector/chroma/qdrant/milvus/weaviate/pinecone/astra/zilliz。<https://github.com/Mintplex-Labs/anything-llm/blob/master/docker/docker-compose.yml>，<https://github.com/Mintplex-Labs/anything-llm/blob/master/server/prisma/schema.prisma>
- 解析：collector 支持 PDF/TXT/DOCX 等多格式，含 `collector/utils/OCRLoader`；embedding 引擎 14 种（openai/azure/gemini/cohere/ollama/lmstudio/localai/voyage/mistral/liteLLM…）可替换。
- 对外接口：Swagger 在实例 `/api/docs`；纯检索 `POST /api/v1/workspace/:slug/vector-search`（body: query/topN/scoreThreshold，返回 text+metadata+distance+score）。<https://github.com/Mintplex-Labs/anything-llm/blob/master/server/endpoints/api/workspace/index.js>
- MCP：**只有客户端**（「MCP Servers can be added to AnythingLLM」），不对外暴露 MCP server。<https://docs.anythingllm.com/mcp-compatibility/overview>
- Anthropic：README 列出 Anthropic 为受支持 LLM 提供商。
- 短板：混合检索/重排能力明显弱于 Onyx/RAGFlow；中文效果未实测。

### Open WebUI

- 许可证：BSD-3 变体 + 第 4 条品牌条款——禁止在任何部署/分发中改动、移除、遮蔽 "Open WebUI" 品牌（名称、logo、视觉/文本标识），例外只有：① 任何滚动 30 天内最终用户 ≤50 人；② 版权方书面许可；③ 已签企业许可。违反即构成实质性违约。LICENSE_HISTORY 记录：2025-04-18 起为品牌条款，2025-01-10 前为 MIT。<https://github.com/open-webui/open-webui/blob/main/LICENSE>，<https://github.com/open-webui/open-webui/blob/main/LICENSE_HISTORY>
- 活动度：stars 156,677，最后 push 2026-10-25T08:07Z，release v0.12.4（2026-10-25）。
- 部署：单容器；DB 可选 SQLite（可加密）或 Postgres；向量库默认 `pgvector`（slim 镜像）或 `chroma`，共 9 种（ChromaDB/PGVector/Qdrant/Milvus/Elasticsearch/OpenSearch/Pinecone/S3Vector/Oracle 23ai）；文件可本地或 S3/GCS/Azure Blob。<https://github.com/open-webui/open-webui/blob/main/README.md>
- 检索：本地 RAG，BM25 + 向量混合 + cross-encoder rerank + full-context 模式；内容抽取引擎含 Tika/Docling/Document Intelligence/Mistral OCR/PaddleOCR-vl；默认 embedding `sentence-transformers/all-MiniLM-L6-v2`（可换）。<https://docs.openwebui.com/features/workspace/knowledge>，<https://github.com/open-webui/open-webui/blob/main/backend/open_webui/config.py>
- 对外接口：`POST /api/v1/retrieval/query/collection`（`collection_names` + `query`，支持 hybrid/k/k_reranker/r/hybrid_bm25_weight），鉴权走用户 API Key（`auth.enable_api_keys`），并支持 `auth.api_key.endpoint_restrictions` 限定允许的路径前缀。<https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/retrieval.py>，<https://github.com/open-webui/open-webui/blob/main/backend/open_webui/utils/auth.py>
- MCP：没有 MCP server；只有 MCP 客户端（`backend/open_webui/utils/mcp/client.py`），官方另提供 `open-webui/mcpo`（把 MCP 转 OpenAPI，MIT）做反方向。<https://github.com/open-webui/mcpo>
- 嵌入代价：它是完整聊天产品（channels/calendar/notes/agents…），拿它做检索后端等于只用一个角落，且品牌条款直接限制「长得像自己产品」。

### Khoj

- 许可证：GNU AGPL-3.0 全文，无附加条款。AGPL 对通过网络提供服务触发源码可得义务，嵌入闭源商业平台风险高。<https://github.com/khoj-ai/khoj/blob/master/LICENSE>
- 活动度：stars 37,813，最后 push 2026-08-02T01:55Z；最新 release 2.0.0-beta.28（2026-03-26）——距核对日约 7 个月，长期 beta。
- 部署：compose 含 `server`、`database`（pgvector/pg15）、`sandbox`（terrarium）、`search`（searxng）、可选 `computer`；端口 42110。<https://github.com/khoj-ai/khoj/blob/master/docker-compose.yml>
- 检索：`GET /api/search?q=&n=&t=&r=&max_distance=&dedupe=`（双塔向量 + 可选 cross-encoder 重排），源码在 `src/khoj/routers/api.py`。<https://github.com/khoj-ai/khoj/blob/master/src/khoj/routers/api.py>
- MCP：仓库内只有 MCP **客户端**（`src/khoj/processor/tools/mcp.py` + `McpServer` 表），未发现对外 MCP server 端点 → 「是否可作为 MCP server」未获一手确认（代码层面未找到）。
- 中文：无 i18n 目录，未核实中文效果。
- 不适合理由：AGPL + 长期 beta + 个人知识管理定位（文档/笔记/图片），不是企业知识库形态。

### Kotaemon

- 许可证：Apache-2.0（LICENSE.txt 全文）。<https://github.com/Cinnamon/kotaemon/blob/main/LICENSE.txt>
- 活动度：stars 25,829，最后 push 2026-07-14，最后提交 2026-05-30，release v0.12.0（2026-05-31）→ 约 5 个月无新提交。
- 部署：单容器/本地；数据在 `ktem_app_data`（本地文件），向量库 LanceDB 或 Chroma（可切 Milvus），无需外部 DB。<https://github.com/Cinnamon/kotaemon/blob/main/flowsettings.py>
- 检索：混合（全文+向量）+ rerank，多模态文档解析，引用带 PDF 高亮，GraphRAG 示例 pipeline；有 `kotaemon` Python 库可供 import。
- 对外接口：**没有 REST API**，UI 是 Gradio（`app.py` 里 `demo.launch(...)`）；有 MCP 客户端（`libs/kotaemon/kotaemon/agents/tools/mcp.py`、`libs/ktem/ktem/mcp/`），无 MCP server。<https://github.com/Cinnamon/kotaemon/blob/main/app.py>
- 中文：无 i18n 文件，未核实。
- 不适合理由：只能「整体嵌 Gradio UI」或「当 Python 库自己写服务」，两条路都违背「不重造平台侧实现」。

### Quivr

- 许可证：MIT（Copyright 2026 The Vibe Company）。<https://github.com/QuivrHQ/quivr/blob/main/LICENSE>
- 仓库状态：`QuivrHQ/quivr` 已重定向到 `The-Vibe-Company/quivr`（非归档、非 fork），stars 39,600，最后 push 2026-10-21；最新 release v2.0.0-alpha.7（2026-10-14）。V1 已中止（tag `v1-final`，最后 core release `core-0.0.33` 2025-02-04）。
- 关键结论：README 自述「**Status: evaluation stage.** The API is `v0` and may change without notice. **Do not run it in production yet.**」；`docs/quivr-v2-remaining-limits.md` 同样声明「Nothing here … certifies production readiness」。
- 部署极重：PG17 + S3 兼容存储（本地 SeaweedFS）+ Temporal + Weaviate + TEI embedding，单二进制跑 api/worker/migrate。<https://github.com/QuivrHQ/quivr/blob/main/README.md>
- 定位变化：V2 已从「个人知识库」转为「持续内容流 → 搜索与监控」引擎（Corpus/Record/Version 模型），REST v0 + OpenAPI 3.1。
- 结论：不是「停止维护」（仍在高频开发，近 30 天 100+ 提交），但**不可用于生产**，且 alpha 之间不支持就地升级（alpha.7 明确需重置或导出再导入）。

### Verba（Weaviate）

- 许可证：BSD-3-Clause（Copyright Weaviate B.V.）。<https://github.com/weaviate/Verba/blob/main/LICENSE>
- 状态：**已归档**（`archived: true`），README 顶部「⚠️ Project Discontinued — Repository Archived … no further updates, bug fixes, security patches」；最后 push 2026-06-08，最后 release v2.1.3（2025-07-14）。
- 结论：直接淘汰，不再评估。

### FastGPT（中文生态）

- 许可证：修改版 Apache-2.0，附加条款与 Dify 同构：未经书面授权不得「用 FastGPT.AI 源码运营类似 FastGPT 的多租户 SaaS 服务」；不得移除控制台 LOGO/版权；并注明外观设计专利。<https://github.com/labring/FastGPT/blob/main/LICENSE>
- 活动度：stars 29,906，最后 push 2026-10-24T10:54Z，release v4.17.2（2026-10-09）。
- 部署：MongoDB（非向量数据）+ PostgreSQL/PgVector 或 Milvus/Oceanbase/SeekDB（向量）+ MinIO + Redis + sandbox；官方容量表：PgVector 版测试环境最低 2C4G、100w 组向量 4C8G/50GB、500w 组 8C32G/200GB。<https://doc.fastgpt.io/self-host/deploy/docker>
- 检索：知识库支持 TXT/MD/HTML/PDF/Docx/PPTX/CSV/XLSX、URL 读取、CSV 批量导入，混合检索 + 重排，chunk 可编辑删除，QA 拆分导入。
- 对外接口：OpenAPI 文档 `https://cloud.fastgpt.io/apidoc/systemopenapi`；双向 MCP（README 勾选）；内部 `api/core/dataset/searchTest.ts`（走平台鉴权与额度计费，不是通用开放检索端点）。<https://github.com/labring/FastGPT/blob/main/README.md>
- 结论：能力强、中文好，但组件最多 + 许可限制多租户 SaaS，对本平台是双重负担。

### MaxKB（中文生态）

- 许可证：GNU GPL-3.0 全文（README 明确 "Licensed under The GNU General Public License version 3 (GPLv3)"）。GPL 只在**分发**时触发；作为独立服务内部调用不触发，但若随产品镜像/交付物分发则须开源。<https://github.com/1Panel-dev/MaxKB/blob/v2/LICENSE>
- 活动度：stars 23,032，最后 push 2026-10-23，release v2.10.8-lts（2026-10-22）、v2.10.7-lts（2026-10-15）——有 LTS 分支节奏。
- 部署：`docker run ... 1panel/maxkb` 单容器，内置 PostgreSQL + pgvector（技术栈：Vue + Django + LangChain + PG/pgvector）。<https://github.com/1Panel-dev/MaxKB/blob/v2/README.md>
- 检索：三种模式 `embedding | keywords | blend`（source: `apps/knowledge/serializers/knowledge.py` 正则 `^embedding|keywords|blend$`），命中测试 API `POST .../workspace/{workspace_id}/knowledge/{knowledge_id}/hit_test`（TokenAuth）。<https://github.com/1Panel-dev/MaxKB/blob/v2/apps/knowledge/urls.py>，<https://github.com/1Panel-dev/MaxKB/blob/v2/apps/knowledge/views/knowledge.py>
- MCP：有 `/mcp` 视图（JSON-RPC: initialize / tools/list / tools/call），但它属于**应用（chat）侧**的 MCP 工具集，不是「把知识库当检索后端」的通用接口。<https://github.com/1Panel-dev/MaxKB/blob/v2/apps/chat/views/mcp.py>
- Anthropic：`apps/models_provider/impl/anthropic_model_provider` 存在。
- 资源下限：官方文档未给出明确数值（多个 docs.fit2cloud.com 页面 404）→ **未核实**。

---

## 明确淘汰项及原因

| 项目 | 淘汰理由 |
|---|---|
| **Verba** | 仓库已归档，README 明示不再有更新/修复/安全补丁；发布停于 2025-07。<https://github.com/weaviate/Verba> |
| **Khoj** | AGPL-3.0，网络服务即触发源码开放义务；2.0 长期 beta（最后 release 2026-03-26）；无对外 MCP server、无 i18n。 |
| **Kotaemon** | 无 REST API，只有 Gradio UI 和 Python 库；约 5 个月无提交；无中文 i18n。要接入必须自己写服务层，违背「不重造平台侧实现」。 |
| **Quivr** | 自述 "evaluation stage … Do not run it in production yet"；依赖 PG+S3+Temporal+Weaviate+TEI；alpha 之间不支持就地升级；定位已偏离知识库。 |
| **Dify（不推荐直接嵌）** | 许可证禁止未经授权用其源码运营多租户环境，而本平台就是多租户智能体平台；需商业许可才能安全嵌入。 |
| **FastGPT** | 同 Dify 的多租户 SaaS + LOGO 限制；且 MongoDB+PG/Milvus+MinIO+Redis 五件套，嵌入代价最高。 |
| **Open WebUI（不作为检索后端）** | 品牌条款：>50 用户时移除/修改品牌构成实质性违约；产品形态是完整聊天前端，与平台 UI 重复。 |

---

## 未确认项

1. **各产品中文检索/问答实测效果**：全部未做实测（无 benchmark），本文件只记录「是否有中文 i18n、中文解析组件、中文文档」，不代表实际召回质量。
2. **Onyx EE 的精确功能边界**：根 LICENSE 与 `backend/ee/LICENSE` 已核实，EE 目录内容已实测列出，但「哪些功能因 dynamic import 而在无 EE 许可时降级」未逐项验证；第三方资料称 EE 覆盖 SSO/SCIM/审计日志/白标/多租户，未在官方文档页核实（`docs.onyx.app/enterprise/*` 返回 404）。
3. **Onyx 是否仍需 Vespa**：当前 `backend/onyx/document_index/` 只有 `opensearch` 实现，但仓库仍有 `backend/ee/onyx/background/celery/tasks/vespa/` 与多个 vespa 相关迁移 → 是否已完全迁移到 OpenSearch **未核实**。
4. **AnythingLLM / Open WebUI / Khoj / Kotaemon / Quivr / MaxKB 的官方最低内存数值**：仅 Onyx、RAGFlow、Dify、FastGPT 有官方数字。其余为第三方站点数字或未找到，故不写入表格。
5. **RAGFlow 的连接器清单**：只核实了 README 中的文档类型与「网站 sitemap 摄取」「Google BigQuery 数据源」等条目，未逐个数连接器数量。
6. **Khoj 能否作为 MCP server**：仓库内只找到 MCP 客户端与 `McpServer` 数据表，未找到 server 端路由；第三方文章声称可作 MCP server，未获一手来源确认。
7. **MaxKB 系统 API 的完整检索端点**：v2 的 `hit_test` 路径已从源码核实，但「系统 API / API Key 调用对话」的完整 swagger 与鉴权细节未取到官方页面（docs.fit2cloud.com 多页 404）。
8. **Kotaemon / Khoj / Quivr 的混合检索与 rerank 具体实现质量**：只核实了「存在」，未做对比测试。
