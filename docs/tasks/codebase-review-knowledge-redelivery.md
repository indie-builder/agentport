# knowledge 队列崩溃重投被记 completed 的修复

## 目标

修复已确证缺陷：知识任务被认领后 worker 崩溃，DB 行停在 `running`；BullMQ stalled 恢复把同一个 job 重投时，`claimJob` 只接受 `queued`，返回 `null` 后处理器直接 `return`，BullMQ 把该 job 记为 `completed`。若 5 分钟对账尚未跑到，任务不会再执行，最终由对账判为 `failed`。

验收标准：

- 重投时行仍为 `running`：不记 completed、不消耗业务失败次数；用 BullMQ 官方 `job.moveToDelayed(timestamp, token)` + `DelayedError` 交还执行权，由既有 reconcile 把超期 `running` 退回 `queued` 后重新认领并执行完成。
- 行已缺失或处于终态（`succeeded`/`failed`/`cancelled`）：保持原有跳过行为，允许 BullMQ 正常收掉该条目。
- 正常 `queued`、取消、终态 skip、shutdown 行为不回归。
- 使用隔离 PostgreSQL + 私有 Redis 前缀做完整行为测试，不等待真实 5 分钟、不修改生产参数造测试口。

## 方案

- `packages/worker/src/knowledge/queue.ts`：处理器接收官方 token；`claimJob` 返回空时再用既有 `repo.knowledge.getJob` 区分原因。只有 `status === 'running'` 才会 `await job.moveToDelayed(Date.now() + REDELIVERY_DELAY_MS, token)` 并 `throw new DelayedError()`。
- 延后 60s：reconcile 每 5 分钟扫描一次，超过 5 分钟宽限的 `running` 行会退回 `queued`；1 分钟后重看一次即可接上，既不空转也不把恢复时延拉长到下一轮对账。不新增 heartbeat、租约或调度框架。
- 不直接再次认领 `running` 行：认领只接受 `queued`，避免与仍在执行的 worker 重复执行。
- `reconcile.ts` 已确认对 `running + delayed` 的收敛路径：非 `active`、未超时、超过宽限时把行退回 `queued`（现有 `knowledge-reconcile.test.ts` 已覆盖），方案可收敛，无需改对账。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/codebase-review-loop`
- 分支：`worktree-codebase-review-loop`
- 基线：`HEAD` = `origin/main` = `e060e3a559633a0d94adb637516a6d577b86b1aa`
- 开工时 `git status --short` 已有大量未提交差异与未跟踪文件，均属于正在进行的 `codebase-review-loop` 任务（其他作者），本任务不还原、不覆盖、不提交；本任务开工时 `packages/worker/src/knowledge/queue.ts`、`packages/worker/test/knowledge-queue.test.ts` 与本文档均无差异。
- 允许改动：`packages/worker/src/knowledge/queue.ts`、`packages/worker/test/knowledge-queue.test.ts`、本文档。
- 不改：`ingestion.ts`、`reconcile.ts`、`packages/db`、`packages/shared`、`packages/worker/src/index.ts`、其他文档。
- 不派代理、不提交、不并发全仓构建或迁移、不碰共享库。
- BullMQ 版本：`6.5.0`（`pnpm-workspace.yaml` catalog）。已核对本地类型与源码：`Job.moveToDelayed(timestamp, token?)` 使用 `skipAttempt: true`；`DelayedError` 从 `bullmq` 根导出，worker 捕获后不会走 `moveToFailed`；stalled 恢复脚本只把 job 放回 wait，不增加 `attemptsMade`。

## 当前有效决定

- 本任务代码与测试由 Sonnet 子代理执行，主会话只做验收与记录；不提交。
- 最小修复：只在认领失败且行仍为 `running` 时延后重投；不新造锁/心跳/调度。
- 测试使用隔离 PG（`createIsolatedDatabase`）避免生产对账扫描共享库中其他套件的行；Redis 使用私有前缀。
- 测试用 `job.promote()` 立即唤醒 delayed job，不等待 60s；不改生产延时。

## 已替代项及原因

- 无。

## 步骤

- [x] 固定基线、范围与已有差异归属，写本记录。
- [x] 先写会失败的行为测试：预置 `running` + 模拟重投，断言当前实现把 job 记 completed 且行不再执行。
- [x] 实现最小修复并让测试转绿。
- [x] 补终态/取消 skip 不回归断言；保留正常 queued 与 shutdown 既有用例。
- [x] 跑 `knowledge-queue`、`knowledge-reconcile` 测试、worker typecheck、biome 检查。
- [x] 交独立 Opus a6fe review 通过，并记录主会话真实验收结果。

## 改动文件

- `packages/worker/src/knowledge/queue.ts`
- `packages/worker/test/knowledge-queue.test.ts`
- `docs/tasks/codebase-review-knowledge-redelivery.md`

## 下一步

- 已验收：独立 Opus a6fe 通过；主会话 `b98hhx2wc` 真实重跑 4 files / 25 passed / 0 skipped / exit 0。本任务未提交。
- 已知限制：测试模拟 stalled 重投入口，未实测 kill 进程；恢复依赖既有 reconcile 周期（5 分钟一轮、5 分钟宽限），实际恢复约 6–11 分钟；60s 延后只负责不丢任务、不空转，把额外等待控制在 1 分钟内。若 worker 长时间阻塞事件循环超过 BullMQ 锁时长，仍会被按「崩溃」处理，这是现有 stalled 语义，不在本修复新增心跳/租约。
- 既有代码中 `.vitest/json/output.json` 等未提交差异属于 `codebase-review-loop` 任务，本任务未触碰。

## 验证

真实命令与结果：

- 独立 Opus review a6fe 通过。
- 主会话 `b98hhx2wc` 真实重跑 4 files / 25 passed / 0 skipped / exit 0。
- 测试模拟 stalled 重投入口，未实测 kill 进程；reconcile 恢复通常 6–11 分钟，限制保留。

- 红：`pnpm exec vitest run packages/worker/test/knowledge-queue.test.ts -t "defers a redelivered"` → 失败，`expected 'completed' to be 'delayed'`，与缺陷一致（认领返回空后 job 被记 completed）。
- 绿：`pnpm exec vitest run packages/worker/test/knowledge-queue.test.ts -t "knowledge redelivery"` → 2 passed / 9 skipped（过滤运行）。
- 全量：`pnpm exec vitest run packages/worker/test/knowledge-queue.test.ts packages/worker/test/knowledge-reconcile.test.ts` → 2 files / 21 passed / 0 failed / 0 skipped。
- 相关套件：`pnpm exec vitest run packages/worker/test/knowledge-reconcile.test.ts packages/worker/test/knowledge-queue-dispatch.test.ts packages/worker/test/claim-retry.test.ts` → 3 files / 14 passed / 0 skipped。
- 类型：`pnpm --filter @agentport/worker typecheck` → exit 0。
- 格式/静态：`pnpm exec biome check packages/worker/src/knowledge/queue.ts packages/worker/test/knowledge-queue.test.ts` → `No fixes applied`，exit 0。

测试覆盖：

- 隔离 PostgreSQL：新套件在 `beforeAll` 懒创建 `createIsolatedDatabase('worker_knowledge_redelivery')`，迁移按当前工作树 `packages/db/migrations` 执行（包含未提交的 0042），套件结束删除该库；建库失败时用例 `ctx.skip`，不会用空连接报错。Redis 用私有前缀 `knowledge-redelivery-*`。
- 过滤运行验证：`pnpm exec vitest run packages/worker/test/knowledge-queue.test.ts -t "no-such-test-xyz"` → 11 skipped，运行后 `pg_database` 无 `worker_knowledge_redelivery%` 残留（库只在套件执行时创建）。
- 预置 `running` + 模拟重投：先 `claimJob` 留下 `running`/`attempts=1`，再入队同一 job；断言 Redis 状态为 `delayed`、DB 仍 `running`、`attemptsMade=0`（未记 completed、未消耗失败次数）。
- 对账收敛：把 `startedAt` 调到宽限外，调用既有 `reconcileKnowledgeJobs` → 行退回 `queued`；`promote()` 立即唤醒（不等待 60s 生产延时），新 worker 认领后执行完成，DB `succeeded`、`attempts=2`、`endedAt` 有值。
- 关闭：delayed 状态下 `worker.close()` 在 5s 内结束。
- 不回归：正常 queued 端到端、可重试失败、同步 run、auth 失败、Docling 未配置、wiki、abort-on-close 各既有用例全部通过；取消行与缺失行仍直接 skip（Redis 状态 `completed`，DB 保持 `cancelled`/不存在）。

资源清理：测试结束无 `backend_test_redis*` 残留容器，无 `/tmp/knowledge-queue-*` 目录残留，隔离库由套件结束后删除。

依赖说明：本次改动不涉及 `packages/db`/`packages/shared` 源码；运行前核对 `packages/db/dist/schema.js`、`packages/shared/dist/knowledge.js` 均新于对应源码，未使用旧 dist 宣称通过。工作树中其他未提交的 schema/迁移改动属于并行任务，测试迁移实际包含 0042。
