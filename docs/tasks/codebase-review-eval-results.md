# 评估结果持久化与子 run 关联修复

## 目标

修复两个已复现的 eval bug：

- **Bug1**：`executeEvalRun` 在 `addResult` 之前就 `passed += 1`，而 `addResult` 失败只被 catch 后 log，批次仍按成功收口，出现 `status=succeeded / passed>0 / eval_results=0`。验收：只有结果真正落库后才计 passed；持久化失败传播到现有 outer failure 收尾，批次 `failed` 且 `error` 保留；单个 case 的业务失败（run 失败或判定不通过）仍记录并继续；取消守卫优先；不增加重试运行，避免重复计费。
- **Bug2**：`runOneCase` 创建子 run 后，在 failed/cancelled/timeout/队列等待失败路径上 `Effect.fail`，调用方只在成功返回后赋值 `runId`，结果 `runId=null`，丢失可追踪关联。验收：创建后的真实 runId 穿过所有失败路径；创建前失败仍为 `null`；用当前最小契约一次修好，不新增 Adapter 或回调框架。

## 方案

- `runOneCase` 增加每个 case 的 `{ runId: string | null }` 调用上下文；`createRun` 成功后立即写入真实 id，失败路径由调用方无论成功失败都读取。创建前失败（会话/版本/建 run 失败）上下文仍为 null。成功返回值只保留 output，避免同一事实两处来源。
- `executeEvalRun` 把 `addResult` 从「catch 后 log」改为直接 `yield*`：写失败沿现有 `Effect.catchCause` 收尾，设置 `crashed`，`finishEvalRun` 以 `failed` + 已成功落库的 passed + error 收口；`passed += 1` 移到 `addResult` 成功之后。业务失败仍写 `passed=false` 的结果并继续。取消检查保持在写结果之前。
- 测试：mock repo/bullmq 套件覆盖成功、判定失败、子 run `failed/cancelled/timeout`、队列等待异常、创建前失败、重复投递与取消；新增同域真实隔离 PostgreSQL 测试，用 `eval_results` 的 `BEFORE INSERT` trigger 定向制造写失败，验证事务回滚、批次 failed、passed 不虚增、error 可见、后续 case 不再执行。

## 基线与范围

- 起点：worktree HEAD `e060e3a`；上述三个代码/测试文件在起点干净，工作树其余未提交修改归其他任务，不动。
- 只改：
  - `packages/worker/src/eval-runner.ts`
  - `packages/worker/test/eval-snapshot.test.ts`
  - `packages/worker/test/eval-result-write.test.ts`（同域新增的真实结果持久化测试）
  - `docs/tasks/codebase-review-eval-results.md`
- 不改 API、DB schema/repo、scheduler 或其他源码/记录。

## 当前有效决定

- 不派子代理，不提交；Opus review 已通过（`a1ba`）。
- 持久化失败按批次级失败处理（停止后续 case），不重试跑批。
- 测试优先真实隔离 PG + mock 队列；仅在内存 Adapter 上验证的关联行为需在记录中说明。

## 已替代项及原因

- 旧方案「addResult 失败只 log 并继续」被替代：会让 passed 与结果表不一致，产生假成功。
- 旧方案「只在成功返回后记录 runId」被替代：失败路径丢失追踪关联。
- 旧方案「失败 case 不写 runId」被替代：run 创建后的失败也应可追踪；DB 外键允许真实 runId。

## 步骤

- [x] 先写任务记录（本文件）。
- [x] 在 mock 套件与真实 PG 套件写预期失败用例，确认失败原因符合两个 bug。
- [x] 最小修改 `eval-runner.ts` 使测试转绿。
- [x] 跑 eval-snapshot、真实写库测试、API eval 相关只读回归、worker typecheck/biome/diff 检查。
- [x] 更新本记录验证输出与下一步，交 Opus review。
- [x] 独立 Opus `a1ba` 通过；主会话 `bdxq197ci` 真实 5 files / 37 passed / 0 skipped 验收。

## 改动文件

- `packages/worker/src/eval-runner.ts`
- `packages/worker/test/eval-snapshot.test.ts`
- `packages/worker/test/eval-result-write.test.ts`
- `docs/tasks/codebase-review-eval-results.md`

## 下一步

- 两项修复已验收：独立 Opus `a1ba` 通过；主会话 `bdxq197ci` 真实 5 files / 37 passed / 0 skipped。
- 未授权提交，保持未提交差异。
- 待修源码注释（本轮不改）：`packages/db/src/repo/eval.ts` 的 `addResult` 仍写「失败的 case 没有对应运行」；`packages/db/src/repo/ops.ts` 第 92 行仍写 `job.timestamp`。两项已登记在主记录待修。

## 验证

- 最新验收（主会话 `bdxq197ci`）：真实 5 files / **37 passed / 0 skipped**，覆盖 worker eval snapshot、真实 PostgreSQL 定向写故障、API eval / enqueue-failure / cancel；队列为 mock，不声称真实 Redis / worker 故障链路。独立 Opus `a1ba` 通过。
- 行为契约：写失败时批次以 `failed` + `error` 收口，`passed` 只按已落库结果计、不虚增；已创建子 run 的失败路径仍关联真实 `runId`；每个 case 的调用上下文隔离。
- 作者修复前（预期失败）：`pnpm exec vitest run --project backend packages/worker/test/eval-snapshot.test.ts packages/worker/test/eval-result-write.test.ts` → 16 tests，10 passed，**6 failed**，0 skipped。失败点符合 bug：写失败后仍跑第 3 条（queueAdd 3 次）、真实 PG 批次仍 `succeeded`、子 run failed/cancelled/timeout 与队列等待失败时 `runId=null`。
- 作者修复后同命令：16 tests，**16 passed，0 failed，0 skipped**。
- API/DB eval 只读回归：`pnpm exec vitest run --project backend packages/api/test/{eval-snapshot,eval-result-export,eval-compare,eval-runs-pagination,eval,eval-cancel,eval-files,eval-enqueue-failure}.test.ts packages/db/test/eval-run-page.test.ts packages/worker/test/eval-snapshot.test.ts` → **83 passed，0 failed，0 skipped**（10 个测试文件）。
- `pnpm --filter @agentport/worker typecheck` → 通过（`tsc -b` 无报错）。
- `node_modules/.bin/biome check packages/worker/src/eval-runner.ts packages/worker/test/eval-snapshot.test.ts packages/worker/test/eval-result-write.test.ts` → `Checked 3 files`，exit 0。
- `/usr/bin/git diff --check` → 无输出，exit 0。
- 环境：backend globalSetup 每轮随机 PostgreSQL + 临时 Redis 容器；`eval-result-write.test.ts` 再用 `createIsolatedDatabase('worker_eval_write')` 独享随机库并在结束时只删本库，未触碰开发库。队列在两组测试中均为 mock；真实数据库覆盖仅限 `addResult` 事务与批次收口。
- 口径限制：本次 37 passed 是选定 eval 切口证据，不代表全 eval / ops 区域通过；仓库最新完整 backend 239 files / 2314 passed 与 web 115 files / 1277 passed 均在本批代码之前取得，不能当当前 eval / scheduler 全量通过。
- 发现但未改（超出范围）：`packages/db/src/repo/eval.ts` 的 `addResult` 注释仍写「失败的 case 没有对应运行」，与本修复后失败 case 可带真实 runId 不符；`packages/db/src/repo/ops.ts` 第 92 行仍写 `job.timestamp`。两项登记待修，本轮不改源码。
