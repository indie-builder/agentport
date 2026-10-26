# 知识库补充探索：GitHub OpenWiki 与腾讯 WeKnora

## 目标与当前有效决定

用户追加：调研 GitHub（已纠正 GitLab）上的 OpenWiki 与腾讯知识库项目是否适合 PACE。只做探索，不实施、不提交、不更新 D-9。OpenWiki 存在同名项目，当前重点候选是 LangChain OpenWiki；腾讯候选为 WeKnora，尚未得到用户对仓库身份的逐一确认。

基线 `797edfe`，沿用 `knowledge-base-research` worktree。原四份调研文档为本会话未提交成果，无产品代码差异。本轮新增两份定向报告与本汇总，并修正原总报告的事实误判。

## 结论

**WeKnora 列入产品知识库后端的优先验证名单；OpenWiki 列入文件知识组织与生成产物复用名单。两者不是互相替换的方案。** 当前不能据静态调研决定最终采用，也不预设资料规模、格式和更新频率。

| 维度 | LangChain OpenWiki | Tencent WeKnora |
|---|---|---|
| 核心价值 | 把源码/跨来源资料整理成互链 Wiki，持续更新 | 上传/解析/同步/索引/检索，另有 Wiki 与 Agent 功能 |
| 主许可证 | MIT | MIT，附第三方组件清单，未完成依赖逐项审计 |
| 内容形态 | Markdown + 来源/状态文件；代码模式有 Grounded Claims，个人 connector 事实不享有同样保证 | 标准版数据库 + 文件卷；支持 Markdown 导出，完整还原未验收 |
| 纯读取接口 | stdio MCP 的 search/read；仓库 Wiki 路径与 Git 根限制 | Streamable HTTP MCP 的只读检索组；另有不生成答案的 REST API |
| 对执行底座的影响 | 原生 personal/code CLI 使用 Deep Agents/LangGraph；仅消费产物无第二循环 | 只用 search/read，不启用 ask，可保留 Claude Agent SDK 为唯一产品推理循环 |
| 最轻路线 | 把已生成 Markdown 导入现有 skill references，无新增服务 | Lite：SQLite FTS5/sqlite-vec + 本地文件 + 内存流管理；外部接口待实测 |
| 完整路线 | 自有 CLI、状态与数据源；官方 Claude 集成当前仅仓库 Wiki | 标准 Compose 默认 app/frontend/docreader/ParadeDB/Redis，完整解析链需额外资源 |
| 对 PACE 的评价 | 适合文件产物复用；不直接嵌入 personal CLI | 更贴合产品级文档检索；优先验证，不直接部署 |

证据分别见 [OpenWiki 定向报告](knowledge-base-research-openwiki.md) 与 [WeKnora 定向报告](knowledge-base-research-weknora.md)。源码快照：OpenWiki `305599f8e44203f9ca6b74bb6b38eebaf0b0405e`；WeKnora `e1f9a6166a593a4804a2f99f1d942919c9cc8ea7`，核对日期 2026-10-25。报告以 main 快照为准，实施须对照固定 release，不保证其每项能力已在发行镜像中。

## WeKnora：为何值得进一步验证

