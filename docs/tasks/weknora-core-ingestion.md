# WeKnora 核心入库链路盘点（只读）

> 只读源码分析，2026-10-25。源码固定 commit `e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`；下文 `path:line` 均相对该源码根。固定链接前缀：`https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/`。未执行仓库内任何脚本。不含性能断言，界面中文不作为质量证据。

## 结论（复刻 PACE 时的最小正确形态）

- **必需的一条主链**：上传/网页/手写 → 原件落存储 + `knowledges` 行（pending）→ 异步任务 → 解析（DocReader）→ 切块 → 图片/多模态子块 → 向量+关键词索引 → 后处理（摘要/问题/标签/图谱）→ 逐阶段状态可查 → 可取消/重试/重建 → 删除时按"知识→chunk→索引→原件/派生资源"顺序清理。
- **WeKnora 把它拆成 5 个固定阶段**：`docreader / chunking / embedding / multimodal / postprocess`（`internal/types/knowledge_span.go:42-51`），每阶段独立子任务与 span 行，前端据此渲染时间线（`frontend/src/components/knowledge-processing-timeline.vue:4-40`）。PACE 若只做一条 status 字段会丢失"卡在哪一段"的用户可见信息。
- **优先评估复用解析组件，而非把 Go 业务层逐行翻译成 TS**。入库编排可复用 PACE BullMQ；具体表数、队列数与解析服务选型待总方案裁决，不能由当前盘点直接断言只需六张表两条队列。
- **源码观察，非经验证缺陷**：单 chunk 的 `DeleteChunk` 使用软删，而检索结果 hydrate 会过滤失效内容（见 §6）。不能只因物理索引未立即清除就断言已发生旧内容泄漏；PACE 应验收删除/编辑后的实际可检索行为。

## 1. 知识库与知识类型

| 概念 | 取值 / 字段 | 证据 |
|---|---|---|
| KB 类型 | `document` / `faq` / `wiki` | `internal/types/knowledgebase.go:32-36` |
| 知识类型 | 文件、URL、`manual`（Markdown 手写）、FAQ；由 `type`+`file_type`+`source` 表达 | `internal/types/knowledge.go:15-17,167-250` |
| 入库渠道 | `channel`：web/api/feishu/notion/wechat/rss… 仅用于来源标记 | `internal/types/knowledge.go:22-40` |
| 文件夹 | **派生自路径**，无 folder 表：`knowledges.folder_path` 规范化（深度≤16、段≤128、去 `..`） | `internal/types/knowledge_folder.go:10-20,29-70`；`internal/types/knowledge.go:213`；列表 `internal/handler/knowledge.go:1551-1595`；移动 `:1603-1680` |
| 标签 | 独立表 `knowledge_tags`（KB 内唯一），多对多关联 knowledge/FAQ chunk | `internal/types/tag.go:12-31`；删除触发异步索引清理 `internal/application/service/tag.go:440-470` |
| 手写知识 | 正文存 `metadata.manual.{content,format,status,version}`，草稿不发索引 | `internal/types/knowledge.go:319-330`；`internal/application/service/knowledge_create.go:742-830`（上限 200000 字符，`knowledge.go:90`） |

## 2. 上传 / 网页 / 手写入口

| 入口 | 路由 | 行为要点 | 证据 |
|---|---|---|---|
| 文件 | `POST /knowledge-bases/:id/knowledge/file` | multipart；先按 `MAX_FILE_SIZE_MB`（默认 50）在解析 body 前设限；`fileName` 支持文件夹相对路径；`tag_ids`、`process_config`、`enable_multimodel` 同传；坏 JSON 在 HTTP 边界直接 400 | `internal/router/routes_knowledge.go:70-78`；`internal/handler/knowledge.go:313-490` |
| URL | `POST .../knowledge/url` | 网页转 Markdown；URL 带文件扩展或指定 `file_name/file_type` 时切换为文件下载；SSRF 校验在入队与 worker 内**各做一次** | `internal/handler/knowledge.go:493-580`（校验 `:526`）；`internal/application/service/knowledge_process.go:4289` |
| 手写 | `POST .../knowledge/manual`、`PUT /knowledge/manual/:id` | draft/publish 两态，publish 才入队 | `routes_knowledge.go:75`；`handler/knowledge.go:583-642` |
| 文件夹批量 | 前端 `webkitdirectory` 上传 + `POST /knowledge/folder` 归类 | 上传时用相对路径，移动只改归类不重解析 | `frontend/src/views/knowledge/components/KbUploadSourceDropdown.vue:7-17`；`handler/knowledge.go:1582-1595` |

