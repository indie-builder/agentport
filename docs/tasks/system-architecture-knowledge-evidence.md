# 系统架构调整：cron + knowledge A/B 实施证据

> 实施日期：2026-10-31。工作树：`.claude/worktrees/system-architecture-modernization`。基线 `68241bab58ad8ec59727d70677bec790af2a5ae2`。本次只覆盖契约 A（cron 入口）与 B（knowledge 生命周期）；C（eval）由另一执行者负责，未改其文件。

## 1. 改动文件

- A：`packages/shared/src/knowledge.ts`、`packages/shared/src/ops.ts`（注释）、`packages/api/src/lib/cron.ts`（新增）、`packages/api/src/features/ops/{routes,schedule-sync}.ts`、`packages/api/src/features/knowledge/source-routes.ts`。
- B：`packages/db/src/repo/knowledge.ts`、`packages/api/src/features/knowledge/{source-routes,routes}.ts`、`packages/worker/src/knowledge/{queue,ingestion,reconcile,scheduler}.ts`。
- 测试：`packages/db/test/knowledge-lifecycle.test.ts`（新增）、`packages/api/test/knowledge-source-routes.test.ts`、`packages/worker/test/knowledge-{scheduler,queue,ingestion,reconcile}.test.ts`。
- 未改 `shared/index.ts`、chat/schemas/core/eval、schema 与迁移；未新增依赖。

## 2. 实现要点

- cron：`knowledgeSourceInputSchema` 改用 shared `cronSchema`；API 两个入口统一从 `api/src/lib/cron.ts` 调用 BullMQ `getNextMillis` refine，错误 path 为 `/syncCron`。scheduler 对每个来源独立移除旧 pattern、upsert 新 pattern，并逐来源隔离失败；不再预解析 cron。
- 创建：`repo.knowledge.createSyncJob(db, sourceId)` 在来源级 `pg_advisory_xact_lock(hashtext(sourceId))` 下重读来源、检查在途，然后同一事务插入 queued run + queued job；返回 `created/not_found/not_active/in_progress`。手动、重试、定时触发共用；Redis add 都在事务提交后。
- 终态：`finishJob` 现在是唯一终态入口，支持 `fromStatus`、sync 成功结果 `{cursorAfter,stats}`；事务内依次 job CAS → sync run → source 摘要/成功游标。run 缺行或 sourceId 错配直接抛错回滚。失败/取消不推进 source.cursor，也不覆盖 run 中间检查点。
- 认领：`claimJob` 同一事务把 job queued→running，并把 queued sync run→running；重试保持 run 已写入的 startedAt 与检查点，不重开终态。
- 调用方：worker 成功/失败/取消、API 排队取消、scheduler 入队失败、reconciler 判丢失均只调 `finishJob`；`runSync` 只返回结果，不再写 run/source；`runKnowledgeJob`/`dispatchKnowledgeJob` 透传 sync 结果。删除 `createSyncRun`、`finishSyncRun`、`requestCancel` 与一处非事务 shortcut。

## 3. 先红后绿证据

实现前先写/改新测试并运行：

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/db/test/knowledge-lifecycle.test.ts packages/api/test/knowledge-source-routes.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-knowledge-red.json
```

结果：`28` 用例，`14` 通过、`14` 失败、`0` 跳过。失败原因均为预期：cron 用例中 `99 99 99 99 99` 仍被落库、`0 0 29 2 *` 被旧正则误拒；生命周期用例 `createSyncJob is not a function`。

## 4. 最终验证（实际输出）

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/db/test/knowledge-lifecycle.test.ts \
  packages/api/test/{knowledge-source-routes,knowledge-jobs,knowledge-routes,schedule-routes}.test.ts \
  packages/worker/test/knowledge-{scheduler,queue,queue-dispatch,ingestion,reconcile,retry-policy,wiki,wiki-update,sources}.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-knowledge-final-ab3.json
```

`199` 用例：`199` 通过、`0` 失败、`0` 跳过。

```sh
rtk bypass pnpm exec vitest run --project web \
  packages/web/test/knowledge-management.test.ts packages/web/test/knowledge-source-runs.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-knowledge-web.json
```

`129` 用例：`129` 通过、`0` 失败、`0` 跳过。

```sh
pnpm typecheck   # 全部 workspace 通过
pnpm build       # 全部 workspace 通过（web 仅有既存 chunk 体积警告）
```

## 5. 故障注入与并发覆盖

`packages/db/test/knowledge-lifecycle.test.ts` 使用每轮独立随机 PG（`createIsolatedDatabase`），以定向临时触发器作用在指定 source/run 行上：

- `knowledge_jobs` INSERT 抛错 → 手动/重试对应的真实仓库创建操作都不留下 sync run；scheduler 入口也单独覆盖。
- sync run 终态 UPDATE、source 摘要 UPDATE、source 成功 cursor UPDATE 分别注入 SQL 错误 → job/run/source 全部回滚；移除触发器后重试同一提交成功。
- 成功/失败/取消、`fromStatus` 不匹配、重复完成、run 缺失、sync 成功缺少 cursorAfter/statistics 均有 job+run+source 三处断言。
- 同一来源 5 个并发 `createSyncJob` 只产生一对；不同来源可独立创建；手动/定时/仓库并发争用时只产生一对活动记录。
- scheduler 用真实 Redis 验证：坏 cron 来源告警且不阻断合法来源；改坏前先移除旧 scheduler；paused/删除来源回收。另用队列 seam 确定性注入 remove/upsert 失败，证明逐来源继续。
- reconciler 用真实 Redis 验证排队 pair 在入队失败后能补投；scheduler 最终入队失败时若 job 已被 claim，queued CAS 不改写 running 行。

## 6. 限制与未覆盖

- 未运行契约中 eval 分区测试与 `eval-redelivery`；由 C 分区执行者完成。
- 未改 `docs/ARCHITECTURE.md` 与主任务记录（契约规定由集成/文档执行者处理）。
- 未验证多 worker 扩展；按契约保持单机语义。
- `biome check` 对本次触碰的既有文件仍会报告既存 `noNonNullAssertion`/`useOptionalChain` 警告；未对整文件做格式化，以保持 diff 最小。新增代码通过 `tsc`。
