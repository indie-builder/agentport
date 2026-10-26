# 知识库：只拼装开源组件的可行路径

> 早期研究记录，部分接入推断已纠正：generated 回调平台自身受生产 SSRF 限制，`requireAuth` 浏览器路由不能自动接受沙盒凭证；中文检索可在应用侧分词等，不能认定「必须数据库扩展」。百万/千万 chunk 阈值不是本项目实测容量。最新选择见 [补充汇总](knowledge-base-research-addendum.md)，不将本报告自建管线当成既定方案。

> 核对日期：2026-10-25。所有版本 / 许可证 / 行为结论均来自当日一手来源（GitHub API、官方文档、npm / PyPI registry、Docker Hub、Alpine / PostgreSQL 官方文档），链接随条目给出。无法核实的写「未核实」。
>
> 目标平台：TypeScript monorepo（Fastify + Postgres 18 / Drizzle 0.45.4 + Redis / BullMQ + Claude Agent SDK），已有 OpenAI-compatible 模型网关抽象；知识库最终形态要求是「文件 + 可被智能体调用的检索工具」。
>
> 本文只做调研，不改产品代码。

---

## 结论摘要

1. **最小可行拼装 = Postgres + pgvector + 一个 Fastify 检索路由 + 平台已有的 generated MCP server。** 不需要新增容器、不需要新增运行时、不需要第二套定义格式。pgvector 0.8.7（2026-10-01）已提供 HNSW / IVFFlat / halfvec / binary quantization，官方明确支持与 Postgres 全文检索组合做 hybrid（RRF 或 cross-encoder 融合）。
2. **「零新服务」第一版成立，但需要改一处文件边界策略，而不是真的零改动。** 平台目前 `packages/sandbox/src/runner.ts` 把 `Bash` / `Glob` / `Grep` 全部列入 disallowed，`Read` 只放行 `/mnt/agent-memory/` 与 `.claude/skills/*/references/`；`/workspace` 以 `:ro` 挂载。所以「工作区文件 + 官方文件工具当第一版检索」在当前策略下不成立 —— 要么放宽 hook 让某个只读知识目录可 Grep/Read，要么走 MCP 工具。两者都不新增进程。
3. **中文全文检索在 Postgres 里必须装扩展，原生 `simple` parser 不可用。** PostgreSQL 官方文档写明只有 `pg_catalog.default` 一个内置 parser，且不按语义分词；中文整句会成为一个 token，`to_tsvector('simple','我爱编程')` 只有一条 lexeme，搜「编程」零命中。可行顺序：**pgroonga**（PG 12–18、PostgreSQL License、官方 `groonga/pgroonga` Docker、TokenBigram + NFC 归一化）> **zhparser**（SCWS 分词、PostgreSQL License，但官方 Docker 只到 PG 16）> **pg_bigm**（2-gram、PostgreSQL License，但只支持 `LIKE`、无 ranking）。pg_jieba / VectorChord 系列维护与许可证都有坑，见 B 层笔记。
4. **什么时候必须上 Python：只在「PDF / Office 高质量结构化」时。** 纯 Node 能覆盖文本型 PDF（pdfjs-dist）、docx（mammoth）、xlsx（SheetJS）、HTML（readability + turndown）；表格还原、扫描件 OCR、公式、PPT 版面必须交给 Python 服务。首选 **docling-serve**（MIT，独立 HTTP 服务，`POST /v1/convert/source`，官方 CPU / CUDA 镜像）或 **docling-mcp**（MIT，MCP 形态，可直接被 Agent SDK 加载）；**MinerU** 效果强但许可证带附加条款（超 1 亿 MAU / 月收入 2000 万美元需商业授权）；**Marker** 代码 Apache-2.0 但模型权重是限制性 OpenRAIL-M。
5. **什么时候必须上独立向量库：单租户、百万级 chunk、几十 QPS 以内不需要。** pgvector 的已知短板是「带过滤的近似检索」——过滤在索引扫描之后发生，默认 `hnsw.ef_search=40` 时 10% 选择率可能只返回约 4 条；0.8.0 起有 `hnsw.iterative_scan` 缓解。需要原生 BM25 + 稀疏 + 稠密 + 多向量融合、或独立扩缩容时再上 **Qdrant**（Apache-2.0，1.20.0，Query API `prefetch` + RRF，1.20.0 起支持 BM25 负载索引）。Chroma 的 JS SDK 是纯 HTTP 客户端（必须起服务端）、Typesense 是 GPL-3.0、Milvus 运维成本最高 —— 三者都不适合作为「只做检索后端」的第一选择。
6. **Embedding 阶段一直接用网关上的 API 模型 + 可选自托管 TEI。** 自托管 **text-embeddings-inference**（Apache-2.0，1.9.4）同时暴露 `/v1/embeddings`（OpenAI 兼容）与 `/rerank`，有 CPU 镜像，最适合挂在现有网关后面；**Infinity** 也支持 bge-m3 与 rerank，但 v3 换成了 Restricted MIT。中文 / 多语模型：**bge-m3**（MIT，1024 维，8192 上下文，稠密+稀疏+多向量，最稳妥）、**Qwen3-Embedding-0.6B**（Apache-2.0，1024 维，32K 上下文，有配套 0.6B/4B/8B reranker）。**jina-embeddings-v3 权重是 CC BY-NC 4.0，不能直接商用**，是这一层最容易踩的许可证坑。
7. **Rerank 第一阶段不做。** 先做「向量 + 关键词 + RRF」，需要提升时再加 cross-encoder（bge-reranker-v2-m3，Apache-2.0，0.6B，官方卡片明确推荐中英文）。理由：RRF 无需调分、无额外服务；rerank 会引入第二次模型调用与延迟，且当前阶段没有可量化的收益证据。
8. **评估层先不引入 Python。** promptfoo（npm 0.125.1，MIT，TypeScript）已内置 `context-faithfulness` / `context-recall` / `context-relevance` 三类 RAG 断言，可直接跑检索质量回归；RAGAS（0.4.3）与 DeepEval（4.2.4）都只有 Python 版，等评估真的复杂到需要它们再上。

