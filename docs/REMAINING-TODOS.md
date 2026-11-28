# 剩余待办清单

> 最后更新：2026-11-29（项目级待办唯一来源；单任务进度不写进本文件）。
> 已完成项已收拢至文末「已完成摘要」，详见 `CHANGELOG.md` 与 Git 历史。

## P0

- **WeKnora 知识库剩余外部验收与旧默认库阻塞**：管理/版本 COW、FAQ、Wiki、统一检索/MCP、来源撤权、ZIP、离线评估、ASR 与 9 种新增来源的本地实现已由 [PR #127](https://github.com/indie-builder/agentport/pull/127) 合入 `main`（`f93c276`），`agentport_business_e2e_dataset` 已应用 `0046`。剩余阻塞：
  - 主 `.env` 指向的旧 `agentport` 库因历史漂移（`0043` 失败）保持原样，清库重建仍未授权。
  - 外部验收未完成：真实 Docling / ASR / 视觉 / 语义质量、企业账号与 GraphRAG（需 Neo4j / 模型费用）；生产发布、清库重建与付费真实模型仍未授权。
- **上下文记忆真实付费模型验证与 5 项未覆盖缺口**：专家原生 auto-memory、个人偏好（DB 权威 + `_users/<sha256(businessId)>/CLAUDE.md` 只读投影 + `UserPromptSubmit` 每轮注入）、子智能体独立记忆（`50ae93e4`）、记忆提案与主题经验升级（官方主题文件 + 短索引、双文件采纳/回滚、来源归因、独立记忆 ZIP 下载）均已实现并通过真实容器 + 官方 SDK + 本地假模型及浏览器主路径验收。剩余未完成：
  - 付费真实模型的归纳质量、跨 run 召回、续聊刷新与应用效果仍未审计（见 [USER-STORIES.md](USER-STORIES.md)）。
  - 有效公开分享页除图片与 PDF 外的其他格式真实文件浏览器验收未完成；自动进化未做。
  - 已识别 5 项未覆盖缺口：
    1. 运行时原生文件工具允许嵌套主题文件，但 API/UI 仅支持平铺；
    2. SDK 原生直接写入不进入版本账本；
    3. 专家文件与规则手工编辑缺少旧稿基线保护；
    4. 父会话的子智能体材料不能回顾到子专家；
    5. 运行保留期清理会影响记忆提案来源证据。
- **结果自检**：现有评估跑批以文本匹配与评判为主，智能体是否按目标核验自身产出尚未审计。

## P1

- **环境与覆盖缺口**：
  - 知识库 E2E 仍缺 seed。
  - 共享 `agentport/sandbox:dev` 旧镜像仍缺 GNU bash（此前受影响的 SDK 10/10 用例在独立镜像 `agentport/sandbox:redesign-validation-642ddc7d` 验证通过，但未覆盖旧 `agentport/sandbox:dev`）。
  - 付费真实模型链路（含子智能体自有 MCP 真实模型工具调用、多问题/多选澄清提问组合、凭证跨流式帧显示）尚未端到端验收。

## P2

- **桌面首次用户 QA 后续项（2026-10-28）**：会话有消息后缺少当前专家身份、会话标题为首条消息截断、资源导航名称过长、空会话操作禁用提示、停止无输出后仍显示「等待回复」、专家下拉退场残影需实测归因（共享库机器名专家属数据环境因素，不自动改名；移动端按用户要求排除）。
- **UI 零散遗留**：`index.html` favicon 仍为 `brand.gif` 待替换；真实读屏 / iOS / 原生 200% 缩放未覆盖。
- **SDK 层子智能体深度硬限制（延后）**：SDK 本身不提供深度参数；单层约束已由 API 父子校验 + 子智能体 `disallowedTools` 含 `Agent` 保证，硬限需自研，保持延后。

## 暂缓与候选

> 原实施计划目录已删除：001–003 已合入（#396 `46d043f3`、#397 `555cd699`、#398 `c7383a0d`）；004 暂缓。

### 暂缓：生成式 MCP 长期 token 加密/哈希存储（原 plan 004）

- **暂缓理由**：Phase 0 调查确认沙盒 `.mcp.json` 用按 run 的短期 token（`packages/worker/src/index.ts:157-158`），长期 `config.mcpToken` 只服务平台自测与文档所述的外部 Host 回退；仓库内无外部 Host 实际使用证据，且 D-21「暂不对外」、DB 绑 loopback、单机部署。改造需迁移约 10 个直接 `select config->>'mcpToken'` 的测试并写回填脚本，风险/成本高于现实收益。
- **重启条件**：确认有外部 Host 在使用长期 token，或备份会离开本机。
- **重启后先做**：Phase 0 只读复核全部 `config.mcpToken` 读写点与外部 Host 使用结论；再在方案 A（仅加密落库，`mcpTokenEncrypted`）与方案 B（哈希校验 + 加密取回，与分享 token 一致）之间取得维护者明确选择。**未确认前不得修改存储与鉴权路径。**
- **STOP 条件**：在 `packages/worker` 或 `packages/core` 发现读 `config.mcpToken`（说明沙盒路径也依赖它）；回填脚本无法确定目标库/密钥来源，或目标库非本次隔离实例；测试改动需要放宽鉴权或删除断言才能变绿。
- **维护备注**：若 D-21 翻转为对外或引入外部 Host，需重新评估长期 token 的加密存储与轮换策略，并与按 agent 发 token 方案对齐。

### 已列入但尚未建计划的候选（后续按需）

- **性能测量候选**：运行详情无界 + 2s 轮询；记忆审核列表整段读会话（**既有审计称实测非问题，须先复测**）；`listServers` 每次解密全部 secret；knowledge 包导入请求内同步 CPU。
- **安全候选**：OpenUI 来源链接 scheme 白名单（需先核对 React/CSP 处理 `javascript:`）；知识图片内联返回且接受 SVG。
- **一致性 / 技术债**：三个超大前端文件（`agent-editor` / `knowledge-faq` / `memory-review`）。
- **测试类型检查补齐**：`tsconfig.tests.json` 已覆盖 `shared`/`contract`/`core`/`sandbox`（63 文件）与 `packages/db/test`（2026-11-29 纳入）；剩余 `api`（共 166 文件，68 文件 / 215 处报错）、`worker`（共 106 文件，46 文件 / 285 处报错）、`web`（共 164 文件，96 文件 / 428 处报错），3 个包共 436 个测试文件待按波次清零并接入 `ci-planner.ts`。

## 已考虑并否决（勿再报）

- **数据表格列设置「移动错列」**：误读——`reorderColumns()` 自身过滤 `locked` 列，索引空间与 `draggable` 一致，无 bug。
- **限流 Redis 重连→503**：未验证 Bun 客户端重连语义，不建议擅自 fail-open。
- **compose 弱口令 / API 监听 `0.0.0.0:3000`**：DB/Redis 已绑 loopback（见 `docs/SECURITY.md` C1）；API 监听边界属单机本地部署，未要求改监听或轮换。
- **空 slug 清理 `rm`、知识 blob 入队失败泄漏、重试消息 ID 变动**：仅代码模式、缺实际误删/可见性证据，降级为待测候选，不再单列。
- 全局 `Bun.serve({ idleTimeout: 0 })` 与频道 SSE 逐事件鉴权已在 `docs/PITFALLS.md` 记录，非缺陷，不在此重复。

---

## 已完成摘要（详见 `CHANGELOG.md` 与 Git 历史）

- **智能体执行与工作台交付**：原生任务清单进度（PR #96）、会话产出查看与不可变版本快照（D-67）、图片原生预览（PR #121）、PDF 原生预览（PR #123）、原生澄清提问（D-68）、聊天附件输入（D-69）、运行中补充指令（`run_instructions`）、子智能体自有 MCP 接通与技能 `references` 读取放行、任意用户消息分支 UI、`/api/overview` 查询合并（`f733d08`）、统一列表分页（[PAGINATION.md](PAGINATION.md)）、原计划 001–003（PR #396–#398）。
- **质量、安全与文档基线**：全量回归与 20 条用户故事首轮验收、空库部署演练、UI/UX 10/10 审查（见 `docs/archive/UI-UX-REVIEW.md`）、真实部署安全验收与 `SANDBOX_EGRESS` 收敛、死代码与幻影配置清理、全仓 Biome 错误清零（PR #859）及文档口径同步（含 D-15 / `PROJECT-BRIEF.md §9.4`）。
- **原 50 条已判定完成 / 过时项**：前端与视觉（12 条）、安全与运行（13 条）、定义/评估与探索（11 条）、运维与交付（14 条）均已归档，不再跟踪。
