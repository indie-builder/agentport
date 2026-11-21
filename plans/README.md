# Implementation Plans

第三批 010–016 生成于 2026-11-22（基线 `321cf491`）。执行前请读完整份计划，遵守其 STOP 条件，完成后更新本表状态。

## 第三批（2026-11-22）

基线 `321cf491`。推荐顺序：010（安全，S）→ 015（收敛，S）→ 016（死代码，S）→ 013（知识批量，S）→ 014（wake 幂等，S）→ 011（模型代理查询合并，S）→ 012（测量，S）。除 011 与 012 都触及产出/模型路径外，其余互不共享文件，可并行。

> 执行状态：010–016 已按用户「按你建议来处理」全部实施，基线为 `5c4b97db`，经多轮独立 Opus 复核后交付。012 的测量结论为 `optimize`（整轮 p95 ≈ 466ms，瓶颈是每 manifest 两次 `trustedPath`），优化计划留待单独授权，未在本批实施。

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
|------|-------|----------|--------|------|------------|--------|
| 010 | 用内部系列键承载图表数据与样式，阻断类别名进入 CSS | P1 | S | LOW | — | DONE |
| 011 | 合并模型代理每次调用中重复的 run 查询 | P1 | S | MED | — | DONE |
| 012 | 测量产出搜索的 manifest 扫描成本，再决定是否优化 | P2 | S | LOW | — | DONE |
| 013 | 知识批量操作改为批量取数，消除逐条查询 | P1 | S | LOW | — | DONE |
| 014 | 频道 wake 通知按 CAS 结果发布，消除重复系统消息 | P2 | S | MED | — | DONE |
| 015 | 收敛 readCapped 语义、isRecord 副本与环境变量文档 | P2 | S | LOW | — | DONE |
| 016 | 删除零引用的 repo 导出与 Me 类型别名 | P3 | S | MED | — | DONE |

实施偏差记录：

- 010：为保留图例排序，XY/饼图图例增加按原始标签的 `itemSorter`；散点图使用内部键并在提示框显式显示轴名。
- 013：批量取数保留了逐项 64MiB 检查与逐项错误语义；标签 `add`/`remove` 改为逐项读取当前标签，避免覆盖后台自动打标写入；`replace` 不额外读。
- 016：`memorySha256`、`updateProgress`、`replaceRanges` 按计划保留；`changeOwnPassword`、`listReadableDocuments`、`rollbackWikiPage` 在后续 cleanup 轮次因生产零引用删除，wiki 回滚能力由 API use-case 保留，相应测试断言已删除或改名。

第三批依赖说明：

- 010 改 `openui/components/charts.tsx` 与 `ui/chart.tsx`：源头改用内部系列键，样式入口再加安全键名过滤；`openui-chart-ui.test.ts` 覆盖中文类别与重复系列名。
- 011 只合并重复查询；预算、审批目的地、内容策略、端点校验与凭证解密保持每请求执行。
- 012 只做本地测量并给出结论，不改生产代码；若判定需要优化，再另写 017，缓存命中必须仍能发现 manifest 损坏与路径变化。
- 013 跨 db + api，用现有知识库套件验证；内容读取保留逐次累计的 64MiB 实际字节上限。
- 014 选择「CAS 胜者才通知」，语义从至少一次变为至多一次；评审需确认这个取舍。
- 015 的 `readCapped` 截断选项要保持 `generated.ts` 现有静默截断行为，不能改成抛错。
- 016 删除测试专用导出；逐块检查断言，保留造数据/验证其他行为的测试；任何符号出现非测试调用方都必须 STOP。

## 第三批审计：已核实但不立项（勿再报）

- **E2E 明文管理员默认凭据**（`e2e.config.ts:51`、`scripts/e2e-channel.ts:67`）：`docs/OPERATIONS.md:703` 已写明这是本地 E2E 默认值及覆盖方式，属测试夹具约定，不是部署凭据。
- **`ci:e2e` 不包含 execution/channels/governance/model-security-ops**：这些套件需要专属隔离栈，`docs/OPERATIONS.md` 已分列入口；并入会加重本地 CI，与项目偏好冲突。
- **catch-up jobId 固定导致 3 次 claim 前失败后不再重试**（`packages/worker/src/scheduling/scheduler.ts:366-376`）：需要连续 3 次 claim 前失败，低频边界，暂不立项。
- **knowledge/data_domain run token 不检查 run 状态**（`packages/api/src/modules/servers/mcp-endpoint.ts:22-31`）：需要 token 外泄加崩溃/清理失败，属理论纵深防护，暂不立项。
- **3000 行硬门 vs 文档 500 行软上限**（`scripts/check-file-lines.mjs:4`、`docs/ARCHITECTURE.md:112`）：软上限与硬门互补，不算缺陷。
- **测试中的固定 sleep**（`packages/api/test/channels-resilience.test.ts:304` 等）：无真实 flake 证据，暂不立项。
- **未审计范围**：`packages/sandbox` 运行时内部与 Docker 生命周期、依赖公告（`bun audit` 因镜像 registry 404 未完成）、真实性能测量与 EXPLAIN。