---

## 分层对比表

| 层 | 候选 | 许可证 | 运行时 | 成熟度 | 代价 | 建议 |
| --- | --- | --- | --- | --- | --- | --- |
| A 存储/检索 | **pgvector 0.8.7** | PostgreSQL License | Postgres 扩展（C） | 23.5k★，2026-10-24 仍活跃 | 换镜像即可；HNSW 建索引吃 `maintenance_work_mem` | **首选** |
| A | pgroonga 4.1.0 | PostgreSQL License | Postgres 扩展（C + Groonga） | 757★，2026-10-09 发版 | 必须换 Postgres 镜像 / 装包；PG 18 已支持 | **中文全文检索首选** |
| A | zhparser | PostgreSQL License | 扩展 + SCWS 依赖 | 872★，2026-06-29 最后推 | 官方 Docker 只到 `bookworm-16`，PG 18 需自建 | 备选（不想换 base 镜像时） |
| A | pg_bigm 1.2 | PostgreSQL License | 扩展（C） | 157★，2026-08-04 | 只有 `LIKE`，无 ts_rank；仅 GIN | 兜底 / 短词前缀匹配 |
| A | Qdrant 1.20.0 | Apache-2.0 | Rust 独立服务 | 35.2k★ | 多一个容器 + 数据双写 | 规模/融合需求出现再上 |
| A | LanceDB 0.40.0 | Apache-2.0 | 嵌入式（Rust + Node SDK） | 11.8k★ | 索引文件与 Postgres 分家，事务/权限要自己补 | 单机/离线场景可选 |
| A | Chroma 1.5.9 | Apache-2.0 | Rust 服务端 + JS 纯 HTTP 客户端 | 29.6k★ | JS 端不能嵌入，必须起服务 | 不建议 |
| A | Milvus 3.0.3 | Apache-2.0 | Go 分布式 | 46.5k★ | 组件多（etcd/对象存储），运维重 | 不建议 |
| A | Meilisearch 1.55.0 | MIT（CE）/ BSL-1.1（EE） | Rust 服务 | 59.7k★ | 中文用 jieba 分词，效果不错；但它是搜索引擎不是向量库 | 只要关键词检索时可替代 pgroonga |
| A | Typesense 30.2 | **GPL-3.0** | C++ 服务 | 27k★ | 许可证与自托管 SaaS 冲突风险 | 不建议 |
| B 解析 | **docling-serve 1.38.1** | MIT | Python HTTP 服务 | Docling 69.5k★，2026-10-25 仍活跃 | 一个 Python 容器；PDF 表格/OCR 强 | **Python 方案首选** |
| B | docling-mcp 3.3.0 | MIT | Python MCP server | 官方维护 | 只能被 Agent 调，做不了批量入库 | 智能体侧按需转换 |
| B | MinerU 4.0.12 | Apache-2.0 + 附加条款 | Python 服务 | 82.4k★ | 效果好，但需履行署名义务、超大规模型需商业授权 | 效果优先时备选 |
| B | Marker 2.0.0 | 代码 Apache-2.0 / **权重 OpenRAIL-M 限制** | Python（torch / vllm / llama.cpp） | 40.6k★ | GPU 才能跑满速（平衡模式 2.9 页/秒） | 不建议（许可证） |
| B | MarkItDown 0.1.9 | MIT | Python | 192k★ | 输出「够用不好看」；扫描件需额外 OCR 插件 | 轻量转换可选 |
| B | unstructured 0.27.34 | Apache-2.0 | Python | 15.6k★ | 高精度表格被引导去付费 API | 不建议 |
| B | Apache Tika 4.1.0 | Apache-2.0 | **Java 17** | 官方 ASF 项目 | 引入第三个运行时；4.x 默认输出 Markdown | 不建议（除非已有 JVM） |
| B | pdfjs-dist 6.4.299 | Apache-2.0 | Node | 54k★（pdf.js） | 只出文本 run，无版面/表格/OCR | **纯 Node 文本 PDF 首选** |
| B | mammoth 1.13.0 / xlsx 0.18.5 / tesseract.js 7.0.0 | BSD-2 / Apache-2.0 / Apache-2.0 | Node | 稳定 | docx→HTML、xlsx 读表、WASM OCR | 纯 Node 办公文档兜底 |
| C 切分 | **@langchain/textsplitters 1.0.2** | MIT | Node | LangChain.js 18.3k★ | 只有 Character / Recursive / Markdown / Token / Latex，无语义切分 | **首选**（够用且零新依赖风险低） |
| C | chonkie（Python 1.7.0 / npm 0.3.0） | MIT | Python 成熟；npm 版是社区移植 | Python 4.8k★；npm 最后发布 2025-06-24 | TS 版明显落后，语义/表格切分在 Python 侧 | 只在已有 Python 服务时用 |
| C | LlamaIndex IngestionPipeline | MIT | Python | — | docstore 哈希可做增量，但要整条 LlamaIndex 栈 | 只借思路，不引依赖 |
| D Embedding | **text-embeddings-inference 1.9.4** | Apache-2.0 | Rust，Docker（含 CPU 镜像） | 5.1k★ | 一个容器；`/v1/embeddings` + `/rerank` | **自托管首选** |
| D | Infinity 0.0.78 | MIT（旧）/ **Infinity Restricted MIT（v3）** | Rust + Python | 3.0k★ | 支持 bge-m3 与 rerank；v3 许可证收紧 | 备选，先读许可证 |
| D | Ollama | MIT | Go | 184.7k★ | 有 `/v1/embeddings`；**未核实 rerank** | 本地开发方便 |
| D | vLLM | Apache-2.0 | Python + GPU | 95.4k★ | 只在 GPU 场景值得 | 不建议第一阶段 |
| D | bge-m3 / Qwen3-Embedding-0.6B / bge-reranker-v2-m3 | MIT / Apache-2.0 / Apache-2.0 | 模型权重 | — | 1024 维；bge-m3 8192、Qwen3 32K 上下文 | **bge-m3 或 Qwen3-0.6B** |
| D | jina-embeddings-v3 | **CC BY-NC 4.0** | 权重 | — | 非商用限制 | **不用** |
| D | voyage-3 / voyage-3-large | 商业 API | — | — | $0.06 / $0.18 每百万 token | 只要多语效果且接受外部调用时 |
| E MCP | **@modelcontextprotocol/server-filesystem 2.0.1** | MCP 项目正从 MIT 迁 Apache-2.0 | Node（npx） | 官方 reference server | `search_files` 只做路径 glob，**没有内容搜索** | 只做「按目录挂载读文件」 |
| E | Qdrant MCP 0.8.1 | Apache-2.0 | **Python**（uvx） | 1.5k★，最后发版 2025-12 | `qdrant-find` / `qdrant-store`，embedding 只支持 fastembed | 上 Qdrant 时再用 |
| E | chroma-mcp 0.2.6 | Apache-2.0 | Python | 600★，2025-09 后无更新 | 维护停滞 | 不建议 |
| E | 平台 generated MCP server | 自有代码 | 平台内 | 已上线（`packages/api/src/features/servers/`） | 把任意外部 HTTP 工具包成 MCP tool，自带审批 | **首选检索工具形态** |
| F 评估 | **promptfoo 0.125.1** | MIT | TypeScript | 26.4k★，2026-10-25 仍推 | 三类 RAG 断言开箱可用 | **首选** |
| F | RAGAS 0.4.3 | Apache-2.0 | Python | 16.1k★ | 指标全，但必须引入 Python | 指标不够时再上 |
| F | DeepEval 4.2.4 | Apache-2.0 | Python | 19.1k★ | 同上，偏单元测试风格 | 同上 |
| F | autoevals 0.4.1 | MIT | Node | Braintrust 维护 | 有 ContextRecall / Faithfulness | promptfoo 不够时的 TS 备选 |

