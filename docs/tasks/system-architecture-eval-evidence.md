# 系统架构调整分区 C：评估失败生命周期实施记录

> 实施日期：2026-10-31。契约依据：`docs/tasks/system-architecture-data-contract.md` §5、§7 分区 C、§8「eval 重启 / 重投」。
> 基线：`68241bab58ad8ec59727d70677bec790af2a5ae2`（worktree `system-architecture-modernization`）。

## 目标

- 已认领批次被 BullMQ 重投时不续跑、不重复模型花费：条件置 failed，保留已落库 results / passed。
- 所有失败路径收口到同一条件操作：processor 执行错误、最终 finish 失败、BullMQ 进入 processor 前的 deferred stalled failure。
- 最终 finish 不再吞错；provider 前失败由 failed 事件兜底。
- 保留 1 小时 reconcile 兜底，不降低阈值、不新增租约/恢复系统。

## 方案

1. `packages/db/src/repo/eval.ts` 新增 `failEvalRun`：单条 `UPDATE ... WHERE id=? AND status='running'`，只写 `status/error/finishedAt`，不写 `passed`，返回是否赢下 CAS。
2. `packages/worker/src/eval-runner.ts`：
   - claim 失败后重读批次；仍 running 且 `claimedAt` 非空 → 抛 `UnrecoverableError`（不续跑）；已终态/不存在 → 跳过。
   - 删除最终 `finishEvalRun` 的 catch 吞错，持久化失败传播给 processor。
3. 新增 `packages/worker/src/eval-job.ts`（eval-only handler seam）：
   - `runEvalJob`：解析 job、await `executeEvalRun`，catch 中先 `failEvalRun` 再抛原错误。
   - `handleEvalJobFailed`：failed 事件兜底同一 `failEvalRun`。
   - 生产 `index.ts` 与重启测试子进程共同调用，测试不复刻恢复算法。
4. `packages/worker/src/index.ts` eval 局部改为调用上述 handler；failed 事件显式 `.catch` 记录收口失败，避免 EventEmitter unhandled rejection。

## 范围

- 独占：`packages/db/src/repo/eval.ts`、`packages/worker/src/eval-runner.ts`、`packages/worker/src/index.ts`（eval 局部）。
- 新增：`packages/worker/src/eval-job.ts`、`packages/worker/test/fixtures/eval-worker-process.ts`、`packages/worker/test/eval-redelivery.test.ts`。
- 相关测试：`eval-snapshot.test.ts`、`eval-result-write.test.ts`。
- 不改 knowledge/chat/core/shared/web、其他契约、LoopX；不提交、不发布。

## 当前有效决定

- `failEvalRun` 是唯一失败收口；processor 与 failed 事件先后调用幂等，只允许 running → failed。
- 已认领重投明确失败并保留证据，不续跑；`reconcileOrphanedEvalRuns` 保持 1 小时阈值原样。
- 最终 finish 的持久化错误传播到 processor，不再只记日志。

## 步骤

- [x] 读契约 §5/§8、DEV-WORKFLOW §2、PITFALLS、现有 eval 源码与测试。
- [x] 红：新 handler/重投用例先失败（见「验证」）。
- [x] 绿：repo + runner + handler + index 接线。
- [x] 验证：真实 PG+Redis+SIGKILL 重投、现有 eval 套件、typecheck。

## 验证

### 红

- `pnpm exec vitest run --project backend --no-file-parallelism packages/worker/test/eval-snapshot.test.ts`
  → 1 failed suite / 0 test：`Cannot find module '.../src/eval-job.js'`（新行为测试先于实现存在）。
- 首次真库运行 `eval-result-write.test.ts`：6 passed / 1 failed。最终 finish 故障用例拿到的
  `DbError.message` 是 `[object Object]`（Effect 的 DB 错误是带 `message` 的普通对象）。
  修复生产侧 `errorMessage` 的消息提取后转绿，没有放宽断言。

### 绿

```sh
pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/eval-snapshot.test.ts \
  packages/worker/test/eval-result-write.test.ts \
  packages/worker/test/eval-redelivery.test.ts \
  packages/worker/test/reconcile-eval.test.ts \
  packages/worker/test/reconcile-eval-redis.test.ts \
  packages/worker/test/shutdown.test.ts \
  packages/api/test/eval.test.ts \
  packages/api/test/eval-enqueue-failure.test.ts \
  packages/db/test/eval-run-page.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-eval-final.json
```

真实结果：9 个文件，61 tests，61 passed，0 failed，0 pending/skipped。

