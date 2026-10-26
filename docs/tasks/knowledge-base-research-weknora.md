# WeKnora 补充调研：是否适合本项目

> 范围：只回答「Tencent/WeKnora 值不值得作为本项目知识库后端」。基线见 [knowledge-base-research.md](knowledge-base-research.md)。
> 数据快照：**2026-10-25**。源码以 `main@e1f9a6166a593a4804a2f99f1d942919c9cc8ea7` 为准；最新 release 为 v0.8.3。补查该 tag 中也存在 Lite 配置与 MCP server 路由文件，但未逐项证明它与 main 的 API/功能完全一致，实施须锁定版本再核对。未下载、未运行仓库程序，未部署任何容器。
> 事实与推断分列：**〔事实〕** 有一手来源；**〔推断〕** 是本项目视角的判断；**〔未核实〕** 本轮未取得。

## 0. 先纠正上一报告的三处错误（本次不继承）

| 旧说法 | 实际 |
|---|---|
| 本项目是多租户平台，Dify/FastGPT 条款因此致命 | 当前是**单管理员**部署。多租户条款风险不成立，评估重心回到「多一套常驻服务值不值」 |
| `.mcp.json` 的 kind=http 不受 `assertSafeUrl` 约束 | kind=http **同样受检**：创建 `packages/api/src/features/servers/routes.ts:119`、原生导入 `:151`、测试连接 `test-connection.ts:102`、generated 每次执行 `generated.ts:162` |
| SDK 类型里有 `resources` 工具就算可用 / 独立 GPL 服务会传染调用方 | 类型存在≠运行已验证；GPL 分发与 AGPL 修改版本的网络交互义务须分别评估，都不自动要求独立 API 调用方全部开源 |

## 1. 项目与许可证

- 〔事实〕`Tencent/WeKnora`，描述为「Open-source LLM knowledge platform: turn raw documents into a queryable RAG, an autonomous reasoning agent, and a self-maintaining Wiki」。Go 后端 + React 前端 + Python docreader。2025-07-22 创建，**35,337 stars / 4,758 forks / 787 open issues**，最后 push 2026-10-24，默认分支 `main`。
  来源：`gh api repos/Tencent/WeKnora`（2026-10-25 查询）。
- 〔事实〕最新 release **v0.8.3，发布于 2026-10-14**；HEAD 提交 `e1f9a616`（2026-10-24，docreader EPUB 图片引用修复）。
  来源：`gh release list -R Tencent/WeKnora`；`gh api .../commits`。
- 〔事实〕许可证：`LICENSE` 首段写明「WeKnora is licensed under the MIT **except for the third-party components listed below**」，随后全文粘贴 MIT 条款，再列组件（如 `longbridgeapp/opencc` Apache-2.0）。主文件内**没有** GPL/AGPL/LGPL 条目（全文 grep 无命中）。GitHub API 的 `license.spdx_id` 因此返回 `NOASSERTION`，不是非自由许可。
  来源：`https://github.com/Tencent/WeKnora/blob/main/LICENSE:1-45`。
- 〔事实〕中文 README 明确「本项目基于 MIT 协议发布。你可以自由使用、修改和分发本项目代码，但需保留原始版权声明」，徽章标注 `license-MIT`。
  来源：`https://github.com/Tencent/WeKnora/blob/main/README_CN.md:14,439-441`。
- 〔事实〕仓库另有 `THIRD_PARTY_NOTICES.md`、`third_party/`、`licenses/` 三个清单，且 `docreader` 镜像自带 **LibreOffice（MPL-2.0）+ Playwright**（安装文档原文「docreader 含 LibreOffice、Playwright，较吃内存」）。
  来源：安装文档 `https://weknora.weixin.qq.com/docs/01-getting-started/02-installation`；仓库根目录清单 `gh api repos/Tencent/WeKnora/contents`。
- 〔未核实〕`THIRD_PARTY_NOTICES.md` 与 `licenses/` 的完整清单未逐条核对。`LICENSE` 只列了 Apache-2.0 与 MIT 两类，可能是节选；若决定采用，需人工核一遍是否存在 GPL 组件，以及 MPL-2.0 的 LibreOffice 是否以独立进程分发（MPL 是文件级 copyleft，通常不影响本项目代码，但这是〔推断〕）。
- 〔判断〕主项目 MIT 未显示接入障碍；第三方组件与镜像的具体义务待核对，不能由主 LICENSE 推导「唯一义务是保留版权」。