---

## 每层笔记

### A. 存储与检索

#### A1. pgvector（Postgres 扩展）

- **版本**：0.8.7，tag commit 时间 2026-10-01（`gh api repos/pgvector/pgvector/commits/v0.8.7`）。GitHub 上无 Release 条目，只有 tag。
- **许可证**：PostgreSQL License（`LICENSE` 原文「Permission to use, copy, modify, and distribute this software … without fee」）。
- **索引**：HNSW 与 IVFFlat 都在。HNSW 维度上限 `vector` 2000 / `halfvec` 4000 / `bit` 64000；`m` 默认 16、`ef_construction` 默认 64、`hnsw.ef_search` 默认 40。IVFFlat 需先灌数据再建索引，`lists` 取 `rows/1000`（≤1M 行）。
- **距离算子**：`<->` L2、`<=>` cosine、`<#>` 负内积、`<+>` L1、`<~>` Hamming、`<%>` Jaccard。
- **量化**：`halfvec` 每维 2 字节，索引上限 4000 维；`binary_quantize()` + `bit_hamming_ops` 可压到 64000 维，官方建议量化后对原始向量再排序。
- **过滤检索的坑（重要）**：近似索引下过滤发生在索引扫描之后，10% 选择率 + 默认 `ef_search=40` 时平均只返回约 4 条。0.8.0（2024-10-30）加入 `hnsw.iterative_scan` / `ivfflat.iterative_scan`（`strict_order` / `relaxed_order`）来缓解；按租户过滤建议 list 分区或独立表。
- **混合检索**：README「Hybrid Search」一节直接给出 `tsvector + ts_rank_cd` 与向量并列的写法，并指向 RRF / cross-encoder 两个示例脚本。RRF 在 SQL 里手写十几行即可，不需要额外库。
- **Drizzle**：`vector('embedding', { dimensions: 1536 })`、`index().using('hnsw', ...)`、`cosineDistance` 均支持（官方指南要求 drizzle-orm ≥ 0.31 / drizzle-kit ≥ 0.22；本仓 catalog 是 0.45.4，满足）。Drizzle **不会**自动 `CREATE EXTENSION vector`，迁移里要自己写。
- **本仓现状**：`docker-compose.yml` 用 `postgres:18-alpine`，未装 pgvector。Alpine 3.23 官方 `community` 仓库有 `postgresql-pgvector`，但版本是 **0.8.1-r0**（3.22 是 0.6.2-r1），落后于 0.8.7。要 0.8.7 就换镜像：`pgvector/pgvector:pg18`（基于 Debian bookworm，官方 tag 列表里没有 alpine 变体）。
- 来源：https://github.com/pgvector/pgvector 、https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md 、https://orm.drizzle.team/docs/guides/vector-similarity-search 、https://pkgs.alpinelinux.org/package/v3.23/community/aarch64/postgresql-pgvector

#### A2. 中文全文检索在 Postgres 里怎么落地

先说清楚为什么必须装扩展：Postgres 只有一个内置 parser `pg_catalog.default`，官方文档明确「At present PostgreSQL provides just one built-in parser」；它只做边界识别，不做词切分。中文没有空格，整句会被当成一个 token，`to_tsvector('simple','我爱编程')` 得到 `'我爱编程':1`，搜「编程」零命中。