官方 MCP 端点 `/mcp/<endpoint_id>` 使用独立 Bearer token，并允许分别勾选工具组。默认只读组包括 `list_knowledge_bases`、`search_knowledge`、`grep_chunks`、`list_documents`、`read_document`；`ask` 在独立问答组。因此 PACE 可以只获取资料，让现有 Claude Agent SDK 生成答案，无需接入 WeKnora 的 Agent loop。[官方 MCP 文档](https://weknora.weixin.qq.com/docs/03-features/08-mcp)

纯检索 REST `POST /api/v1/knowledge-search` 明确不使用 LLM 总结，使用 API Key/Bearer；`POST /api/v1/knowledge-bases/{id}/hybrid-search` 的检索结果定义包含文档与 chunk 信息。二者不能与按文件名查询的 `/knowledge/search` 混淆；`knowledge-search` 的真实 JSON 引用完整性仍需实跑。[Swagger 源码](https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/docs/swagger.json)

标准版默认 ParadeDB PG17（pg_search + vector），现有 PACE 普通 PG18 不能只新建 schema 就复用；并不意味着 WeKnora 永远不支持 PG18。采用独立数据库可避免改 PACE 主库，但要增加备份与升级工作。[标准 Compose](https://github.com/Tencent/WeKnora/blob/e1f9a6166a593a4804a2f99f1d942919c9cc8ea7/docker-compose.yml)

Lite 是另一条路线：官方说明单应用、零外部服务依赖、Simple 解析、单空间；配置明确 SQLite FTS5/sqlite-vec、本地存储、内存流管理。不能把标准版五服务当作所有模式的最低要求。源码的部署能力开关未直接按 Lite 禁用 MCP/API，但实际依赖注入与客户端调用仍需验证。[Lite 文档](https://github.com/Tencent/WeKnora/blob/main/docs/LITE.md) · [Lite 配置](https://github.com/Tencent/WeKnora/blob/main/.env.lite.example) · [能力开关](https://github.com/Tencent/WeKnora/blob/main/internal/handler/deployment_capabilities.go)

## OpenWiki：适合复用什么

LangChain 项目已有代码和个人 brain 两种模式，正文是 Markdown，个人原始来源与运行状态存于 `~/.openwiki` 下。不能只把它当代码文档生成器，也不能把其私有状态目录或 OKF frontmatter 当成 Claude 官方定义。[固定版本 README](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/README.md)

原生 CLI 调用 `createDeepAgent`，依赖 LangGraph；不适合作为 PACE 内另一套自动知识整理执行底座。官方 Claude Code 技能/MCP 集成可沿用宿主循环，但当前仅面向仓库 Wiki。[生成源码](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/agent/index.ts) · [官方集成](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/integrations/openwiki/SKILL.md)

优先复用其已生成页面：通过现有 skill 资源入口放入 `.claude/skills/<slug>/references/`，配索引页与来源。此路径无需放开 Grep/Glob，也不需要安装 OpenWiki；但需处理 ASCII 文件名、链接、资源大小和专家包上限，且不会自动继承 Claims 证据更新。原版 MCP 则假定 Git 仓库和 `openwiki/`，并非任意目录的开箱检索服务。[检索实现](https://github.com/langchain-ai/openwiki/blob/305599f8e44203f9ca6b74bb6b38eebaf0b0405e/src/retrieval/wiki.ts)

同名候选：Vercel OpenWiki 是另一套 Web 产品；OpenDeepWiki 是 C#/Next.js 的代码仓库知识服务，均与通用文件 brain 不同，详见定向报告。若用户记得的是另一仓库，应按实际链接调整范围。

## PACE 接入共性与上一轮修正

1. 当前单管理员，不能以「已是多租户」排除产品；GPL/AGPL 也不自动要求独立 API 调用方全部开源。
2. HTTP 与 generated 在登记时均受 `assertSafeUrl` 限制，生产私网 URL 被拒。更换 kind 不能绕过。需验证可信内网服务的准入、沙盒网络和凭证；本轮不修改安全策略。
3. 外部知识服务本身符合 D-9 外部检索方向，不要求其所有语料放进 `.claude/`。智能体连接与说明落官方文件，外部语料备份、导出另验收。
4. PACE 当前能 Read 技能 references，不能任意搜索工作区；外部 MCP 检索不要求开放本地文件搜索权限。
5. SDK resources 类型存在不代表已实际加载、获准读取；本轮建议依赖明确的 search/read 工具，不把 resource 路线当已验收。
6. 早期「先自建 pgvector」路线尚未获用户选择，不优于现成开源产品作为默认答案。先用真实资料比较能力与成本。

本地依据：`packages/api/src/features/servers/routes.ts:118`、`ssrf.ts:106`、`packages/worker/src/index.ts:111`、`packages/sandbox/src/runner.ts:174`、`memory-permissions.ts:36`、`docs/DECISIONS-PENDING.md:83`。

## 建议的下一步验证（未执行）

- WeKnora：锁定发行版本，以少量中英 Markdown、文本 PDF、扫描件和表格建库，记录召回/引用/耗时；只开放只读工具组，确认无 ask、更新删除可生效。
- 先测 Lite 是否满足接口与解析需求；不满足再测标准版，记录实际内存与新增组件，而非按容器数推断性能。
- PACE：验证生产内网接入、密钥隔离和沙盒到 MCP 的实际调用；配置导出后检查无密钥泄露，工具返回引用可追溯。
- OpenWiki：导入少量现有页面及索引到 references，验证跨 run 保留、按索引阅读、来源回链；不先引入原生 personal CLI。
- 两者都需核对备份/导出恢复及中文检索，不能用中文 UI 证明质量。是否组合使用等单项验证后再定。

## 产出与验证

仅文档，未部署、未安装依赖、未改产品代码、未运行构建或模型调用、未提交。已查询官方源码/许可证/配置并核对本地接入边界；Python 静态检查七份调研文档的相对 Markdown 链接全部可解析。独立 Opus 复核提出三处修正：比较表漏列 Lite、跨产品质量排序缺证据、许可义务结论过强，已逐项修正；未进行第二轮独立复核。下一步为用户选择是否做样本验证；不存在待授权的已启动实现工作。
