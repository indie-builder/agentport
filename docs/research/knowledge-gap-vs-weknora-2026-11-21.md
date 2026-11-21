# 知识库能力缺口分析（对照 WeKnora，2026-11-21）

> 范围：仅「知识库核心功能」与「知识存储/维护」两块，不含聊天、Agent、IM 渠道、RBAC、沙盒等平台能力。
> 方法：只读两侧源码枚举能力并交叉核对。WeKnora 侧读 `internal/types/*.go`、`internal/handler/*.go`、`internal/router/*.go`、`internal/application/service/*`；本仓侧读 `packages/{contract,api,db,worker,web}` 的知识模块、契约路由与 schema。清单结论以代码为准，不以 README 营销为准。
> 用途：给出「还缺什么、需要哪些」的判断，并作为本批补全的依据。

## 1. 结论速览

1. **本仓知识库主链路已完整**：摄取（本地 + Docling PDF/Office/OCR/多模态图片/ASR）、结构感知分块、文本与图片向量、关键词+向量混合检索 + RRF + rerank、版本 COW/回滚、FAQ、Wiki（含版本/回滚/diff/链接）、14 种来源同步、离线检索评估、知识包导出/导入、ZIP 安全校验、清理/重建/对账/调度都已落盘（`docs/ARCHITECTURE.md` §6）。
2. **真正缺的是「维护闭环」和若干「外围增强」**，不是能不能检索。
3. 本批已补：**文档列表排序、勾选批量下载原件、文档版本改动前后对比**（详见 §4）。
4. **明确不做（需先有场景与成本决策）**：GraphRAG（依赖 Neo4j + 抽取模型费用）、替换存储后端、新增解析引擎。它们不是「缺失的拼图」，而是重型横向能力。
5. 纠偏：两份盘点里对「目录树是否保留」「备份是否含知识卷」的初判有误——本仓**已保留上传目录树**（`relativePath→folderForPath` 建嵌套文件夹），**备份/恢复脚本已含知识卷**并支持隔离侧验（`scripts/backup.sh`、`scripts/restore.sh --target-knowledge`）。

## 2. 缺口矩阵

状态：✅ 已具备；🟡 部分；❌ 缺失。仅列 WeKnora 有而本仓没有、或本仓明显更弱的项。

### 2.1 核心功能

| 能力 | WeKnora | 本仓 | 判断 |
|---|---|---|---|
| 多格式解析 | 内置/anydoc/Docling/OCR/XMind/EPUB/MHTML 等，多引擎 | 本地文本+Docling（PDF/Office/ODF/RTF/EPUB/图片 OCR）/ASR；**缺 XMind、MHTML** | 低价值，暂不补；需要时按 @file 新增格式即可 |
| 每文档解析引擎/参数 | 支持按批 process_config 覆盖 | 仅知识库级设置 + rebuild | 真实需求出现再做 |
| 分块策略 | 自适应三层 + 实时调试预览 | 结构感知 + 父子块 + 预览 | 已有等价能力，不重建 |
| 分块上下文头（标题面包屑入索引） | 有 | `heading` 列已存，是否入 searchText 待核 | 低价值质量项，暂不动 |
| 分块级修订历史/对比/回滚 | 有（chunk revisions + revert） | 仅文档级版本 + 回滚；**分块对比本批以文档版本 diff 覆盖** | 已用版本 diff 覆盖「改前/改后对比」诉求 |
| 分块生成问题（generated questions） | 有 | 无 | 低价值，暂不做 |
| 自动标记推荐 | 有 | 无 | 低价值，暂不做 |
| 自动打标签 | 有（LLM，可配 model/数量/跳过已标） | ❌（仅手标签） | **需要**，依赖模型网关，后续独立推进 |
| 文档自动摘要 | 有（异步 + 重新生成） | ❌ | **需要**，依赖模型网关，后续独立推进 |
| 自定义元数据（用户可编辑） | 有 | `metadata` jsonb 仅内部用 | 低价值，暂不做 |
| 全局图片画廊（跨文档按来源/描述/OCR/属性筛选） | 有 | 仅文档内图片 + 引用图 | **需要（多模态完整性）**，后续独立推进 |
| 知识图谱检索（GraphRAG） | 有（Neo4j） | ❌ | **不做**（重型依赖 + 抽取模型费用，需先有真实多跳场景） |
| Wiki 图谱可视化 | 有（overview/ego 图） | 仅文本出/入链 | **需要（Wiki 完整性）**，可基于现有 links 做可视化，后续 |
| Wiki 维护（lint/issues/rebuild-links/auto-fix） | 有 | 仅 links/diff | 低价值，暂不做 |
| 跨知识库检索 | 有（多库扇出） | 仅单库（MCP 绑定单库） | 视需求；后续可评估 |
| 检索调试/追踪时间线（5 阶段 span） | 有 | 仅 job step/progress | 低价值可观测增强，后续 |