| 方案 | 许可证 | 版本 / 状态 | 中文能力 | 坑 |
| --- | --- | --- | --- | --- |
| **pgroonga 4.1.0** | PostgreSQL License | 2026-10-09 发版；支持 PG 12–18 | 基于 Groonga，默认 `TokenBigram`（非 ASCII 走 bigram、ASCII 按空白切），配 `NormalizerNFKC*` 做全半角/大小写归一；同时能给 LIKE / 正则建索引 | Debian 只提供 trixie 包（bookworm 不再列）；索引体积和写入放大比 tsvector 大；bigram 召回高、精度低，短词容易误命中 |
| **zhparser** | PostgreSQL License（宽松，保留版权即可） | 872★，2026-06-29 最后推 | 基于 SCWS 分词，简体词典，可加载自定义词典 | 官方 Docker 只有 `bookworm-16` / `alpine-16`，**没有 PG 18**，需自己编；分词结果不理想时要调词典；自定义词典要 superuser 且是库级 |
| **pg_bigm 1.2** | PostgreSQL License | 157★，2026-08-04 | 2-gram，官方对比表明确「non-alphabetic language 支持」 | 只支持 `LIKE` 算子（不支持 `~` / `ILIKE`），只有 GIN；**没有 ranking**，只能当「能建索引的 LIKE」用 |
| pg_jieba | BSD-3-Clause（Pigsty 打包为 2.0.1 / 扩展 1.1.0） | 上游近年无活动，靠 Pigsty 分发（PG 14–18） | jieba + `jiebacfg` / `jiebaqry` | 上游基本停更；只应作为「已在用 Pigsty」时的选项。**上游活跃度未完全核实** |
| VectorChord-bm25 / pg_tokenizer | **AGPL-3.0 或 ELv2 双许可** | pg_tokenizer 最后推 2025-09 | 有 BM25 排序索引与 lindera / HF tokenizer | 许可证对自托管 SaaS 有实质约束；pg_tokenizer 近一年无更新 |
| ParadeDB pg_search | **AGPL-3.0** | v0.26.2，PG 15–18 | Tantivy BM25、模糊/短语/高亮，支持自定义 tokenizer | AGPL；**是否内置中文分词未核实**；需 `shared_preload_libraries` |

**建议**：如果中文检索是硬需求，直接换 `groonga/pgroonga:latest-alpine-18-slim`（官方镜像基于 `postgres:18-alpine` 同结构，可 drop-in 替换），索引用 `WITH (tokenizer='TokenBigram', normalizers='NormalizerNFKC150')`。如果不愿意换 base 镜像，就用 zhparser 自建一个 PG 18 镜像（多阶段编译 SCWS），成本约一天。pg_bigm 只适合「短词前缀 Like 查询」这种明确场景。

来源：https://www.postgresql.org/docs/current/textsearch-parsers.html 、https://pgroonga.github.io/install/ 、https://pgroonga.github.io/reference/create-index-using-pgroonga.html 、https://groonga.org/docs/reference/tokenizers/token_bigram.html 、https://github.com/amutu/zhparser 、https://github.com/pgbigm/pg_bigm/blob/master/docs/pg_bigm_en.md 、https://github.com/supervc-stack/pg_tokenizer.rs 、https://pgext.cloud/ext/pg_search 、https://doc.pigsty.io/ext/e/pg_jieba

#### A3. 替代检索后端：「只做检索后端」适配度

- **Qdrant 1.20.0（Apache-2.0）**：唯一同时具备「稠密 + 稀疏 + 原生 BM25 负载索引（1.20.0 起）+ Query API 多阶段融合（1.10 起 `prefetch` + `rrf` / `dbsf`）」的独立服务；量化号称省 97% 内存。代价是多一个容器、多一份数据、权限模型要跟 Postgres 对齐（payload filter ≠ SQL RLS）。GitHub README 明确警告默认 Docker 启动是**无鉴权且监听所有网卡**。
- **LanceDB 0.40.0（Apache-2.0）**：嵌入式、有官方 Node SDK、BM25 FTS 支持 `jieba/*` 分词（`LANCE_LANGUAGE_MODEL_HOME` 需备模型文件），适合单机 / 离线。但它把索引放在自己的 Lance 文件里，与 Postgres 的事务、备份（本仓 `scripts/backup.sh`）、多租户隔离都要各写一套。
- **Chroma 1.5.9（Apache-2.0）**：JS SDK 是纯 HTTP 客户端，必须 `chroma run` 起服务端；嵌入模式只在 Python 侧。作为「最小代价」反而是负分。且 `chroma-mcp` 2025-09 后停更。
- **Milvus 3.0.3（Apache-2.0）**：能力最全，但需要 etcd + 对象存储，运维面远超本项目「单 Postgres + Redis」的基线。
- **Meilisearch 1.55.0（MIT CE / BSL-1.1 EE）**：中文用 jieba 词典分词，支持 hybrid（内置或 REST embedder）。如果诉求只是「关键词搜索 + 一点语义」，它比 pgroonga 更开箱；但它带来第二个存储。注意 README 里 EE 部分（sharding、S3 快照）是 BSL-1.1，不是 MIT。
- **Typesense 30.2**：**GPL-3.0**，产品若以 SaaS 形式分发需谨慎，直接排除。

**结论**：已有 Postgres 时 pgvector 足够（单租户、百万级 chunk、低双位数 QPS）。触发换库的客观条件只有三条：① 需要原生 BM25 排序质量并要独立扩缩容；② 需要多向量/稀疏/ColBERT 融合；③ 向量数据量大到 HNSW 内存压不住。三者都还没出现在当前需求里。

来源：https://github.com/qdrant/qdrant 、https://qdrant.tech/documentation/concepts/hybrid-queries/ 、https://qdrant.tech/documentation/concepts/indexing/ 、https://github.com/lancedb/lancedb 、https://docs.lancedb.com/indexing/fts-index 、https://github.com/chroma-core/chroma 、https://github.com/milvus-io/milvus 、https://github.com/meilisearch/meilisearch 、https://github.com/typesense/typesense

### B. 文档解析

判断标准只有一个：**会不会引入第二个运行时**。会，就必须能作为独立 HTTP / MCP 服务被调用，而不是被 Node 进程 import。

#### B1. Python 侧（会引入第二个运行时）

