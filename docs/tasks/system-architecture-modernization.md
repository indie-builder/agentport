# 系统架构现代化（技术栈最佳实践核对）

## 目标

按用户原要求检查并调整前后端技术栈的最佳实践与当前 AI 主流做法；最新明确范围是**系统架构层面**，不是表单组件细节或工具整理。

验收标准：对职责边界、API 契约、数据访问、异步任务、流式通信、SDK 文件系统六条主线给出有证据的结论；仅对确认存在的架构缺口做最小改动，并经过联合验证与独立终审。

## 方案

- 保持现有技术栈：Fastify + Zod、React + TanStack Router/Query、Drizzle、BullMQ、Claude Agent SDK。
- 硬约束：官方文件系统定义智能体是最高原则；不新增独立服务、不引入第二套智能体执行循环、不做多 worker 扩展、不为假设性风险加防护。
- 实际流程：三域 Sonnet medium 事实核对 → 前端/API 与后端数据、AI 运行分别由 Opus 冻结/裁决合同 → 各分区 Sonnet high 按合同并行实施；逐项接受/拒绝/延期以合同为准。
- 总体架构继续保留模块化单体 + API/worker 双进程 + 官方 SDK 沙盒；不追热换框架，不因审计候选扩张服务或执行循环。

## 基线与范围