## 2. 产品定位与内容形态

- 〔事实〕三种模式共用同一批知识库：RAG 检索问答、ReAct Agent（含技能、沙盒、浏览器、MCP 工具、长期记忆）、自动 Wiki（知识图谱 + 回滚）。
  来源：README `:41-65`；`docs/images/readme/capabilities-en-light.svg` alt 文本。
- 〔事实〕内容类型：PDF / Word / PPT / Excel / CSV / TXT / Markdown / HTML / EPUB / MHTML / JSON / XMind / 图片；内置数据源 Feishu、Confluence、GitLab、Notion、Yuque、Seafile、RSS 等。
  来源：README `:61`、`:327-333`。
- 〔事实〕它自带完整前端（`frontend` + `wechatopenai/weknora-ui`）、IM 渠道、嵌入 widget、CLI、微信小程序。
  来源：`docker-compose.yml:1-35`；README `:336-365`。
- 〔判断〕它同时提供完整知识库产品和外部检索后端，两种用法并存。PACE 可只调用检索 API/MCP；上传、解析、同步、索引等后台能力仍然有价值，不能仅因不使用聊天 UI 就认定大部分功能无用。

## 3. 纯检索接口（无 LLM）

- 〔事实〕API 根地址 `/api/v1`（swagger `basePath`）。鉴权两选一：`X-API-Key`（空间 Key 绑定所属空间；平台 Key 调空间接口需同时传 `X-Tenant-ID`）或 `Authorization: Bearer <JWT>`。
  来源：`docs/swagger.json` 的 `securityDefinitions`。
- 〔事实〕**首选纯检索**：`POST /api/v1/knowledge-search`，tag 为「问答」，描述原文「在知识库中搜索（**不使用LLM总结**）。与产品内问答使用同一检索流程（召回、rerank、合并），**外部检索首选**；可覆盖召回参数与 rerank」。请求体 `SearchKnowledgeRequest`：`query`（必填）、`knowledge_base_ids`、`knowledge_ids`、`match_count`、`disable_keywords_match`、`disable_vector_match`、`keyword_threshold`、`vector_threshold`、`rerank`、`tag_ids`；query 参数 `resource_urls=handle|public` 控制文件引用是占位符还是可加载直链。
  来源：`docs/swagger.json` → `paths./knowledge-search.post`、`definitions.internal_handler_session.SearchKnowledgeRequest`。
- 〔事实〕单库路径：`POST|GET /api/v1/knowledge-bases/{id}/hybrid-search`，body `SearchParams`（`query_text`、`match_count`、`disable_keywords_match`、`disable_vector_match`、`rerank`、`knowledge_base_ids` 可跨库、`knowledge_ids` 限定文档）；返回 `HybridSearchResponse.data[]` 为 `SearchResult`，字段含 `content`、`knowledge_id`、`knowledge_title`、`knowledge_filename`、`chunk_index`、`chunk_type`、`match_type`、`image_info`、`matched_content`、`matched_images`，顶层 `meta.rerank` 给重排诊断。
  来源：同上 `paths./knowledge-bases/{id}/hybrid-search`、`definitions...SearchParams`、`...SearchResult`、`...RetrievalMeta`。
- 〔事实〕**不要误用** `GET /api/v1/knowledge/search`：参数是 `keyword`、`file_types`、`limit`，返回 `KnowledgeSearchKnowledgeResponse`，语义是「按文件名/类型找文档」，不是 chunk 语义检索。
  来源：同 swagger 中该路径的参数列表。
- 〔推断〕引用可落到 `knowledge_id + knowledge_title + chunk_index`，够本项目在工具结果里回链；图片需 `resource_urls=public` 且配置 `APP_EXTERNAL_URL` 与反代 `/r/`，否则只拿到占位符。

## 4. MCP：既是服务端也是客户端