- **Docling 2.142.1 / docling-serve 1.38.1（MIT）**：格式覆盖最广（PDF、DOCX、PPTX、XLSX、HTML、EPUB、LaTeX、图片、音视频），输出 Markdown / HTML / DocTags / JSON；OCR 走 EasyOCR / Tesseract / RapidOCR / Mac OCR，语言用 BCP-47 标签；表格结构有专门模型。服务形态 `POST /v1/convert/source`，官方镜像 `quay.io/docling-project/docling-serve` 有 base / cpu / cu128 / cu130 四个变体（async 任务接口未在文档页确认，**未核实**）。另有 **docling-mcp 3.3.0（MIT）**，直接以 MCP tool 形式暴露转换能力。吞吐未给官方基准（**未核实**）。
- **Marker 2.0.0**：代码 Apache-2.0，但**模型权重是修改版 OpenRAIL-M**，只有年收入 500 万美元以下的组织可免费商用。官方基准（单台 B200、并发）：平衡模式 2.9 页/秒、快速模式 7.4 页/秒、无 OCR 纯 CPU 23.7 页/秒；`marker_server` 提供 `/marker` 但只暴露少量参数，文档自己说是小规模用途。**因为权重许可证，不建议**。
- **MinerU 4.0.12**：Apache-2.0 + 附加条款（超 1 亿 MAU 或月收入 2000 万美元需商业授权；对外提供在线服务必须署名）。中文文档支持最好的一档，输出 Markdown + JSON，有 `mineru server start` 本地服务与 SDK；`basic` 约 2GB 内存、`standard`/`advanced` 约 8GB（CPU）或 8GB+ 显存（GPU）。
- **MarkItDown 0.1.9（MIT）**：覆盖广、装起来最轻（`pip install markitdown`），官方自述「为文本分析工具准备，不是高保真转换」，扫描件 OCR 需要额外 `markitdown-ocr` 插件（走 LLM Vision）。配套 `markitdown-mcp`（MIT）只暴露一个 `convert_to_markdown(uri)` 工具，且明确只应绑 localhost。
- **unstructured 0.27.34（Apache-2.0）**：开源版能抽表，但官方在推付费 Transform v2 API（宣称表格内容准确率 2×），说明高精度表格是商业分界。OCR 走 Tesseract + `tesseract-lang`。
- **Apache Tika 4.1.0（Apache-2.0）**：格式覆盖最全（上千种），4.x 默认输出 Markdown、4.0 起内建 Tesseract。代价是 **Java 17 运行时** —— 对只有 Node + Python 的项目是第三个运行时，除非已有 JVM，否则不划算。

#### B2. 纯 Node / TypeScript 能接受的部分

| 格式 | 库 | 许可证 | 能力边界 |
| --- | --- | --- | --- |
| 文本型 PDF | `pdfjs-dist` 6.4.299 | Apache-2.0 | `getDocument` + `page.getTextContent()` 拿文本 run 与坐标；**没有版面/表格重建、没有 OCR** |
| PDF（简化 API） | `pdf-parse` 2.4.5 | Apache-2.0 | 封装抽取纯文本，同样无表格/OCR |
| DOCX | `mammoth` 1.13.0 | BSD-2-Clause | 转 HTML / 纯文本，保留标题与列表；表格转 HTML table，不保证结构语义 |
| XLSX | `xlsx` 0.18.5 | Apache-2.0 | 读表转 CSV/JSON。注意 npm 上的 `xlsx` 是旧版，官方现在从 cdn.sheetjs.com 分发，**长期维护性有风险** |
| HTML | `@mozilla/readability` 0.6.0 + `turndown` 7.2.4 | Apache-2.0 / MIT | 正文抽取 + HTML→Markdown，效果可接受 |
| 图片 OCR | `tesseract.js` 7.0.0 | Apache-2.0 | WASM 版 Tesseract，中文需装 `chi_sim` 训练数据；速度与精度都不如原生 |
| PPTX | — | — | 没有可靠的纯 Node 方案（`officeparser` 8.2.0 MIT 可抽文本，但版面丢失） |

**结论**：纯 Node 能覆盖「文本型 PDF + Office 文档 + HTML」，这对本仓「以 Markdown 为知识载体」的定位已经够：入库前用脚本把 PDF/DOCX 一次性转成 Markdown，检索阶段不再碰原文件。**必须引入 Python 服务的时刻**是：扫描件 / 图片 PDF、需要表格还原、需要公式、PPT 版面。那时上 **docling-serve**（独立容器，CPU 镜像可用），并且只在入库管线（BullMQ worker）里调用，不进 API 热路径。

来源：https://github.com/docling-project/docling 、https://github.com/docling-project/docling-serve 、https://github.com/docling-project/docling-mcp 、https://github.com/datalab-to/marker 、https://github.com/opendatalab/MinerU/blob/main/LICENSE.md 、https://github.com/microsoft/markitdown 、https://github.com/microsoft/markitdown/blob/main/packages/markitdown-mcp/README.md 、https://github.com/Unstructured-IO/unstructured 、https://tika.apache.org/

### C. 切分与知识组织

