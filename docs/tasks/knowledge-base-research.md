# 知识库能力探索（开源方案选型）

> 2026-10-25 补充调研已完成：GitHub 上的 OpenWiki 与腾讯 WeKnora。最新结论见 [补充汇总](knowledge-base-research-addendum.md)、[OpenWiki](knowledge-base-research-openwiki.md)、[WeKnora](knowledge-base-research-weknora.md)。下文三阶段为早期设想，新增候选纳入后不再作为默认推荐。仅调研，未授权实施或提交。

## 目标

给 Agentport / PACE 增加知识库能力。本阶段只做探索：调研可用的开源方案，找出与本项目架构、许可证、资源约束相容的路径，并给出分阶段建议。**不改产品代码。**

验收标准：能回答「用哪些开源件、什么形态接入、代价多少、什么时候必须加服务」，且每条结论有一手来源。

## 方案

分三路并行调研后合成：

| 分报告 | 内容 |
|---|---|
| [part-internal](knowledge-base-research.part-internal.md) | 项目内现状、接入点、硬约束 |
| [part-products](knowledge-base-research.part-products.md) | 完整知识库产品（Onyx/RAGFlow/AnythingLLM/…） |
| [part-components](knowledge-base-research.part-components.md) | 组件拼装（pgvector/解析/切分/embedding/MCP） |

## 基线与范围

- 起点 commit：`797edfe`（与本地 main 一致，工作树干净）
- 允许改动：仅本调研 worktree 内的 `docs/tasks/knowledge-base-research*.md`
- 未改动任何产品代码

## 当前有效决定

- **D-9 仍现行**：不做内置 RAG；流程性知识用 `SKILL.md`，文档检索交给 MCP resource 或外部检索服务（`docs/DECISIONS-PENDING.md:83-85`）。
- 本次探索**不推翻 D-9**，只指出它的实现路径需要修正。

## 核心结论

### 1. 早期判断：整套产品的额外成本需要权衡

> 此处是上一轮判断，尚未纳入 OpenWiki / WeKnora；不作为当前最终推荐。带 UI 不构成淘汰理由，是否提供可独立调用的检索与摄取能力更关键。

候选产品的许可证与形态代价：

| 产品 | 许可证 | 致命点 |
|---|---|---|
| RAGFlow | Apache-2.0 | 4C/16GB + ES/MinIO/Redis/MySQL 四件套，为单机平台引入一整套基础设施 |
| Onyx | MIT + EE 目录另许 | 强依赖 OpenSearch；多租户/RBAC 在 EE |
| Dify / FastGPT | 修改版 Apache-2.0 | 有多租户/品牌附加条款；本项目当前是单管理员，并非已实现多租户，因此不能据此直接判定不可用；需按实际部署和分发方式评估 |
| MaxKB | GPL-3.0 | 分发其代码或镜像需履行相应许可义务；独立 API 调用不会自动要求 PACE 全部开源 |
| Open WebUI | BSD-3 + 品牌条款 | >50 用户不得改品牌；且是完整聊天前端 |
| Khoj / Kotaemon / Quivr / Verba | AGPL / 无 REST / alpha / 已归档 | 直接淘汰 |

**早期判断已收窄**：是否采用外部知识库，应比较其上传、解析、同步、索引、引用能力与额外运维成本。拥有聊天 UI 本身不是不适合的证据；能以纯检索方式供现有 Claude Agent SDK 调用，是更关键的筛选条件。

### 2. 已核实的关键技术事实（会影响方案取舍）

**① 「generated server 指向平台自身」这条捷径不成立（修正 part-components 的推荐）**

`assertSafeUrl` 在 `NODE_ENV=production` 时拒绝一切解析到私网的地址（`packages/api/src/features/servers/ssrf.ts:106-137`），且校验发生在**创建时**（`routes.ts:118-122`）、**测试连接时**（`test-connection.ts:102-105`）、**每次工具执行时**（`generated.ts:162`）。`SELF_URL` 默认 `http://127.0.0.1:3000`，compose 里 `NODE_ENV: production`。因此 generated server 指向自身会被 400 `INVALID_URL` 拦下。

> 只有 `development` 且 host 为 localhost 时放行（`ssrf.ts:98-100`），不能作为生产方案。