支持扩展名是**单一白名单**（上传、URL 下载、数据源共用）：pdf/txt/docx/doc/epub/odt/rtf/html/htm/mhtml/md/xlsx/csv/pptx/pptx/json/xmind/图片/音频 等（`internal/utils/import_filetypes.go:9-23`）。视频明确拒绝（`knowledge_process.go:3877-3884`）。

## 3. 解析器 / OCR / 表格 / 图片策略

- **DocReader 是独立 Python gRPC 服务**：`Read`、`ReadStream`、`ListEngines`、`PreprocessImage`（`docreader/proto/docreader.proto:8-23`），Go 侧通过 `DOCREADER_ADDR` 调用，另有 anydoc（Rust/MIT，进程内）、MinerU、PaddleOCR-VL（本地/云）等引擎（`internal/infrastructure/docparser/engines.go`、`engine_registry.go`）。
- **引擎路由**：每个文件类型可选引擎（`chunking_config.parser_engine_rules`），ppt/pptx 缺省走 markitdown（`internal/types/knowledgebase.go:282-315`）；前端上传确认弹窗逐项显示 parser/切块/多模态（`frontend/src/views/knowledge/components/UploadConfirmDialog.vue:194-200,354-362`）。
- **表格**：PDF 走版面重排 + markdown 化（`docreader/parser/pdf_parser.py:854-1004`）；xlsx/csv 另有 Excel 解析与表格摘要任务（`docreader/parser/excel_parser.py`，`internal/application/service/extract.go:643-700`）。
- **图片**：docreader 只抽取/落位图片，**不做 OCR 描述**（`docreader/parser/pdf_parser.py:8-16,87-99`）；OCR/VLM 在 Go 侧多模态队列完成，产出 `image_ocr`/`image_caption`/`image_vector` 子 chunk（`internal/types/chunk.go:12-30`；`knowledge_process.go:399+`）。图片是否入库由 KB `image_processing_config` / VLM 配置控制。
- **切块**：KB 级 `chunk_size/chunk_overlap/separators/strategy(auto|heading|heuristic|recursive|legacy)/token_limit/languages`，可选父子块（父块仅上下文、不建向量）（`internal/types/knowledgebase.go:275-306`；chunker 实现 `internal/infrastructure/chunker/strategy.go`）。chunk 带 `context_header`（标题面包屑），编辑后重建索引时复用（`internal/types/chunk.go:194-196`）。
- 解析结果可带 `source_locators`（页/区域/幻灯片/表格行），用于引用回跳原件（`internal/types/chunk.go:197-200`）。

## 4. chunk 可编辑

- `PUT /chunks/:knowledge_id/:id` 支持改正文/启停；`expected_revision` 不符返回 409（`internal/handler/chunk.go:223-273`；`routes_knowledge.go:44`）。
- 语义：仅 `text` 类型可编辑；保存前把旧内容写入 `chunk_revisions`（不可变快照），`content_revision` 自增；`source_content` 保留解析原值；编辑后同步 `syncChunkIndex`（删旧向量 + 重嵌正文与生成问题）；`index_status=processing|failed` 的 chunk 在检索结果 hydrate 阶段被排除，避免"改完还能搜到旧内容"（`internal/application/service/chunk.go:494-640,763-820`；`internal/types/chunk.go:145-154,203-214`；`internal/application/service/knowledgebase_search_results.go:372-390`）。
- 父子块编辑会重建父块内容（`chunk.go:698-760`）；支持历史列表与回滚（`routes_knowledge.go:38,45`）。

## 5. 索引、模型配置、异步状态与重建