### 2.2 存储与维护

| 能力 | WeKnora | 本仓 | 判断 |
|---|---|---|---|
| 文档版本 COW + 回滚 | 有 | ✅ | 对齐 |
| **版本改动前后对比（diff）** | 有（分块级） | 本批新增文档版本 diff | **本批已补** |
| **列表排序** | 有（updated/created/name asc/desc） | 本批新增（keyset 跨页正确） | **本批已补** |
| **批量下载/预览原件** | 有（download/batch-download/preview） | 单版本下载已有；**批量下载 ZIP 本批已补** | **本批已补** |
| 批量重解析 | 有（batch-reparse + progress） | ✅（`rebuild` 支持 documentIds + chunksOnly） | 对齐 |
| 移动/转交 | 有（move/transfer + progress） | ✅（单/批量 move；知识库复制） | 对齐 |
| 最近活动/停滞标记 | 有（lastActivity/stall） | 活动流已有；无 stalled 标记 | 低价值，后续 |
| 处理进度 span 追踪 | 有 | 仅 job step/progress | 见上 |
| 任务队列 + 死信 | 有（asynq + dead-letter） | BullMQ + 失败任务可重试 + 对账 | 对齐（无独立死信表） |
| 孤儿/清理 | 有 housekeeping | ✅（每日 cleanup + reconcile，24h 无引用回收） | 对齐 |
| 备份/恢复（含知识卷） | 仅 FAQ 导出 | ✅（`pg_dump` + 知识卷 archive + 隔离侧验恢复） | 本仓更强 |
| 索引重建 | 有 | ✅（`/bases/:id/rebuild`） | 对齐 |
| 来源同步类型 | ~17 | 14（飞书/Lark/Notion/Confluence/语雀/钉钉/IMA/Seafile/Nextcloud/GitLab/GitHub/Feed） | 基本对齐 |

## 3. 「需要哪些」判断

- **本批补（维护闭环，无重型依赖）**：列表排序、勾选批量下载原件、文档版本改动前后对比。已完成，见 §4。
- **后续补（需要模型网关，可独立推进）**：文档自动摘要、自动打标签、全局图片画廊、Wiki 图谱可视化。它们复用现有模型网关与 `knowledge_jobs` 后处理插入点，属于「完整性增强」而非主链路缺口。
- **不做（需先明确业务场景与成本）**：GraphRAG（Neo4j + 抽取模型费用）、替换存储后端、新增解析引擎。加这些之前先回答「真实触发场景是什么、依赖与运维成本多少」。
- **已具备、只差真实验收**（属验收缺口，不是功能缺口）：真实 Docling/ASR/视觉/embedding/rerank 质量、真实企业来源账号与配额。

## 4. 本批交付

- **文档列表排序**：`GET /knowledge/bases/{id}/documents` 增加 `sort`（updated/created/title）与 `order`（asc/desc），走 keyset 元组分页，跨页无重无漏；默认保持 created 降序。UI 在文档页增加排序控件。
- **勾选批量下载原件**：原生 `POST /knowledge/bases/{id}/documents/download`，按 `{documentIds}` 打包当前版本原件为 ZIP；逐份校验归属（跨库/不存在 404），同名文件追加 ` (n)` 去重，累计原件上限 256 MiB。UI 在文档页批量操作栏增加「下载」。
- **文档版本改动前后对比**：`GET /knowledge/documents/{documentId}/diff?fromVersionId&toVersionId`，复用文档版本与共享行差异算法（`packages/core/src/knowledge-diff.ts`，同时让 Wiki diff 复用同一实现）。UI 在文档检查器的版本区增加「对比版本」。
- 文档修正：`docs/ARCHITECTURE.md` §6.3 的知识库授权描述已从「不按对象做跨用户范围授权」更正为实际的对象级授权（`authorizeResourceAccess` + `ownerBusinessId` + 范围）。

## 5. 仍待验收 / 后续候选

- 本批 UI 的**真实渲染与多视口观感**需在真实栈上做视觉验收（typecheck/单测不能替代）。
- 后续四个模型依赖能力（摘要/自动打标签/图片画廊/Wiki 图谱）按需立项，各自复用现有网关与任务后处理，不引入新执行底座。
- GraphRAG 与存储/解析引擎替换维持「先场景、后成本」的门槛。