**修正（2026-10-25）**：普通 `kind=http` 连接器同样在登记和测试连接时经过 `assertSafeUrl`（`routes.ts:118-121`、`test-connection.ts:102-105`），不能直接登记生产内网知识服务。worker 仅为 `generated` 改写为 `${SANDBOX_API_URL}/mcp/<id>`（`index.ts:111-113`），普通 HTTP URL 原样保留。外部知识服务可使用符合现有策略的可达地址；内网部署需设计明确的可信服务接入路径，不能靠更换 server kind 绕过现有策略。平台自建路由还需处理沙盒凭证与浏览器 Cookie 鉴权的差异，不能只增加一个 `requireAuth` 路由就宣称闭环。

**② MCP resources 不是不可用，而是被默认关掉**

SDK 类型里存在 `ListMcpResources` / `ReadMcpResource` / `ReadMcpResourceDir` 输入输出定义。平台未显式预批准这些工具；类型存在既不能证明实际工具已暴露，也不能证明 `dontAsk` 下可用。资源列举、读取、权限需在项目所用 SDK 中实测，当前不判定 D-9 的 resource 路线已验证。对外部检索服务，优先验证明确提供的检索 MCP tool 或纯检索 REST API。

**③ 当前智能体可读取技能 references，但不能任意搜索工作区文件**

- `Grep`、`Glob`、`Bash` 全在 `baseDisallowed`（`runner.ts:193-197`）
- `Read` 只放行 `/mnt/agent-memory/**` 与 `.claude/skills/*/references/**`（`runner.ts:174-178`）
- 工作区只读挂载（`docs/ARCHITECTURE.md:168`）

这是所有方案共同的前置改造点。

**④ 中文全文检索必须装扩展**

Postgres 只有一个内置 parser，中文整句会被当成单个 token。可选：

| 方案 | 许可 | 状态 |
|---|---|---|
| pgroonga | PostgreSQL License | **首选**，支持 PG 18，官方 alpine 镜像 |
| zhparser | PostgreSQL License | 官方 Docker 只到 PG 16 |
| pg_bigm | PostgreSQL License | 只有 `LIKE`，无排名 |

**⑤ 现有 Postgres 镜像不带 pgvector**

`docker-compose.yml` 用 `postgres:18-alpine`，Alpine 仓库的 `postgresql-pgvector` 只有 0.8.1-r0（官方最新 0.8.7）。要 pgvector 需换 `pgvector/pgvector:pg18`。

**⑥ 模型代理没有 embeddings 路由**

`model-proxy.ts` 只放行 `/v1/messages`、`/v1/messages/count_tokens`、`/v1/models`（`model-proxy.ts:19`）。embedding 需要新增路由或直连上游。

**⑦ 沙盒无 Python、每 run 冷启动**

镜像基于 `node:24-alpine`（`packages/sandbox/Dockerfile:3`）。PDF/Office 解析必须放在 api/worker 侧或独立服务，不能塞进沙盒。

### 3. 推荐路径：三阶段，按需加服务

**阶段一：零新服务（先用起来）**

```
Markdown 知识（frontmatter 标 tags/agent）
  → 渲染进 skill references/ 或新增 /mnt/knowledge/ 只读挂载
  → 放宽 Read 白名单（+ 可选 Grep）
  → 智能体按 SKILL.md 描述按需读取
```

新增物：无。改动：`runner.ts` 白名单、`memory-permissions.ts` hook、`workspace.ts` 系统提示。
代价：无排名、无中文分词、靠模型自己找。
适用：文档量小（几十份）、以流程性知识为主。**这其实已覆盖 D-9 描述的多数场景。**

**阶段二：关键词检索（最小可用知识库）**

```
Markdown 目录
  → BullMQ 定时任务：mtime + hash 增量，按标题切块
  → Postgres: knowledge_chunks(content, tsv)
  → Fastify POST /api/knowledge/search（zod + requireAuth）
  → .mcp.json http server → mcp__knowledge__search
```

新增物：一张表 + 一个路由 + 一个 server 记录 + 一个队列任务。中文检索装 pgroonga。
代价：换 Postgres 镜像；无向量语义召回。

**阶段三：混合检索（真正的 RAG）**

在阶段二基础上加 `embedding vector(1024)`，用 RRF 融合关键词与向量：