## 第三批审计：已核实但未建计划（按需再排）

- 性能：消息搜索用 `strpos(lower(regexp_replace(...)))` 且无表达式/GIN 索引（`packages/db/src/repo/chat/search.ts:76-90`，需先 EXPLAIN 实测）。
- 技术债：知识 blob 存储两份实现且已漂移（`api/src/modules/knowledge/service.ts:127`、`worker/src/knowledge/ingestion.ts:284`）。
- 文档：`docs/ARCHITECTURE.md:115` 说 SQL 只在 `@agentport/db`，与 api/worker 模块内直写 SQL 的现状及 `packages/db/AGENTS.md` 冲突，需要维护者选择改文档还是迁查询。
- 并发：审批决策事务持 `agent_runs FOR UPDATE` 期间等待 Redis（`packages/api/src/modules/servers/approval-policy.ts:146`、`packages/db/src/repo/channel-approvals.ts:144-162`、`runs.ts:934`），会改变「取消优先」语义，需单独设计。
- 方向：在线 + 轨迹评估（C3）、审计合规增强（C2）、记忆子系统三个未闭环缺口（嵌套主题文件可见性、SDK 直写不进账本、手工编辑缺旧稿基线）。自动进化已在 `docs/research/capability-comparison-2026-11-14.md` 明确不做。

## 第二批（2026-11-22）

基线 `90a0ad2c`。推荐先做 007（验证门），再做 005 / 006 / 008（相互独立、可并行），最后做 009。

| Plan | Title | Priority | Effort | Risk | Depends on | Status |
|------|-------|----------|--------|------|------------|--------|
| 005 | 上限化 worker 对沙盒可控数据的读取（产出 / 图片解码 / fork 转写） | P1 | M | MED | — | DONE |
| 006 | 分页游标携带排序键，消除重复页与 runs 游标 400 | P1 | M | LOW | — | DONE |
| 007 | 本地 CI 先 typecheck 后 build，消除两个 `tsc -b` 并发写 | P1 | S | LOW | — | DONE |
| 008 | 首次入库失败后允许重解析手工文档 | P1 | S | LOW | — | DONE |
| 009 | FAQ 导入对话框改为批量取数，消除逐条请求风暴 | P2 | M | MED | — | DONE |

第二批依赖说明：

- 007 独立，但建议最先做：先让本地门禁可信，后续计划的结果才有意义。
- 005 / 006 / 008 相互不共享文件，可并行执行。
- 009 触及 contract + api + web，风险最高，建议最后单独做并做视觉验收。
- 006 的 e2e 回归需要可用的本地栈；栈不可用时按 STOP 报告，不得宣称通过。

## 通用验证命令（来自本仓库 recon，勿臆造）

| 用途 | 命令 | 成功判据 |
|---|---|---|
| 单包类型检查 | `bun run --filter @agentport/<pkg> typecheck` | exit 0 |
| 后端测试（bun:test，需 Docker PG/Redis） | `bun run test -- packages/api/test/<file>.test.ts` | 全绿、0 skip |
| 前端测试（vitest + jsdom + MSW） | `bun run test:web` | 全绿 |
| 格式化/规范检查（只读） | `bunx biome check <paths>` | 0 error |
| 焦点/边框契约 | `bun run lint:focus` | 退出 0，输出「校验通过」 |
| 项目契约 | `bun run lint:contract` | `project contract OK` |
| 文档链接与锚点 | `bun run lint:docs` | `docs navigation OK` |

> 注意：先构建共享包再跑后端测试（`bun run --filter @agentport/shared --filter @agentport/core --filter @agentport/db build`），否则测试加载的是旧 `dist`（见 `docs/PITFALLS.md`「workspace 包导出指向 dist」）。

## Findings considered and rejected（勿再报）