| 主题 | 事实 | 证据 |
|---|---|---|
| 状态机 | `pending → processing → finalizing（摘要/问题/图谱未完成）→ completed`；另有 `failed/deleting/cancelled` | `internal/types/knowledge.go:44-72` |
| 阶段 | 5 阶段 DAG，失败级联把下游标 `cancelled`；span 表存 pending/running/done/failed/skipped/cancelled 与耗时 | `internal/types/knowledge_span.go:36-90`；`GET /knowledge/:id/stages|spans` `routes_knowledge.go:124-125` |
| 队列 | asynq；文档处理队列 maxRetry=3；后处理拆 summary/question/multimodal/graph 独立队列；删除/批量重解析/迁移走 maintenance 队列 | `internal/application/service/knowledge_task_options.go:11-25`；`internal/types/task.go:28-95,236-251` |
| 失败 | 每次重试失败不回写 failed（仅最后一次）；重试预算耗尽的 dead-letter 回调把 knowledge 标 failed，解决"永远 processing" | `internal/application/service/knowledge_process.go:3711-3715,3800-3820`；`internal/middleware/asynqdl` |
| 重试/重建 | `POST /knowledge/:id/reparse`：清理旧 chunk/索引/派生资源 → 停掉在途任务 → 新 attempt → 重新入队；attempt 号防止旧任务写回新结果 | `routes_knowledge.go:130`；`knowledge_process.go:2853-2960` |
| 取消 | `POST /knowledge/:id/cancel-parse` 保留已写入 chunk，可再 reparse | `internal/types/knowledge.go:67-71`；`internal/application/service/knowledge_process.go:3199-3300` |
| 状态可观测 | 列表返回 `last_activity_at` 与 `stall_state(queued|stalled)`，区分"排队慢"和"没人跑" | `internal/types/knowledge.go:242-252` |
| 模型 | `embedding_model_id`（建库后不可换）、`summary_model_id`、`VLMConfig`、`ASRConfig` 存在 KB 行；模型行有 type/parameters/is_default；模型 CRUD 在 `/models` | `internal/types/knowledgebase.go:79-95`；`internal/types/model.go:214-244`；`internal/router/routes_infra.go:21-47` |
| 索引后端 | 可换：pgvector、sqlite-vec（Lite）、Milvus、Qdrant 等，统一 `IndexInfo{Content,SourceID,ChunkID,KnowledgeID,…}` + `DeleteByChunkIDList/DeleteByKnowledgeIDList` | `internal/types/retriever.go:16`；`internal/types/interfaces/retriever.go:33-34,137-138` |

## 6. 删除与"不留下旧检索内容"

- 删除是**异步**：handler 只返回 `task_id`，worker 内先标 `deleting`，再依次删向量（按 KB 分组的 `DeleteByKnowledgeIDList`）、chunk、图谱、标签关联、知识行、原件、抽取图片（引用计数后删）（`internal/handler/knowledge.go:1807-1855`；`internal/application/service/knowledge_delete.go:466-643`）。
- 软删 + 可恢复：chunk 删除用 `deleted_at`，只有被新解析同位置 chunk 取代时才物理清理（`internal/application/repository/chunk.go:648-690`）。
- **源码观察，尚未复现缺陷**：单 chunk / 整篇 chunk 的 `DeleteChunk` 路径使用软删，本段读取未见调用 `DeleteByChunkIDList`（`internal/application/service/chunk.go:362-445`）。检索命中后回 DB hydrate，`isSearchableChunk` 丢弃禁用/软删/索引未就绪内容（`knowledgebase_search_results.go:372-390`）。这可能是有意分离的物理清理与逻辑可见性，不据此断言已产生泄漏或必须重写。
- **PACE 的设计建议**：原件、人工编辑正文及版本需明确保存来源；全文/向量索引为可重建派生数据。验收覆盖修改、禁用、删除和重解析后不再返回旧内容。若全文/向量同在 Postgres，可优先用事务和现有关联条件完成一致更新；不要在尚未选定后端前强制引入跨存储 revision 协议、回表二次校验或周期清扫。任务重试与删除失败应显式可恢复，具体机制由实现契约决定。

## 7. 存储与 Lite 差异

- 标准版：KB 可绑定存储后端（local/minio/s3/cos/oss/tos/obs/ks3），`file_path` 带 `storage://<backendID>/…` 前缀；元数据在 PG，文件在对象存储/本地卷（`internal/types/knowledgebase.go:92-99`；`types/knowledgebase.go:12-25`；`internal/application/service/file/factory.go:30`）。
- Lite：单进程、SQLite、无 Redis（队列用 goroutine 版 `SyncTaskExecutor`）、sqlite-vec、默认仅 Simple 解析引擎、无共享空间/多租户（`internal/router/sync_task.go:19-60`；`internal/container/container.go:961`；`docs/LITE.md:7-16`）。
- 对 PACE 的含义：优先复用已有 Postgres、Redis 和 BullMQ，不为模仿 Lite 另引 SQLite 和进程内队列。FAQ、Wiki、图谱列入完整能力范围并明确阶段，不能仅因单管理员就自动删去。

## 8. 与 PACE 现状的差距（只读核对）