- 基线：`68241bab58ad8ec59727d70677bec790af2a5ae2`；分支 `refactor/system-architecture-modernization`。
- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`，建树时与最新 `origin/main` 一致；`.loopx/` 为任务本地状态，不纳入交付。
- 实施分区在本树并行写入源码与测试；本记录只写状态与边界，不逐文件快照，最终以提交前固定 diff 为准。`.vitest/json/output.json` 的差异来自测试报告写入，不是业务改动。
- 允许改动：证据确认需要调整的前后端架构代码、对应测试与必要文档；本记录与审计汇总。
- 不触碰：另一任务 `stack-framework-adoption` 的资料与改动；`.loopx/`；用户登录配置与共享库。
- 不执行：清库、修改用户登录。
- 授权变更：2026-10-31 用户明确授权本轮提交 PR 并合并、随后收尾工作区；此前「未授权不 commit/push/merge」的状态作废，清库与用户登录配置仍不在授权内。
- 相关踩坑：新 worktree 起点须核对 `origin/main`、任务记录不写进 `.claude/worktrees/`、验证结论必须来自真实命令输出、真实容器/测试可能加载旧 `dist`。

## 当前状态

- **范围与有效决定**：仍限定系统架构六条主线；技术栈不更换；模块化单体 + API/worker + 官方 SDK 沙盒；不新增独立服务、第二执行循环、多 worker 扩展或理论防护。前端/API 已冻结契约，后端数据与 AI 运行按两份 Opus 合同逐项接受/拒绝/延期，拒绝项不实施。
- **各分区独立通过（各自范围）**：A `119 tests / 0 skip`；runtime A `115/115`（core 63 + ZIP 52）；B/C `14 files / 263 tests`、probe `7/7`、完整 web `132 files / 1600 tests`；knowledge `14 files / 206/206`；eval `14 files / 112/112`；`pnpm typecheck` 与 `pnpm build` 已过。
- **runtime B 生产行为已实现，原三项终审发现独立 PASS**：删除编排为同一 checked-out 连接持 session advisory lock → 短 tx A 取快照 → 事务外 ACK（连接保持 idle、无事务）→ 同连接短 tx B 精确重核并删除 → unlock 后按 A/B 快照 best-effort 回收目录；agent 与 conversation 两个 DELETE 及四处创建失败补偿共用该编排，两者都回收 `sdk-sessions`、`session-sandboxes`、`conversation-outputs`、`conversation-inputs` 四类目录，`agent-memory/` 与子专家/个人记忆保留。分支补偿 `22/22` PASS；真实 TCP 下控制查询 5s 截止、持锁 40s 从确认拿到锁后启动并覆盖设置恢复，经 `locks 14/14`、矩阵 `127/127` 验证；Docker 第三个完整删除编排 `3/3` PASS。
- **runtime B 终复审 PASS**：`pg_locks` 按 advisory key 跨隔离库选错连接（旧查询红 1）已限定当前库、空闲且无事务的 session 锁；`release(true)` 后异步释放等待改为有界轮询。最终 Opus 窄复核 PASS：`4 files / 41 tests / 0 failed / 0 skipped`（delete-lifecycle 14、delete-sandbox-hook 10、locks 14、真实 Docker 3），证据来自真实 TCP / PostgreSQL / Redis / Docker。
- **联合验证**：首轮 `4374 total / 4338 pass / 19 fail / 17 skip` 仅作历史一行，已被后续结果取代。第二轮 `403 files / 4382 tests / 4381 pass / 1 fail / 0 skip`，唯一失败是 MCP 取消测试的观测竞态；修复为等待 job 真实消失后，独立 `3/3` PASS、相关 `52` 项 PASS。第三轮 all3 `4383 total / 4382 pass / 1 timeout / 0 skip`，唯一 timeout 为 outputs 测试并行共享库竞态，改用独享库后 `26/26` 独立 PASS。第四轮 all4 串行与合规镜像联合 `success: true`：`403 files / 4383 tests / 4383 passed / 0 failed / 0 pending`（`/tmp/agentport-architecture-final-all4.json`）。该轮在合并 main 前启动、运行中完成合并，不能称为 merged HEAD 的精确全套结果。
- **合并后增量验证**：merged HEAD `d9a986e3be4e167f98af0d390990cf2a38cb7e07`；Opus 增量审查 PASS（2 files / 40 tests、0 failed，`/tmp/agentport-architecture-merge-review.json`），覆盖专家摘要与权限接口；合并后删除编排定向补验 `3 files / 33 passed / 0 failed / 0 pending`（`/tmp/agentport-architecture-merged-cross.json`，命令 `pnpm exec vitest run --project backend packages/api/test/delete-lifecycle.test.ts packages/db/test/delete-sandbox-hook.test.ts packages/core/test/effect-runtime.test.ts --no-file-parallelism`）；全仓 `pnpm typecheck`、`pnpm build`、`lint:contract`、`lint:focus` 通过。未运行付费模型，未使用 CI。
- **SDK 16**：使用已有合规镜像 `SANDBOX_IMAGE=agentport/sandbox:runtime-env-bash-20261029` 与当前 shared/sandbox 独占产物，fake 模型验证 `16/16`，0 付费；不修改默认老 dev 镜像。
- **结论**：各分区独立验证、最终窄复核与 all4 联合均已 PASS，runtime B 生产行为已有真实 TCP / PostgreSQL / Redis / Docker 证据；合并后增量审查通过，merged HEAD 未重跑全量套件。已获授权提交 PR 并合并，发布与工作区收尾由主会话执行；本记录不预填 PR 号、合入或清理结果。

## 有效决定（保留）

- 范围限定为系统架构层：职责边界、API 契约、数据访问、异步任务、流式通信、SDK 文件系统。技术栈不更换；原生/官方能力优先，现有实现优先复用或按最佳实践改造。
- 前端/API 契约已由 Opus 冻结，以 [架构契约](system-architecture-modernization-contract.md) 为准；响应只投影公开字段，SDK session/message UUID、fork 锚点等内部状态不出 wire；`content`/`uiState` 不裁剪，日期显式 ISO。
- 流式语义以 `onopen` 为健康起点；未连上、报错与断线仍回读，保留 observer、取消 invalidate、服务端终态补偿与独立审批轮询。
- 显式退出同时清 Query、Zustand 与聊天 sessionStorage，并递增 `accountEpoch` 关流；同账户 401/改密重登保留草稿，换业务身份先 reset。
- 后端数据合同接受 cron 可调度校验、逐来源隔离、创建/终态原子性与三入口复用既有锁；拒绝评估自动续跑、把孤儿阈值改为 5 分钟及新扫全表/outbox/持久终态意图/心跳租约；`ops` scheduler `onClose` 与 retrieval 无引用导出延期，不夹带。
- 运行合同接受 R1、R2、R4 声明修正与 R5 生命周期；拒绝 R3 init fail-closed、全代理化、删 `timeoutMs` 或自造委派计时器；R6 绝对路径候选撤回。删除生命周期按 [runtimeB revision](system-architecture-runtimeB-revision.md) 实现。
- 删除编排固定为短 tx A → 事务外 ACK → 同连接短 tx B，控制查询 5s、删除持锁 40s；B 提交前失败保留实体与全部目录，B 提交后 unlock/reset 失败不能伪装回滚，rm 为 best-effort；全局绑定锁在 ACK 窗口短时挡住其他准入/绑定修改/记忆操作，是已接受并记录的代价。
- 原生 MCP 上游长期 secret 的信任边界按 D-76 保持不变，不做统一代理改造。
- runs 分页仍延后；不扩组件表单工具、不把大 chunk 警告列为本轮架构缺陷。
- LoopX goal `system-architecture-modernization` 配 agent `architecture-controller`，仅本会话最长 7 天；任务完成即撤。

## 已替代结论

- runtime B 旧 `174/174` 与真实 Docker `3/3` 属于旧事务回调实现，不能作为修订通过证据；修订后以 short-tx、deadline、Docker 新编排与测试边界证据为准。
- 联合首轮的 `19 fail / 17 skip` 已被第二轮 `1 fail / 0 skip` 取代；首轮只保留历史记录，不重复套件级失败清单。
- 测试报告里的 `testResults` 是文件数，不是 suite 数；B/C 为 `14 files / 263 tests`，完整 web 为 `132 files / 1600 tests`，历史 `414`/`416` 不作为文件数使用。
- 早先 backend 基线 40 项全 skip 已由配置修复后的真实连接重跑覆盖；skip 从未计为通过。
- A7 绝对路径候选已撤回：模板路径常量已含 `/`，实际生成 `//mnt/...`、`//workspace/...`，不是相对 Read 漏洞；A3 是 init 列表完整性候选被拒绝，不是「空目录」问题。
- 「runtime A 相关失败待查」已确认为既有 macOS `/var` 符号链接路径问题；仅进程级 `TMPDIR` 换到真实 `/private/var` 后两项定向用例通过，不改安全检查。
- 默认 Vitest reporter 会写已跟踪的 `.vitest/json/output.json`；后续命令统一改用 `/tmp` 输出。