- **全局 `Bun.serve({ idleTimeout: 0 })`**：`docs/PITFALLS.md` 明确记录为有意设置（Bun 默认空闲超时会在途请求被断），非缺陷。
- **数据表格列设置“移动错列”**：误读——`reorderColumns()` 自身过滤 `locked` 列，索引空间与 `draggable` 一致，无 bug。
- **频道 SSE 逐事件鉴权**：PITFALLS 要求回放中逐事件复核撤权，不能改为逐页检查；非缺陷。
- **限流 Redis 重连→503**：未验证 Bun 客户端重连语义，不建议擅自 fail-open。
- **compose 弱口令 / API `0.0.0.0:3000`**：DB/Redis 已绑 loopback，属单机本地边界；未擅自要求改监听/轮换。
- **空 slug 清理 `rm`、知识 blob 入队失败泄漏、重试消息 ID 变动**：仅代码模式、缺实际误删/可见性证据，降级为待测候选，不列入本批计划。

## 第二批审计：已核实但不建计划（勿再报）

- **「入队后审计失败会回删文档」不成立**：`repo.audit.writeAudit` 内部 catch 后只 warn（`packages/db/src/repo/audit.ts:137-147`）；`enqueueKnowledgeJobAfterCommit` 同样吞错（`packages/api/src/modules/knowledge/service.ts:41-50`）。`manual-documents.ts` / `faq.ts` 的 catch 只可能在 enqueue 之前失败时触发，删除文档是正确回滚。原审计 #5 撤回。
- **新知识发布生命周期与共享 blob 回滚缺测试**：仓库规则禁止未经指示新增单测/集成测试；如需覆盖可单独授权。
- **`AGENTS.md` 的 “Highest priority / takes precedence” 措辞**：仓库所有者的自定规则，不作为 prompt-injection 发现。
- **D-91（知识包恢复草稿）/ D-92（知识变更审计原子性）**：已在 `docs/DECISIONS-PENDING.md` 登记，按待决策处理，不重复立项。
- **memory-review 列表整段读会话**：未复测，按项目规则不报。
- **`0.0.0.0:3000` 暴露 / `TRUST_PROXY=1` 信任任意来源 XFF**：单机部署边界已在上轮否决；本轮只把后者列为低优先级候选，未立项。
- **依赖审计**：`bun audit` 17 条（2 high / 11 moderate / 4 low）。直连服务器栈 `hono@4.13.19` 已高于修复线（4.13.16）；`@hono/node-server`、`body-parser`、`esbuild` 不在 Bun 运行时路径；其余为传递依赖与 dev 链。无可达高危，不立项。
- **未审计范围**：`packages/sandbox` 运行时内部与 Docker provider 生命周期、真实性能测量、新模块逐条 authz 穷举。后续如需可单开审计。
- **D-15 / PROJECT-BRIEF §9.4 的 @bull-board 表述、文档 pnpm 残留**：已核实为已解决或历史记录；D-15 与 §9.4 均已标注现行只读 Bull Board 实现，现行文档的 pnpm 指令已改为 Bun。勿再报。

## 第二批发现中未立项的候选（按需再排）

- 安全低优先：模型代理用 `runId` 作 Bearer（`worker/src/model-proxy.ts:510`）；导入专家的 stdio 连接器在运行时自动执行（`api/src/modules/agents/package.ts:1121` + `sandbox/src/runner.ts:503`）；频道 SSE 无 `onerror`（`web/src/lib/use-channel-stream.ts:76`）；频道 wake 遇终态 run 静默丢弃（`api/src/modules/channels/wakes.ts:188`）；关停 `stop(true)` 无 catch（`api/src/index.ts:57`）。
- 性能候选：全局搜索每次防抖扫 50 会话（`api/src/modules/search/outputs.ts`）；Wiki 反向链接全库扫描（`use-cases/wiki.ts:377`）；运行详情 3 组 2s 轮询；日程列表每行一次 Redis 读；`zipSync` 在事件循环上。
- 技术债/DX/文档：ZIP 编解码跨域（`package-zip.ts`）；`canonicalJson` 4 份；`rethrowConflict` 5 份且 wire code 不一致；README 模型凭证回退分支不可达。
- 方向：记忆/规则编辑缺 `expectedUpdatedAt` 且嵌套主题文件不可见；自动进化的 PRODUCT/ARCHITECTURE 矛盾待决策。

## 已列入但尚未建计划的候选（后续按需）

- 性能测量候选：运行详情无界 + 2s 轮询；记忆审核列表整段读会话（**既有审计称实测非问题，须先复测**）；`listServers` 每次解密全部 secret；knowledge 包导入请求内同步 CPU。
- 安全候选：OpenUI 来源链接 scheme 白名单（需先核对 React/CSP 处理 `javascript:`）；知识图片内联返回且接受 SVG。
- 一致性/技术债：`isPgCode` 两份实现；`cn` 双导入口径；三个超大前端文件（agent-editor / knowledge-faq / memory-review）。
- DX/文档：src 范围 Biome 39 error（26 为可自动修的 organizeImports）。