| 能力 | PACE 现状 | 证据 |
|---|---|---|
| 知识库/文档/chunk 表 | 无；schema 只有 agents/skills/runs/eval/auth 等 | `packages/db/src/schema.ts:17-588` |
| 向量/全文 | 无 pgvector、无 tsvector，Postgres 18-alpine | `docker-compose.yml:8-24`；`packages/db/migrations/`（0000–0032 无 `CREATE EXTENSION`） |
| 二进制上传 | 仅 `application/zip`（专家包，bodyLimit 1 MiB），无 multipart 文件上传 | `packages/api/src/features/import/routes.ts:19-23` |
| 长任务队列 | BullMQ `agent-runs`/`eval-runs` 两条；无文档流水线 | `packages/shared/src/chat.ts:163-166`；`packages/api/src/queue/producer.ts:118-126` |
| 对象存储 | 无；工作区在沙盒里只读挂载 | `packages/api/src/features/agents/memory-files.ts:13-18` |

## 9. 可直接复用的开源件与许可证（第一轮，只核现有依赖）

| 组件 | 用途 | 许可证 | 判断 |
|---|---|---|---|
| WeKnora 自身 | 业务编排参考 | MIT（`LICENSE`） | 参考实现，可翻译/改写 |
| docreader（Python） | PDF/DOCX/PPTX/XLSX/MD/HTML 解析、切分 | 同仓库 MIT；依赖：markitdown(MIT)、pypdf(BSD)、pypdfium2(Apache-2.0/BSD)、python-docx(MIT)、openpyxl(MIT)、beautifulsoup4(MIT)、trafilatura(Apache-2.0)、playwright(Apache-2.0)、opendataloader-pdf(Apache-2.0) | **最值得直接复用的件**：作为独立服务（HTTP/gRPC/CLI）运行，不要翻译成 TS |
| rapidocr + onnxruntime + opencv-headless | 图片预处理/OCR | rapidocr Apache-2.0；onnxruntime MIT；opencv Apache-2.0（`licenses/`） | 可作本地 OCR 方案；替代品是外部 VLM/OCR 服务 |
| anydoc-go | 进程内多格式→Markdown | MIT（`third_party/anydoc-go/LICENSE`） | Go 专用；PACE 用不上，除非换成 anydoc CLI |
| MinerU / PaddleOCR-VL | 高精度版面解析 | 通过 HTTP 接入（非本仓库代码） | 可选云服务，不引入二进制 |

**是否把 Go 私有代码翻译成 TS**：不值得。入库核心的难点在解析保真（64 KB PDF 版面代码、docx 表格、公式）与字节处理，不在语言；WeKnora 的 Go 业务层又深度耦合计费/多租户/FAQ/Wiki。建议 PACE 用现成解析服务 + 自己写编排；Go 侧只借鉴状态机、阶段 DAG、attempt/revision 失效与删除顺序。

## 10. 真相 / 派生数据划分（PACE 落地清单）

| 数据 | 归属 | 失效方式 |
|---|---|---|
| 原件字节（PDF/DOCX/…） | **真相**：对象存储/磁盘，元数据行记 hash+size | 仅删除文档时删；reparse 不移除 |
| 手写正文 | **真相**：`manual.content`（版本化） | 编辑递增 version 并重入队 |
| `chunks.content` + `chunk_revisions` | **真相**（用户可编辑的派生正文） | 每次编辑/回滚递增 revision |
| `chunks.source_content`、`source_locators` | 解析快照，供回滚与回跳 | reparse 时整体替换 |
| 向量/全文索引行 | **派生** | 以 `chunk_id + revision` 为键；查询命中必须回 PG 校验 |
| 摘要/生成问题/图片 OCR·caption/图谱/自动标签 | **派生** | 挂在 knowledge attempt 下，新 attempt 或删除即作废 |
| 文件夹树 | **派生**（路径前缀） | 无独立状态，随文档行变化 |

## 11. 相对原方案的增量与待确认

1. FAQ/Wiki/图谱均列入范围确认。建议基础闭环先完成，随后依赖它扩展；不在未获用户选择前永久排除。
2. 解析服务形态需确认：复用 docreader、采用通用解析服务（如 Docling），或云解析。docreader 保真效果与独立服务契约尚未实测，不能宣称它最优；完整 PDF/Office/OCR 支持不等于仅文本演示。
3. 手写/网页导入是低成本高价值项（不依赖对象存储以外的解析），可作为第一阶段验收面。
4. 多模态（图片 OCR/VLM）必须与 VLM 模型配置一起上线，否则会出现"WeKnora 能搜图、PACE 不能"的可见落差（图 chunk 类型见 `types/chunk.go:12-30`）。