补充回归（导入 `worker/src/index.ts` 的既有套件）：

```sh
pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/run-pending-finish.test.ts \
  packages/worker/test/run-runtime-identity.test.ts \
  packages/worker/test/memory-review.test.ts
```

真实结果：3 个文件，40 tests，40 passed（日志中的 fault injection 为既有用例预期输出）。

`pnpm typecheck`：shared / core / sandbox / db / api / worker / web 全部 Done。
`biome check`（本次改动 8 个文件）：No fixes applied。

### 真实进程退出与 stalled 重投（`eval-redelivery.test.ts`）

- 父测试创建独享随机 PostgreSQL 库与随机 eval 队列；先入队未认领的 eval job。
- 子进程 `fixtures/eval-worker-process.ts` 只装配生产 `runEvalJob` 与真实 BullMQ；仅替换模型边界：
  第一个用例标记子 run succeeded 并写入回复，第二个用例在 `waitUntilFinished` 阻塞并发 IPC ready。
- 父测试收到 ready 后断言：批次 running、passed=1、1 条结果、2 个子 run id。
- `SIGKILL` 子进程后启动替代消费者（同一生产 handler），经真实 BullMQ stalled 检测重投。
- 真实结果：批次 failed、`finishedAt` 非空、error 含 `interrupted`、passed=1、1 条结果保留、
  子 run id 集合不变、同一 agent 可再次创建评估。测试内将 lockDuration/stalledInterval
  缩短为 1s/500ms，生产默认值未改。

限制（旧阶段）：当时测试 Redis 是 backend globalSetup 的独享实例；子 run 使用共享 `agent-runs` 队列，
清理阶段按 runId 删除。若其它套件也消费 `agent-runs`，全量并行时可能互相抢 job；当前仓库没有
其它测试 worker 消费该队列。PG/Redis 不可用时该套件 skip，不能当作通过。该限制已由后文
「终审阻断修复」的独享 Redis 容器替代，当前证据以修复段为准。

## 终审阻断修复（2026-10-31）

独立 Opus 终审提出 3 个阻断：DB/infra 错误原文经 `eval_runs.error` 进入 API 成功响应与 worker
日志；两条真实失败链（BullMQ deferred stalled failure、`failEvalRun` 自身 SQL 失败）未被真实验证；
redelivery fixture 仍消费共享 `agent-runs`。发现与修复边界见
[eval 独立终审阻断](system-architecture-eval-review.md)。

本次修复范围：

- `packages/worker/src/eval-job.ts`：公开错误文案只保留 `UnrecoverableError` 领域消息，DB/infra
  落固定可操作说明；settlement 日志只留受控字段。
- `packages/worker/src/eval-runner.ts`：最终 `crashed` 同样只落公开文案；日志不序列化错误对象。
- `packages/worker/test/eval-result-write.test.ts`、`eval-snapshot.test.ts`：把泄露断言改为公开文案，
  新增真实 PG secret 故障。
- `packages/worker/test/eval-redelivery.test.ts` + fixture：改用独享 Redis 容器；新增真实
  `maxStalledCount` deferred failure 与 settlement SQL 失败 + 1h reconcile 链路。
- 新增 `packages/api/test/eval-error-redaction.test.ts`：真实 PG 故障后 list/detail/compare/export
  wire 无 SQL/params/secret。
- `packages/worker/src/index.ts` 当时未由本分区修改；日志脱敏 patch 见
  [eval 接线 patch](system-architecture-eval-integration-fix.md)。该 patch 后续已由 index
  单一写入者应用并验证，见该文「完成状态」。

### 红

修复前行为（新用例 + 临时还原原文写入）真实输出
`/tmp/agentport-architecture-eval-fix-red.json`：32 tests，26 passed，6 failed，0 skipped。

失败项：

- `api/test/eval-error-redaction.test.ts`：真实 PG 故障后 wire 仍出现 SQL/params/secret。
- `worker/test/eval-result-write.test.ts`：result insert failure 与 final finish failure 都把 DB
  原文写进 `eval_runs.error`。
- `worker/test/eval-snapshot.test.ts`：result write / settlement 仍写原始 message。
- `worker/test/eval-redelivery.test.ts`：settlement SQL 失败路径的 worker 日志仍带 secret/SQL。

### 绿

焦点范围（新增与改动测试）：

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/eval-snapshot.test.ts \
  packages/worker/test/eval-result-write.test.ts \
  packages/worker/test/eval-redelivery.test.ts \
  packages/api/test/eval-error-redaction.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-eval-fix-green.json