- **@langchain/textsplitters 1.0.2（MIT）** 的导出就是全部：`CharacterTextSplitter`、`RecursiveCharacterTextSplitter`、`MarkdownTextSplitter`、`TokenTextSplitter`、`LatexTextSplitter`。**没有语义切分**。对 Markdown 知识库来说 `MarkdownTextSplitter` + 标题层级已足够，多出来的是依赖体积（LangChain.js 18.3k★，维护正常）。
- **chonkie**：Python 1.7.0（MIT）功能齐全（Recursive / Semantic / Sentence / Token / Late / Table / Code，且有 `recipe="markdown"` 与 `MarkdownChef`）。npm 上的 `chonkie` 0.3.0 是社区移植 `feyninc/chonkiejs`，最后发布 2025-06-24，功能明显落后。**TS 侧不建议依赖它**。
- **semantic chunking**：需要 embedding 逐句相似度断点，等于给入库管线加一轮 embedding 调用。对结构化 Markdown 没有必要 —— 标题本身就是最好的语义边界。
- **结构感知切分**：Markdown 按 `#/##` 切、表格整块不切、代码块整块不切，用 `MarkdownTextSplitter` 的 separators 配置即可，无需自造。
- **Markdown + 目录 + frontmatter 作为知识载体**：可行，且与本仓「文件系统即智能体定义」的第一性原则同构。检索策略分三档：
  1. **第 0 档（无索引）**：目录树 + `ripgrep` 内容搜索。平台内 Grep 工具就是基于 ripgrep，且**默认跳过 gitignored 文件**。优点零成本，缺点无排名、无同义词、中文按字符匹配。
  2. **第 1 档（关键词索引）**：入库时把 Markdown 切块写进 Postgres，`tsvector`（中文配 pgroonga）建 GIN。有 BM25 类排名，可按 frontmatter（`tags` / `agent` / `visibility`）过滤。
  3. **第 2 档（混合）**：chunk 向量 + tsvector 双路召回 + RRF。这才是「知识库」的形态。
  frontmatter 的价值是把「按目录挂载」变成「按标签过滤」，与沙盒挂载天然对齐。
- **成熟的「目录 → 索引」增量同步**：
  - **LlamaIndex IngestionPipeline**（Python，MIT）：docstore 保存 `doc_id → document_hash`，哈希不变就跳过，变了就 re-process + upsert；这正是我们需要的最小增量语义。但引入它等于引入整条 LlamaIndex 栈。
  - **LlamaIndexTS**（3.1k★，最后推 2026-03）存在，但活跃度明显低于 Python 侧。
  - **Haystack 3.4.1**（Apache-2.0，Python）：有 DocumentStore 与 pipeline，同样是 Python。
  - 结论：**增量同步这层自己写 30 行更划算**（文件 mtime + 内容 hash 存一张表，BullMQ 定时扫描目录），不值得为它引框架。

来源：https://github.com/chonkie-inc/chonkie 、https://www.npmjs.com/package/@langchain/textsplitters 、https://developers.llamaindex.ai/python/framework/module_guides/loading/ingestion_pipeline/ 、https://github.com/run-llama/LlamaIndexTS 、https://github.com/deepset-ai/haystack

### D. Embedding 与 Rerank

#### D1. 自托管服务

| 服务 | 许可证 | OpenAI 兼容 | Rerank | CPU | 备注 |
| --- | --- | --- | --- | --- | --- |
| **TEI 1.9.4** | Apache-2.0 | 是，`/v1/embeddings`（官方 quick tour 给出 OpenAI SDK 示例） | 是，`/rerank` | 是，`cpu-1.9` / `cpu-arm64-1.9` 镜像 | 一个容器同时解决 embedding + rerank，最贴合「网关后面挂服务」 |
| Infinity 0.0.78 | MIT（Python 包）；**v3 改为 Infinity Restricted MIT 1.0** | 官方称「OpenAPI aligned to OpenAI's API specs」，**具体路径未在页面确认（未核实）** | 是 | 是，`latest-cpu` 镜像 | 支持 bge-m3（dense、无 sparse），模型面最广 |
| Ollama | MIT | 是，`/v1/embeddings` 已文档化 | **未核实**（兼容页未提 rerank） | 是 | 开发期最省事，生产吞吐一般 |
| vLLM | Apache-2.0 | 是 | 通过 pooling 模型 | 否（GPU） | 只在已有 GPU 时选 |

#### D2. 模型对比（中文 / 多语）

| 模型 | 许可证 | 维度 | 上下文 | 备注 |
| --- | --- | --- | --- | --- |
| **bge-m3** | MIT | 1024 | 8192 | 100+ 语言，稠密 + 稀疏（lexical weight）+ 多向量（ColBERT），一个模型三种检索 |
| **Qwen3-Embedding-0.6B** | Apache-2.0 | 32–1024 可配 | 32K | 100+ 语言，有配套 Qwen3-Reranker 0.6B/4B/8B |
| **bge-reranker-v2-m3** | Apache-2.0 | — | — | 0.6B，官方卡片明确推荐「Chinese or English」 |
| jina-embeddings-v3 | **CC BY-NC 4.0** | 1024 | 8192 | **非商用**；商用只能走 Jina API / AWS / Azure 市场 |
| voyage-3 / voyage-3-large | 商业 API | 1024（large 可 256/512/2048） | — | $0.06 / $0.18 每百万 token |
| Cohere embed v4 | 商业 API，闭源权重 | 1536，Matryoshka 可截断 | 128K | 第三方报价 $0.12 / 百万 token（**未与 Cohere 官方页核实**） |
| OpenAI text-embedding-3-small / large | 商业 API | 1536 / 3072（可 `dimensions` 截断） | 8192 | 官方只给「每美元约 62,500 / 9,615 页」，未给单价 |

**与现有 OpenAI-compatible 网关的兼容性**：本仓 `packages/worker/src/model-proxy.ts` 目前只代理 `/v1/messages*` 与 `/v1/models`（Anthropic 协议），**没有 `/v1/embeddings`**。所以「网关已有 OpenAI-compatible 能力」这件事在代码里还不存在，需要新增一条 embedding 路由或让 worker 直连 TEI / 上游 API。TEI 的 `/v1/embeddings` 是现成的 OpenAI 兼容实现，接进来几乎零适配。

**成本量级**：一个 10 万页规模的知识库按每页约 500 token 估算 ≈ 5000 万 token；OpenAI small 档按官方「62,500 页/美元」约 1.6 美元，voyage-3 约 3 美元，voyage-3-large 约 9 美元。**embedding 成本在这个规模下不构成决策因素**，决策因素是中文效果与是否需要离线。

#### D3. rerank 是否值得作为第一阶段能力

不值得。理由三条：① RRF 融合在 SQL / Node 里都能十几行写完，且不需要调分数归一化；② rerank 增加一次模型调用（20 条候选 × 512 token），延迟与成本都翻倍；③ 当前还没有能证明 rerank 有收益的评估集。**正确顺序是：先建 20–50 条带答案的评估用例（用 promptfoo 跑 context-recall），有了基线再决定要不要 rerank。**