- 扩展：pgvector 0.8.7（换 `pgvector/pgvector:pg18`）+ pgroonga
- Embedding：初期走外部 API；需要离线时上 TEI（Apache-2.0，CPU 镜像，同时提供 `/v1/embeddings` 与 `/rerank`）
- 模型：bge-m3（MIT，1024 维，中文稳）或 Qwen3-Embedding-0.6B（Apache-2.0）

**明确不在阶段一/二做**：rerank、语义切分、Python 解析服务、独立向量库。这些都等有评估基线后再决定。

### 4. 与第一性原则的一致性

官方 `.claude/` 目录里**有**知识载体：`CLAUDE.md` 的 `@import`、`rules/*.md`、技能支持文件、`agent-memory/`。但**没有**任何官方约定描述 chunk 与向量。

**修正（2026-10-25）**：须区分智能体定义与外部语料。技能内知识可用官方支持的 `references/` 文件交付；外部知识服务则以 `.mcp.json` 和使用说明表达智能体的接入定义，语料由该服务管理，符合 D-9 的外部检索方向。外部语料导出、原始文件备份和索引重建需另行验证，不应声称一个 `.claude/` 包自动携带外部服务全部数据。自建索引时应明确编辑来源和可重建边界，不能把「DB 是编辑来源」误写成「DB 永远只存索引」。

### 5. 规模与触发条件

| 触发条件 | 才需要引入 |
|---|---|
| 扫描件 PDF / 复杂表格 / 公式 | docling-serve（MIT，CPU 镜像）或 docling-mcp |
| 离线 embedding | TEI 容器 |
| 千万级 chunk / 需原生 BM25 排序 / 独立扩缩容 | Qdrant（Apache-2.0） |
| 需要评估检索质量 | promptfoo（npm，MIT，自带 context-recall 等断言） |

## 已替代项及原因

- 原结论「generated MCP server 指向平台自身即可零成本接入检索」——生产内网地址会被 `assertSafeUrl` 拦截；普通 HTTP 连接器也不能绕过登记校验。内网接入方案待验证。
- 原结论「MCP resources 在 SDK 下不可见」及其后「类型存在即可认定可用」——两者都缺少运行证据；目前只确认类型存在，实际读取未验收。
- 原结论「本项目是多租户，因此直接淘汰 Dify/FastGPT」——项目当前是单管理员，不能如此推导。
- 阶段一/二/三是早期设想，未获用户实施授权；后续选型须结合本轮 OpenWiki 与 WeKnora，不把自建索引作为既定方案。

## 步骤

- [x] 三路并行调研
- [x] 本地核实接入约束与 SSRF 边界
- [x] 合成报告
- [ ] 用户决定是否推进，以及从哪个阶段开始
- [ ] 若推进阶段二/三：先更新 D-9 并留痕

## 下一步

需用户决策：

1. **要不要做**？D-9 目前写的是「不做内置 RAG」。如果这次只是想把现有文档喂给智能体，阶段一就够，且不必推翻 D-9。
2. **如果做**，从阶段几开始？
3. **中文检索**是否硬需求（决定要不要换 pgroonga 镜像）？
4. **文档从哪来**：手工上传、挂载宿主目录、还是从外部系统同步？

## 改动文件

- `docs/tasks/knowledge-base-research.md`（本文件）
- `docs/tasks/knowledge-base-research.part-internal.md`
- `docs/tasks/knowledge-base-research.part-products.md`
- `docs/tasks/knowledge-base-research.part-components.md`

## 验证

- 三份分报告均附一手来源 URL 与 `path:line`
- 关键否决点（SSRF、Grep 禁用、无 pgvector、代理无 embeddings）均在本地代码中复核
- 未运行任何构建或测试（无代码改动）

## 未确认项

1. 各产品中文检索的**实测**效果——全部未做 benchmark
2. pgroonga Docker 版本与 release 是否同步（部署前需 `SELECT pgroonga_version()`）
3. `client_composed: true` 是否让 `CLAUDE.md`/`rules` 完全不进上下文（需真实模型实测）
4. MCP resources 在 `dontAsk` 权限模式下是否可用（需实测）
5. Postgres 18-alpine 是否自带 `vector` 扩展（本仓库未用）
6. docling-serve 的异步任务接口、Docling 中文 OCR 语言标签