- 〔事实〕**服务端（对外发布知识库）**：设置 → 发布集成 → MCP Server，每个空间可建多个端点，地址 `/mcp/<endpoint_id>`，Streamable HTTP，每端点独立令牌（`Authorization: Bearer mcp_…`，SHA-256 存库、可轮换）、知识库范围、每分钟限流（默认 60）、工具组白名单（列表与调用双重校验）。代码在 `internal/mcpserver/`、`internal/middleware/mcp_endpoint_auth.go`、`internal/handler/mcp_endpoint.go`，协议库 `github.com/mark3labs/mcp-go` 无状态模式。
  来源：`https://weknora.weixin.qq.com/docs/03-features/08-mcp`；README `:184`。
- 〔事实〕四个工具组，**默认只开只读组**：检索与阅读（`list_knowledge_bases`、`search_knowledge`、`grep_chunks`、`list_documents`、`read_document`）、问答（`ask`，会跑端点默认 Agent，客户端不能自选 Agent）、Wiki、写入（默认关闭）。
  来源：同 MCP 文档「端点暴露的工具按四组勾选」段。
- 〔事实〕`search_knowledge` 支持 `mode=hybrid|semantic|keyword`、`limit` 默认 10 上限 30；`grep_chunks` 是「关键词索取出候选 → 正则逐条校验」，最多 30 条候选，**不保证穷尽**；要穷尽某篇文档用 `read_document` 的 `query` 顺序扫描。
  来源：同 MCP 文档「grep_chunks 的召回有上限」段。
- 〔事实〕`ask` 的 `references[].images` 保留图片 URL / caption / OCR 文本，正文引用同样带图片链接。
  来源：同文档「现有 MCP 工具的返回结果会复用 REST/IM 的资源链接转换」段。
- 〔事实〕**客户端（接入外部 MCP）**：工具箱 → MCP 服务，支持 SSE / Streamable HTTP，**stdio 因安全禁用**；认证支持无 / Header / API Key / OAuth 2.0（DCR + PKCE）；工具级启停与人工审批。
  来源：同文档「WeKnora 作为 MCP 客户端」段。
- 〔事实〕仓库内 `mcp-server/`（Python）已弃用，compose 里挂在 `full` profile；官方建议用内置端点。
  来源：README `:184,341`；`docker-compose.yml:1051-1076`。
- 〔推断〕**能只搜索不生成答案**：只勾「检索与阅读」组，不勾 `ask`，端点就不含 LLM 问答路径。检索工具实现直接复用 Agent 原生工具 `internal/agent/tools/`，鉴权把端点换算成受限 API Key 作用域，因此「检索」这一路不经过 Agent loop。

## 5. 是否带自有 agent loop，能绕开吗

- 〔事实〕带。产品有独立 Agent 引擎（ReAct），工具在 `internal/agent/tools/`，支持技能沙盒、浏览器、MCP、长期记忆；`ask` 工具即走这套。
  来源：README `:56,314`；MCP 文档「工具实现直接复用 Agent 的原生工具（internal/agent/tools/）」。
- 〔推断〕**能绕开**：本项目只调用 `/knowledge-search` 或只开只读工具组，就完全不触发它的 Agent、沙盒、IM、浏览器。代价是它这些能力仍随镜像存在（体积与攻击面），只是不被调用。

## 6. 最小部署与依赖

- 〔事实〕compose 默认（无 profile）起 **5 个常驻服务**：`frontend`（nginx + SPA，`${FRONTEND_PORT:-80}:80`）、`app`（Go，`${APP_PORT:-8080}:8080`）、`docreader`（gRPC 50051，仅内网 expose）、`postgres`（`paradedb/paradedb:v0.25.11-pg17`）、`redis`（`redis:7.0-alpine`，强制 `--requirepass`）。
  来源：`docker-compose.yml:1-35,36-46,420-436,574-606`；安装文档「核心服务（默认启动）」表。
- 〔事实〕**可选**（profile）：`minio` 对象存储、`neo4j` 图谱、`langfuse` 追踪、`sandbox`/`mcp` 在 `full`、以及 qdrant / milvus / weaviate / doris / opensearch 等替代向量库。
  来源：`docker-compose.yml` 各服务 `profiles:`；README `:118-134`。