来源：https://huggingface.co/docs/text-embeddings-inference/quick_tour 、https://github.com/huggingface/text-embeddings-inference 、https://github.com/michaelfeil/infinity 、https://docs.ollama.com/api/openai-compatibility 、https://huggingface.co/BAAI/bge-m3 、https://huggingface.co/Qwen/Qwen3-Embedding-0.6B 、https://huggingface.co/BAAI/bge-reranker-v2-m3 、https://docs.voyageai.com/docs/pricing 、https://developers.openai.com/api/docs/guides/embeddings

### E. 现成的 MCP 检索服务

- **filesystem（`@modelcontextprotocol/server-filesystem` 2.0.1）**：工具是 `read_text_file` / `read_multiple_files` / `list_directory` / `directory_tree` / `search_files` / `get_file_info` / `list_allowed_directories` + 写类工具。关键限制：**`search_files` 只做 glob 路径匹配，没有内容搜索**；所有操作限定在命令行传入的目录内。所以它能实现「按目录挂载 + 读文件」，但**不能**实现「按目录挂载 + 内容检索」。许可证：MCP 项目正在从 MIT 迁移到 Apache-2.0，仓库根 LICENSE 说明新旧贡献并存。
- **Qdrant MCP（0.8.1，Python，Apache-2.0）**：只有 `qdrant-store` / `qdrant-find` 两个工具，embedding 只支持 fastembed，默认模型 `all-MiniLM-L6-v2`（中文很差）。要用必须改 embedding 配置或换实现。**最后发版 2025-12，8 个月内无更新**。
- **Chroma MCP（0.2.6）**：仓库 2025-09 后停更。
- **Postgres / pgvector 类 MCP**：官方 reference servers 里 **PostgreSQL 已归档**（当前 7 个 reference server 是 Everything / Fetch / Filesystem / Git / Memory / Sequential Thinking / Time）。社区有若干 pgvector MCP（`mcp-pgvector-server`、`@gresmcp/mcp`、`mittalpk/pgvector`），但都**不在官方列表**、活跃度参差，作为生产依赖需要先读源码。**未核实其长期维护性**。
- **平台自己的 generated MCP server（关键发现）**：本仓 `packages/api/src/features/servers/mcp-endpoint.ts` + `generated.ts` 已经实现「把任意外部 HTTP 工具包装成 MCP tool」，支持 `pathTemplate`、`paramsIn`、`inputSchema`、逐工具审批（`approvalWaitMs` / `requestApproval` / 刷新审批），并以 `mcp__<server>__<tool>` 形式注入沙盒。这意味着**「知识检索工具」不需要写 MCP server**，只需要：
  1. 在 Fastify 里加一个 `POST /api/knowledge/search`（zod schema + requireAuth）；
  2. 建一个 `kind: 'generated'` 的 server，`baseUrl` 指向自身，工具 `pathTemplate: '/api/knowledge/search'`；
  3. 把 server 绑定到智能体。
  这条路径完全不新增进程、不新增协议实现，且天然复用已有的审批与审计。
- **Claude Code / Agent SDK 原生读取工作区的能力**：`Grep` 基于 ripgrep（`code.claude.com/docs/en/tools-reference`），`Read` 支持 PDF（>10 页需 `pages` 参数，依赖 `pdftoppm`），`Glob` 按文件名匹配。但官方文档同时写明：**在 macOS / Linux / WSL 上 `Grep` 与 `Glob` 默认不在工具集里**，Claude 走 Bash 的 `grep` / `find`；而本仓 runner 把 `Bash` / `Glob` / `Grep` 全部 disallow（`packages/sandbox/src/runner.ts`），`Read` 由 `packages/sandbox/src/memory-permissions.ts` 的 PreToolUse hook 限制在 `/mnt/agent-memory/` 与 `.claude/skills/*/references/`。**所以在当前平台里，「原生文件工具当第一版检索」不是开箱即用的，必须先改这段策略。**

来源：https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md 、https://github.com/modelcontextprotocol/servers 、https://github.com/qdrant/mcp-server-qdrant 、https://code.claude.com/docs/en/tools-reference 、https://code.claude.com/docs/en/agent-sdk/typescript

### F. 评估与可观测

- **promptfoo 0.125.1（npm，MIT，TypeScript）**：内置 `context-faithfulness`（答案能否被 context 支持）、`context-recall`（标准答案是否出现在 context 里）、`context-relevance` 三个断言，默认阈值 0.5；`vars.context` 传静态上下文，`contextTransform` 从 provider 输出里抽上下文，`transformResponse` → `transform` → `contextTransform` → 断言的顺序固定。**这是唯一一个「TS 原生 + 已有 RAG 断言 + 活跃」的组合**，2026-10-25 仍在推送。
- **RAGAS 0.4.3（Apache-2.0）**：指标最全（faithfulness / answer_relevancy / context_precision / context_recall 等），但**只有 Python**，官方站与 PyPI 都没有 JS SDK。要跑就得多一个 Python 运行时/容器。
- **DeepEval 4.2.4（Apache-2.0）**：Python，pytest 风格，适合做 CI 里的单测式评估。
- **autoevals 0.4.1（npm，MIT，Braintrust）**：TS 里另一条路，有 ContextRecall / ContextPrecision / Faithfulness，作为 promptfoo 不够用时的补充。
- **最小可用做法**：不引入任何评估框架也能起步 —— 拿 30 条「问题 + 期望引用的文件片段」的 JSON，跑 `/api/knowledge/search` 算 `hit@5` 与 MRR。这比任何 LLM judge 都稳定、免费、可进 CI。等要评估「答案忠实度」再上 promptfoo。

未确认：promptfoo 的具体许可证只从 npm registry 读到 `MIT`，官网页面本身未列许可证（**已交叉确认**：GitHub `promptfoo/promptfoo` 的 `licenseInfo.spdxId` 为 MIT）。