## 步骤

- [x] 三域事实审计返回：前端/API、后端数据与异步任务、AI 运行边界。
- [x] 前端/API 事实经 Opus 独立核实，2026-10-31 冻结方案与改动边界，详见架构契约。
- [x] 已派 Sonnet high A、B/C 两个无共享文件的分区并行实施。
- [x] 后端数据与 AI 运行候选分别交 Opus 核实；两份合同已返回逐项接受/拒绝/延期结论，映射见审计汇总。
- [x] 前端 A 按契约实现并通过其范围红绿、相关回归与静态检查，独立 Opus 终审 PASS（119/119、0 skipped）。
- [x] B/C 完成实施并最终通过独立 Opus 定向复审（14 files / 263 tests、probe 7/7、完整 web 132 files / 1600 tests），浏览器隔离验收通过。
- [x] eval 分区最终独立 Opus PASS（14 files / 112/112、0 failed、0 skipped）。
- [x] runtime A 的 R2 阻断修复并定向复审通过（115/115、core 63 + ZIP 52、0 skipped）；R1/R4/UI PASS 保留。
- [x] knowledge 缺口补齐完成，独立 Opus PASS（14 files / 206/206、0 skipped）。
- [x] runtime B 短 tx 删除编排、事务外 ACK、同连接 session advisory lock 与四处补偿调用迁移完成；分支补偿 `22/22`、deadline `locks 14/14` + 矩阵 `127/127`、Docker `3/3` 独立 PASS。
- [x] runtime B 测试边界修复（本库 PID 选择、异步锁释放等待）后的最终 Opus 窄复核 PASS（`4 files / 41 tests / 0 failed / 0 skipped`，真实 TCP / PostgreSQL / Redis / Docker）。
- [x] all4 完整串行联合与合规镜像：`success: true`，403 files / 4383 tests / 4383 passed / 0 failed / 0 pending；在合并 main 前启动，非 merged HEAD 精确全套。
- [x] 合并后 Opus 增量审查 PASS（2 files / 40 tests、0 failed），全仓 typecheck/build 与 lint:contract/focus 通过。
- [x] 用户已明确授权提交 PR 并合并；提交与合并动作由主会话执行。