- 〔事实〕默认 `STORAGE_TYPE=local`（`/data/files` 卷），**对象存储不是必须**；默认 `RETRIEVE_DRIVER=postgres`，即 **Postgres 必须带 pgvector + ParadeDB `pg_search`**。
  来源：`docker-compose.yml:100-108`、`:161-172`；`.env.example:191,273-276`；README `:327`。
- 〔事实〕`docreader` 是 app 的硬依赖（`DOCREADER_ADDR` 默认 `docreader:50051`，`DOCREADER_TRANSPORT=grpc`），负责 PDF/Office/OCR 解析，内部含 LibreOffice、Playwright、可选 RapidOCR 预处理；有 `odl-hybrid`（Docling）`full` profile。
  来源：`docker-compose.yml:80-81,420-470`；`.env.example:410-460`。
- 〔事实〕标准版安装文档建议 **4 核 / 8GB 内存起步**（不含 Ollama 权重）。`docs/LITE.md` 确认 Lite 为单应用、零外部数据库/消息队列依赖，默认 Simple 解析、单空间、无共享空间。主会话补查 `.env.lite.example`，确认 `DB_DRIVER=sqlite`、`RETRIEVE_DRIVER=sqlite`（注释 FTS5 + sqlite-vec）、`STORAGE_TYPE=local`、`STREAM_MANAGER_TYPE=memory`。`routes_mcp_endpoint.go` 无显式 Lite 排除分支，但依赖注入是否提供完整服务及 Lite 下 MCP/API 能否完整调用仍需运行验证。
  补充来源：https://github.com/Tencent/WeKnora/blob/main/.env.lite.example 、https://github.com/Tencent/WeKnora/blob/main/internal/router/routes_mcp_endpoint.go
  来源：安装文档「硬件与依赖要求」；`docs/LITE.md`；`.env.lite.example:17,21,24`。
- 〔推断〕以当前 PACE 普通 PG18 镜像为起点，不能只加 schema/db 就复用 WeKnora 默认 postgres 检索驱动，须先装 pg_search 与 vector 并验证版本。官方 Compose 固定 ParadeDB PG17 并不等于应用硬性只支持 PG17；可另起实例避免改 PACE 主库，PG18 适配本轮未验证。Lite 则不依赖 Postgres。
- 〔推断〕Redis 可尝试共用（`REDIS_DB`/`WEKNORA_REDIS_NAMESPACE` 可隔离），但会与本项目 BullMQ 抢同一实例，属「为省一个容器引入排障面」，不建议。

## 7. 中文与模型

- 〔事实〕界面语言中/英/日/韩/俄；`WEKNORA_LANGUAGE` 控制文档处理语言（问题/摘要生成），默认 `zh-CN`，可按 `Accept-Language`。
  来源：README `:333`；`.env.example:71`；`docker-compose.yml:71-73`。
- 〔事实〕Embedding 后端：Ollama / BGE / GTE / Zhipu / OpenAI 兼容 API；LLM 29 家内置厂商；重排支持 TEI / Pinecone / Cohere / 火山 / 腾讯 LKEAP；v0.8.3 加多模态 embedding（WeMM、Qwen3-VL-Embedding）。
  来源：README `:63,327-329`；`:172`。
- 〔事实〕OCR：`docreader` 的 RapidOCR 预处理（知识库级开关，默认关）、PaddleOCR-VL 解析器、`odl-hybrid`（Docling）。
  来源：`.env.example:420-429`；README `:213`；`docker-compose.yml:557-573`。
- 〔推断〕中文能力「有支持」不等于「质量达标」：分词/关键词索引由 ParadeDB pg_search 提供，中文效果、grep 召回率、rerank 对中文长尾的收益都必须实测。**不能用 i18n 存在替代实测**。
- 〔未核实〕不配 embedding 模型时，纯关键词入库/检索能否完整跑通（`disable_vector_match` 只覆盖查询侧）。

## 8. 接入本项目的实际代价