来源：https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/ 、https://github.com/promptfoo/promptfoo 、https://pypi.org/project/ragas/ 、https://pypi.org/project/deepeval/ 、https://www.npmjs.com/package/autoevals

---

## 零新服务路径的可行性

### 结论

**「工作区文件 + 官方文件工具」需要改一处策略，之后才算零新服务；「文件 + 一个 Fastify 检索路由 + generated MCP server」在任何情况下都是零新服务。**

### 路径 1：纯文件 + 官方文件工具（第 0 档）

当前阻塞点（都已核实）：

| 位置 | 现状 | 影响 |
| --- | --- | --- |
| `packages/sandbox/src/runner.ts` | `Bash` / `Glob` / `Grep` / `WebFetch` / `WebSearch` 全部进 `baseDisallowed` | 智能体不能用 ripgrep，也不能用原生 Grep |
| `packages/sandbox/src/memory-permissions.ts` | `createFileBoundaryHook` 只放行 `/mnt/agent-memory/**` 与 `.claude/skills/<slug>/references/**`，且后缀必须是 `.md` | 知识目录即使挂载也读不到 |
| `packages/worker/src/sandbox/docker.ts` | `-v ${workspace}:/workspace:ro` + 额外挂载 | 挂载只读没问题，缺的是权限放行 |
| `packages/core/src/workspace.ts` | 系统提示明确写「其他路径与子智能体文件访问均被拒绝」 | 提示词与策略要一起改，否则模型不会去试 |

要让路径 1 成立，需要一次性改动：新增一个只读挂载点（例如 `/mnt/knowledge/:ro`）+ 在 `createFileBoundaryHook` 里为它加 `Read`/`Grep` 白名单（并决定是否允许 `Grep` 工具本身）+ 同步系统提示。**不新增任何进程或服务。** 代价是无法排名、中文只能字符匹配、frontmatter 过滤要靠路径约定。

### 路径 2：pgvector + 平台 generated MCP server（推荐）

```
Markdown 知识目录（宿主）
   │  BullMQ 定时任务：mtime+hash 增量，切块
   ▼
Postgres: knowledge_chunks(id, doc_path, heading, content, tsv, embedding vector)
   │  Postgres：tsvector/pgroonga 关键词 + pgvector 向量 + RRF
   ▼
Fastify: POST /api/knowledge/search   (zod schema, requireAuth)
   ▲
   │  generated MCP server（已存在的机制，kind:'generated'）
   ▼
沙盒内智能体：mcp__knowledge__search
```

新增物：一张表 + 一个路由 + 一个 generated server 记录 + 一个 BullMQ 任务。**不新增容器、不新增运行时、不新增定义格式。** 唯一的外部依赖变化是 Postgres 镜像要带 pgvector（以及中文检索需要的 pgroonga）。

### 何时打破「零新服务」

| 触发条件 | 需要引入的东西 | 判断依据 |
| --- | --- | --- |
| 要解析扫描件 PDF / 复杂表格 / 公式 | docling-serve 容器（MIT） | 纯 Node 没有可接受的表格/OCR 方案（见 B2） |
| 需要离线 embedding 或不想把文档发给外部 API | TEI 容器（Apache-2.0，CPU 镜像） | 一个容器同时给 `/v1/embeddings` 和 `/rerank` |
| chunk 数进入千万级、或需要独立扩缩容、或要原生 BM25 排序 | Qdrant 容器（Apache-2.0） | pgvector 的过滤检索短板与 HNSW 内存约束（见 A1） |
| 需要按用户/租户严格隔离且租户数很多 | 先考虑 Postgres list 分区 + RLS，再考虑 Qdrant | pgvector 官方建议按租户 list 分区 |

---

## 未确认项

1. **pg_jieba 上游活跃度**：GitHub 仓库存在（`jaiminpan/pg_jieba`，BSD-3-Clause），但只有二手来源（LibHunt / Pigsty 文档）提到「最后提交 2 年前」。未逐一核实 commit 时间。
2. **ParadeDB `pg_search` 是否有中文分词器**：搜索结果只确认「支持自定义 tokenizer / 每字段多 tokenizer」，未确认 Tantivy 的 jieba tokenizer 是否被暴露。
3. **docling-serve 的异步任务接口**：官方 usage 页面列出 `POST /v1/convert/source`、`/docs`、`/ui`，未确认是否有 async task / status 端点。
4. **Docling 各 OCR 引擎的中文语言标签**：FAQ 只说支持 BCP-47 标签并链接到各引擎文档，未给出 `zh` / `chi_sim` 的具体写法。
5. **Docling / MinerU 的实际吞吐（页/秒）**：官方均未给基准，只有 Marker 给了（B200 上 2.9–7.4 页/秒）。
6. **Infinity 的 OpenAI 兼容具体路径**：官网只写「OpenAPI aligned to OpenAI's API specs」，未列出 `/embeddings` / `/rerank` 的准确路径。
7. **Ollama 是否支持 rerank**：OpenAI 兼容页未提及。
8. **Cohere embed v4 的官方定价**：只从第三方比价站读到 $0.12 / 百万 token，未与 Cohere 官方定价页核对。
9. **社区 pgvector MCP server 的维护状态**：`mcp-pgvector-server` / `@gresmcp/mcp` / `mittalpk/pgvector` 均不在官方 reference 列表，未读源码、未核实长期维护。
10. **Alpine `postgresql-pgvector` 为何停在 0.8.1**：已确认 3.23 / edge 都是 0.8.1-r0，但未查 APKBUILD 的更新节奏。
11. **pgroonga 官方 Docker 的当前版本**：release API 显示 4.1.0（2026-10-09），但 Docker Hub 搜索结果显示 `latest-alpine-18` 标的是 4.0.9，两者可能不同步；部署前需 `SELECT pgroonga_version();` 实测。