## 改动文件

- 契约与证据：[架构契约](system-architecture-modernization-contract.md)、[数据契约](system-architecture-data-contract.md)、[运行合同](system-architecture-runtime-contract.md)、[runtimeB revision](system-architecture-runtimeB-revision.md)、[short-tx](system-architecture-runtimeB-shorttx-evidence.md)、[branchfix](system-architecture-runtimeB-branchfix-evidence.md)、[deadlinefix](system-architecture-runtimeB-deadlinefix-evidence.md)、[integration](system-architecture-integration-regressions.md)、[reconcile](system-architecture-reconcile-regression.md)。
- 源码与测试由 A、B/C、eval、runtime A、knowledge、runtime B 分区在本树写入，以提交前固定 diff 为准；本记录不逐文件登记。
- 本轮文档收口只改 `docs/ARCHITECTURE.md` §7 评估状态、本记录与[审计汇总](system-architecture-audit.md)；不源码、测试、其他 evidence、LoopX 或 Git。
- `.vitest/json/output.json` 为测试运行副产物，不是业务改动。

## 下一步

- 验收已完成：all4 联合与合并后增量审查均有真实输出；发布由主会话执行，记录随实际 PR/合并状态更新。
- 最终 PR 正文中的联合验证数字以 all4 真实输出为准，并注明该轮在合并 main 前启动；merged HEAD 以增量审查与 typecheck/build/lint 为依据，不冒充全量套件。
- 用户已授权提交 PR 并合并，随后按 DEV-WORKFLOW §2-7 收尾工作区；主会话执行 Git 动作，本记录不代替验证证据。

## 验证

2026-10-31 本树真实证据汇总。基线数字只说明实施前行为，不能充当改后验收。