1. **SSRF 硬墙（最大代价）**。WeKnora 若跑在 compose 内网（`weknora-app:8080`），在 `.mcp.json` 登记为 kind=http 会被 `assertSafeUrl` 拒绝：创建 `routes.ts:119`、批量导入 `routes.ts:151`、测试连接 `test-connection.ts:102`、generated 每次执行 `generated.ts:162` 都查；只有 `NODE_ENV=development` 且 host 是 localhost 时放行（`ssrf.ts:98-100,123`），生产 `NODE_ENV=production`（compose）一律拒私网（`ssrf.ts:135-137`）。
   → 内网部署需验证显式可信服务准入，不能靠改 `kind` 绕过策略；也不能仅为通过 URL 校验就把服务暴露公网。若通过平台服务适配，还需定义调用凭证与作用域。以上均为待设计项，本轮不更改安全策略。
2. **密钥与鉴权**。`.mcp.json` 路径下凭据是注册时存库、每次 run 注入 headers（`packages/worker/src/index.ts:99-113`）；WeKnora 端点令牌可轮换，轮换后必须同步更新 server 记录，否则全员检索静默失败〔推断〕。
3. **导出可移植性**。标准版知识本体在 WeKnora 数据库与文件卷。已找到 Markdown 导出能力，但原始文件、图片、编辑历史、Wiki 关联能否完整还原未验证。作为 D-9 已允许的外部检索服务，不要求把服务本身的数据结构改成 `.claude/`；PACE 应用官方 `.mcp.json` 表达连接、技能文件表达使用方式，另验证语料的导出和备份。
4. **常驻组件**。标准 Compose 默认有 app、frontend、docreader、ParadeDB、Redis 五个服务；API 专用部署能否省掉 frontend 未验证，Lite 则另有零外部依赖形态。默认端口 80/8080 与 PACE 的 3000 并不直接冲突，仍需核对宿主占用。升级需读迁移说明。
5. **运维面**。升级需核对与所用检索路径有关的破坏性变更、迁移和索引重建。issue 数量本身不能证明稳定性差；本轮未运行长期负载测试。

## 9. 与 RAGFlow / AnythingLLM 的对比

| 维度 | WeKnora | RAGFlow | AnythingLLM |
|---|---|---|---|
| 许可 | MIT（附第三方清单）〔事实〕 | Apache-2.0〔沿用上轮，本轮未复核〕 | MIT〔沿用上轮，本轮未复核〕 |
| 语言/栈 | Go + Python docreader + React | Python + ES/MinIO/Redis/MySQL | Node + 多向量库 |
| 部署形态 | Lite 单应用、零外部服务；标准默认 5 容器（app/ui/docreader/ParadeDB/redis）；Lite MCP/API 覆盖待验收 | 官方标准部署较重〔上轮，本轮未复核〕 | 上轮有单容器路线，本轮未复核 |
| 纯检索 REST | `POST /api/v1/knowledge-search`（明确「不使用 LLM 总结」）〔事实〕 | 有 retrieval API〔未核实精确路径〕 | 以 workspace API 为主，检索粒度较粗〔推断〕 |
| MCP 服务端 | 内置，Streamable HTTP，端点级令牌+工具组〔事实〕 | 有 MCP〔上轮，本轮未复核〕 | 上轮仅确认客户端；本轮未复核 |
| 中文 | 有中文处理链，质量未实测 | 本轮未作同样本比较 | 本轮未作同样本比较 |
| 对本项目的契合 | 有纯检索 API 与只读 MCP，可避免第二 Agent loop | 本轮未复核其具体接入代价 | 本轮未比较检索与引用质量 |

〔判断〕WeKnora 的纯检索 API 和只读 MCP 很契合 PACE 的执行边界，应列入短名单。与 RAGFlow/AnythingLLM 的真实质量、资源对比尚未实测，不作「唯一最适合」排名；完整产品的上传、解析、索引和管理功能也有实际价值。

## 10. 推荐结论

**条件推荐，列入知识库后端短名单；暂不部署。**

- 若以少量 Markdown 和技能参考资料为主，先复用现有文件机制，采用完整知识库是否划算需看真实需求，不能假设用户只有几十份文档。
- 若需要 PDF/Office/OCR、多源同步、统一上传管理、引用与混合检索，WeKnora 值得优先验证。只开放检索/阅读、不开放 `ask`，PACE 保留 Claude Agent SDK 作为唯一产品推理循环。
- 标准版可独立部署；现有 PG18 未安装其所需扩展，不是简单新建 schema 即可复用。Lite 零外部依赖模式也应验证，尤其是检索/MCP覆盖和解析限制。
- 采用前验证：生产内网的可信接入策略、实际召回与引用、备份导出、资源占用和第三方许可。外部检索本身符合 D-9，无需仅因引入 WeKnora 就推翻 D-9；若引入其 Agent 执行底座则与当前规则冲突。