```

真实结果：4 files，32 tests，32 passed，0 failed，0 skipped。

完整 eval 范围（原 9 个文件 + 新增 API wire 用例）：

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/eval-snapshot.test.ts \
  packages/worker/test/eval-result-write.test.ts \
  packages/worker/test/eval-redelivery.test.ts \
  packages/worker/test/reconcile-eval.test.ts \
  packages/worker/test/reconcile-eval-redis.test.ts \
  packages/worker/test/shutdown.test.ts \
  packages/api/test/eval.test.ts \
  packages/api/test/eval-enqueue-failure.test.ts \
  packages/api/test/eval-error-redaction.test.ts \
  packages/db/test/eval-run-page.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-eval-fix-full.json
```

真实结果：10 files，64 tests，64 passed，0 failed，0 skipped。

导入 `worker/src/index.ts` 的既有回归：

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/run-pending-finish.test.ts \
  packages/worker/test/run-runtime-identity.test.ts \
  packages/worker/test/memory-review.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-eval-fix-index.json
```

真实结果：3 files，40 tests，40 passed，0 failed，0 skipped（fault injection 日志为既有预期）。

`pnpm typecheck` 全部 Done；`pnpm exec biome check` 对本次 7 个文件无错误。

### 真实验证要点

- **deferred stalled failure**：子进程用生产 `runEvalJob` 认领并阻塞，`SIGKILL` 后替代 worker
  以 `maxStalledCount: 0` 触发真实 `moveStalledJobsToWait` 写 `deferredFailure`；断言 processor
  调用次数为 0、job 以 stalled 失败、DB failed 且保留 passed/results、同 agent 可再次评估。
- **settlement SQL 失败**：真实 PG 触发器让 finish 与 fail 两个 UPDATE 都失败；processor 仍抛
  原始 DB 错误，failed 事件收口失败只记受控日志、无 unhandled；移除触发器后用真实 queue probe
  跑 1 小时 `reconcileOrphanedEvalRuns`，DB failed 为 `EVAL_LOST_ERROR`，running 唯一占用释放。
- **隔离**：`eval-redelivery.test.ts` 通过 `startRedisContainer()` 独享 Redis、`createIsolatedDatabase()`
  独立 PG，子进程与替代 worker 均指向独享 Redis；不消费 backend globalSetup 共享 Redis 的
  `agent-runs`，也未更换生产队列名或用 mock 冒充隔离。
- **API wire**：真实 PG 故障的错误对象包含 `Failed query`、`params:` 与 secret；经生产收口后
  `eval_runs.error` 为固定公开文案，list/detail/compare/export 均 200 且无 SQL/params/secret。

## 改动文件

- `packages/db/src/repo/eval.ts`
- `packages/worker/src/eval-runner.ts`
- `packages/worker/src/eval-job.ts`（新增）
- `packages/worker/src/index.ts`（仅 eval 局部；日志 patch 已由 index 单一写入者应用）
- `packages/worker/test/eval-snapshot.test.ts`
- `packages/worker/test/eval-result-write.test.ts`
- `packages/worker/test/eval-redelivery.test.ts`（新增）
- `packages/worker/test/fixtures/eval-worker-process.ts`（新增）
- `packages/api/test/eval-error-redaction.test.ts`（终审阻断修复新增）
- `docs/tasks/system-architecture-eval-review.md`（终审阻断与修复范围）
- `docs/tasks/system-architecture-eval-integration-fix.md`（index 日志 patch 已由单一写入者应用并验证）

## 当前状态与下一步

- eval 已完成：case 级 `eval_results.output` DB 原文泄露在 `eval-runner` 写入边界修复后，独立 Opus 最终复审 PASS；完整回归 14 files / 112 passed / 0 failed / 0 skipped（`/tmp/agentport-architecture-eval-outputfix-review.json`）。相对历史 108 绿增加的 4 项全部在并行更新的 shutdown 套件，其余 13 文件项数一致；目标 4 文件回归前后 SHA-256 一致。
- 原阻断全部解除：repo/processor/failed/deferred、真实 SIGKILL、独享 PG/Redis、batch error + case output + index logs 边界均通过。历史 10 files / 64、index 3 files / 40 与 108/108 均属旧阶段证据。
- `packages/worker/src/index.ts` 的 eval 接线已应用并释放，可供 runtime B 删除生命周期接线使用。
- eval 分区无待办；runtime B 与联合验证不属于本记录。未提交、未发布；主 checkout 未改动。
