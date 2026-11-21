# Implementation Plans

第二批 005–009 生成于 2026-11-22（基线 `90a0ad2c`）。执行前请读完整份计划，遵守其 STOP 条件，完成后更新本表状态。

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
