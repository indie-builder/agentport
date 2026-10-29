# 定时任务普通保存不应重置调度

## 目标
PATCH `/api/schedules/:id` 只改名称/prompt（以及显式回传未变化的 enabled/cron）时，不重写 BullMQ Job Scheduler：保留当前 delayed job 与 `next`，避免 worker 停机积压时旧触发丢失；只有停用、重新启用或 cron 实际变化时才同步队列。

## 方案
在 PATCH handler 内比较更新前后的调度字段（`enabled`、`cron`），以 `existing` 为基准：
- `row.enabled === false`：`removeScheduler`（保持停用即移除）。
- `row.enabled === true` 且（原为停用 或 cron 实际变化）：`upsertScheduler` 后读 next。
- 其余情况：只 `schedulerNextRun` 读当前 next，不触碰 pending job。

name/prompt 变更由 worker 触发时重读数据库自然生效，无需重建 scheduler。不新增自愈、锁或缺失 scheduler 的补建；仍依赖 worker 既有 reconcile。审计与同步失败处理保持原样。

## 基线与范围
- 基线 commit：`e060e3a`（worktree `codebase-review-loop`，实际 pwd/git root 一致）。
- `packages/api/src/features/ops/routes.ts`、`packages/api/test/schedule-routes.test.ts` 在开工时无未提交差异。
- 工作区其余未提交差异属于其他作者/未完成任务，不还原、不覆盖。
- 允许改动：`packages/api/src/features/ops/routes.ts`、`packages/api/test/schedule-routes.test.ts`、本记录。
- 不改：worker scheduler、DB repo、shared 契约及其他任务记录（`triggerAt` 由另一作者处理）。

## 当前有效决定
- 用户要求本轮主会话直接执行，不派子代理、不提交。
- 仅当「重新启用」或「cron 实际变化」时 upsert；无调度变化仍读当前 next 返回、不 reset pending。
- `enabled:false` 停用仍 remove；显式 `enabled:true` 但原值 true 且 cron 同值不重建。
- 缺失 scheduler 是否恢复按现有 reconcile 契约，不加理论自愈/新锁。
- 测试使用真实 Fastify schema + 本轮隔离 PG/Redis；队列用私有 prefix，只 mock 既有 `getScheduleQueue` 边界以注入 prefix，不改生产配置。
- 用自定义 `repeatStrategy` 快速制造已到期 pending job（不等 10 分钟），断言旧 job/next 不变、prompt 落库。

## 已替代项及原因
无。

## 步骤
- [x] 先写任务记录并确认目标文件基线。
- [x] 重写 schedule-routes 测试为真实 Fastify + 隔离 PG/Redis + 私有队列前缀，先跑到红。
- [x] 最小修改 PATCH 同步条件，跑绿。
- [x] 跑完整测试文件、api typecheck、biome。
- [x] 更新记录，交 Opus review；review 通过（a450）。

## 改动文件
- `packages/api/src/features/ops/routes.ts`
- `packages/api/test/schedule-routes.test.ts`
- `docs/tasks/codebase-review-schedule-save.md`

## 下一步
无。Opus review 已通过（a450）。收尾仅补强测试契约：普通保存 payload 显式回传同值 `cron: created.cron`，与真实 UI 一致（同值 cron 不触发重建），断言未改。未提交。

## 验证
- 红（修复前，真实 Fastify + 隔离 PG/Redis）：
  `pnpm exec vitest run packages/api/test/schedule-routes.test.ts --project backend`
  结果 `1 failed | 14 passed (15)`；失败为 pending job 用例：`nextDueAt` 被 upsert 重置为 1 小时后（`...14:45:58Z` → `...15:45:58Z`），旧 delayed job 被删。
- 绿（修复后同命令）：`15 passed (15)`，`Test Files 1 passed (1)`。
- `pnpm --filter @agentport/api typecheck`：`tsc -b` 通过，无输出。
- `pnpm exec biome check packages/api/src/features/ops/routes.ts packages/api/test/schedule-routes.test.ts docs/tasks/codebase-review-schedule-save.md`：通过（Checked 2 files）。
- 资源：测试使用 globalSetup 每轮随机 PG 库与独享临时 Redis 容器；队列 prefix 为 `schedule-routes-test-<随机>`；afterAll 只按本文件 schedule id 清审计/任务并删除本文件 agent，队列 scheduler 清空后关闭。未触碰开发库/共享 Redis。
- 限制：测试用自定义 `repeatStrategy` + 1.7s 等待制造逾期 pending job；未覆盖真实 worker 停机 5/10 分钟的时序。缺失 scheduler 时不补建，依赖既有 worker reconcile。
- 本轮收尾（仅测试契约补强）：`./node_modules/.bin/vitest run packages/api/test/schedule-routes.test.ts packages/worker/test/schedule-scheduler.test.ts --project backend` → `Test Files 2 passed (2)`，`Tests 31 passed (31)`（本文件 15 条，无 skip）；`./node_modules/.bin/biome check` 4 个 TS 文件通过；`git diff --check` 无输出。