## 11. 未来可执行验证清单（本轮未执行）

1. `docker compose up -d` 后 `docker stats --no-stream` + `docker compose ps`，记录 5 容器的常驻内存/CPU，对照官方 4C/8GB。
2. 用 20 份中英混合 Markdown/PDF 建库，`curl -X POST :8080/api/v1/knowledge-search -H 'X-API-Key: …' -d '{"query":"…","knowledge_base_ids":["…"],"match_count":10}'`，逐条核对 `content / knowledge_title / chunk_index` 是否足以回链；同时比对 `hybrid / semantic / keyword` 三档召回。
3. 中文质量：同一批 query 下对比 keyword 命中、语义命中、grep_chunks 漏召回（文档已说明候选上限 30 不保证穷尽），不要只看 UI 语言。
4. 只开「检索与阅读」工具组建 MCP 端点，用 `mcp-remote` 或无状态 HTTP 客户端调 `search_knowledge`，确认不触发 LLM、无 `ask` 工具。
5. 关掉 embedding 模型，验证纯关键词入库+检索是否可用（当前〔未核实〕）。
6. `SELECT * FROM pg_extension;` 确认 `vector` 与 `pg_search` 版本；判断能否在自建 PG 上复现，或必须用 ParadeDB 镜像。
7. SSRF：在本项目 `.mcp.json` 登记 `http://<内网名>:8080/mcp/...`，确认返回 400 `INVALID_URL`，再评估三个选项的真实改动量。
8. 导出：用知识库导出 Markdown，检查 frontmatter/目录结构能否直接渲染成技能 references。
9. 许可复核：逐条读 `THIRD_PARTY_NOTICES.md`、`third_party/`、`licenses/`，确认无 GPL 组件；记录 docreader 内 LibreOffice（MPL-2.0）的分发形态。

## 12. 未核实项

- `THIRD_PARTY_NOTICES.md` / `licenses/` 完整清单；docreader 镜像内 LibreOffice、Playwright、RapidOCR 的实际许可与分发边界。
- 无 embedding 模型时纯关键词链路的完整性。
- `knowledge-search` 返回体的完整字段（swagger 只写 `additionalProperties: true`，需实跑取真实 JSON）。
- WeKnora MCP 端点能否被本项目现有 MCP 客户端（无状态 HTTP）稳定连接、超时与限流对 agent 工具调用的影响。
- 与 RAGFlow / AnythingLLM 的许可证、硬件、MCP 形态本轮**未重新核对**，沿用上轮结论。

## 主要一手来源

- 仓库元数据：`gh api repos/Tencent/WeKnora`（2026-10-25）
- `https://github.com/Tencent/WeKnora/blob/main/LICENSE`
- `https://github.com/Tencent/WeKnora/blob/main/README.md`（`:41-65, 95-165, 179-192, 322-341`）
- `https://github.com/Tencent/WeKnora/blob/main/README_CN.md:439-441`
- `https://github.com/Tencent/WeKnora/blob/main/docker-compose.yml`
- `https://github.com/Tencent/WeKnora/blob/main/.env.example`
- `https://github.com/Tencent/WeKnora/blob/main/docs/LITE.md`
- `https://github.com/Tencent/WeKnora/blob/main/docs/swagger.json`（`securityDefinitions`、`/knowledge-search`、`/knowledge-bases/{id}/hybrid-search`）
- `https://weknora.weixin.qq.com/docs/03-features/08-mcp`
- `https://weknora.weixin.qq.com/docs/01-getting-started/02-installation`
- 本项目侧：`packages/api/src/features/servers/ssrf.ts:98-138`、`routes.ts:117-151`、`test-connection.ts:102`、`generated.ts:162`、`packages/worker/src/index.ts:99-113`

改动范围：仅新增本文件；未改其他文件，未运行构建或测试。