| 范围 | 结果 | 状态 | 报告/说明 |
|---|---|---|---|
| 实施前基线 | `pnpm typecheck`、`pnpm build`、`lint:contract`、`lint:focus` 通过；web 6 files / 130；backend 3 files / 40；core 3 files / 66；jobs 6 files / 53 | 基线 | `/tmp/agentport-architecture-{backend-baseline-connected,core-baseline,jobs-baseline}.json` |
| A（前端/API） | 119/119、0 skipped；timeout UI 48/48、web build 通过 | 独立 Opus PASS | `/tmp/agentport-architecture-A-review.json`；[A 证据](system-architecture-A-evidence.md) |
| B/C | 14 files / 263 tests、0 skipped；probe 7/7；完整 web 132 files / 1600 tests | 独立 Opus PASS | `/tmp/agentport-architecture-BC-identityfix-review.json`、`...-review-probe.json`、`...-green-web-full3.json` |
| knowledge | 14 files / 206/206、0 failed / 0 skipped | 独立 Opus PASS | `/tmp/agentport-architecture-knowledge-gapfix-review.json` |
| eval | 14 files / 112/112、0 failed / 0 skipped | 独立 Opus PASS | `/tmp/agentport-architecture-eval-outputfix-review.json` |
| runtime A | 115/115（core 63 + ZIP 52）、0 skipped；原始 `START` 正文严格相等 | 定向 Opus PASS | `/tmp/agentport-architecture-runtimeA-r2fix-review.json`；[runtime A 终审](system-architecture-runtimeA-review.md) |
| runtime B 分支补偿 | 22/22、0 failed / 0 skipped | 独立定向 PASS | `/tmp/agentport-architecture-runtimeB-branchfix-review.json`；[branchfix 证据](system-architecture-runtimeB-branchfix-evidence.md) |
| runtime B 截止/Docker | locks 14/14、矩阵 127/127、Docker 3/3 | 生产行为独立 PASS | `/tmp/agentport-architecture-runtimeB-deadlinefix-green-{locks,matrix,docker}.json`；[deadlinefix 证据](system-architecture-runtimeB-deadlinefix-evidence.md) |
| runtime B 终复审测试边界 | 旧查询红 1（跨库同 key）；修后 4 files / 41 tests / 0 failed / 0 skipped | 最终 Opus 窄复核 PASS（真实 TCP / PostgreSQL / Redis / Docker） | `/tmp/agentport-architecture-runtimeB-testboundary-{red,green}.json` |
| 联合首轮（历史） | 4374 total / 4338 pass / 19 fail / 17 skip | 已被后续结果取代 | `/tmp/agentport-architecture-final-all.json` |
| 联合第二轮 | 403 files / 4382 tests / 4381 pass / 1 fail / 0 skip；唯一失败为 MCP 取消观测竞态，修复后独立 3/3、相关 52 项 PASS | 未通过，已被 all3 取代 | 未记录报告路径 |
| 联合第三轮（all3） | 4383 total / 4382 pass / 1 timeout / 0 skip；唯一 timeout 为 outputs 并行共享库竞态，独享库修后 26/26 PASS | 已被 all4 取代 | 未记录报告路径 |
| 联合第四轮（all4） | 403 files / 4383 tests / 4383 passed / 0 failed / 0 pending，`success: true` | 通过；在合并 main 前启动，非 merged HEAD 精确全套 | `/tmp/agentport-architecture-final-all4.json`；命令 `SANDBOX_IMAGE=agentport/sandbox:runtime-env-bash-20261029 rtk bypass pnpm exec vitest run --no-file-parallelism --reporter=json --outputFile=/tmp/agentport-architecture-final-all4.json` |
| 合并后增量审查（merged HEAD `d9a986e`） | 2 files / 40 tests / 0 failed | Opus 增量审查 PASS；未重跑全量套件 | `/tmp/agentport-architecture-merge-review.json` |
| 合并后删除编排定向补验（merged HEAD `d9a986e`） | 3 files / 33 passed / 0 failed / 0 pending | 定向补验 PASS | `/tmp/agentport-architecture-merged-cross.json`；命令 `pnpm exec vitest run --project backend packages/api/test/delete-lifecycle.test.ts packages/db/test/delete-sandbox-hook.test.ts packages/core/test/effect-runtime.test.ts --no-file-parallelism` |
| SDK 16 | 16/16（`SANDBOX_IMAGE=agentport/sandbox:runtime-env-bash-20261029`，当前 shared/sandbox 独占产物，fake 模型 0 付费） | 替代证据，非付费模型验收 | `/tmp/agentport-architecture-final-skips-session-sandbox-sdk.json` |
| 静态检查 | `pnpm typecheck`、`pnpm build`、`lint:contract`、`lint:focus` 通过 | 通过 | 无单独报告；合并后 latest HEAD 已复核 |

补充说明：

- 测试报告里的 `testResults` 是文件数，不是 suite 数；上表 files 与 tests 分开记录。
- runtime B 已知限制：全局绑定锁在 ACK 窗口会短暂挡住其他专家准入/绑定修改/记忆操作；B 提交后 unlock/reset 失败不能声称可回滚；rm 失败保留 best-effort 语义。详见 [short-tx 证据](system-architecture-runtimeB-shorttx-evidence.md)。
- 未执行付费模型或 LoopX 操作；all4 为合并 main 前启动的串行联合结果，merged HEAD 另有增量审查与静态检查，不能互相替代。
