# knowledge 终审验收缺口补齐：执行证据

> 执行日期：2026-10-31。工作树 `.claude/worktrees/system-architecture-modernization`。
> 基线沿用本树当前未提交的 knowledge A/B 实现；本轮只新增/修改测试与本记录，**未改生产源码**。
> 运行前按 [PITFALLS](../PITFALLS.md)「真实容器测试可能加载旧 dist」重建 `shared`/`core`/`db` 产物。

## 1. 新增场景与缺口映射

| 缺口 | 用例 | 文件 |
|---|---|---|
| worker sync 经 Redis cancel | `cancels a running sync through the Redis cancel key and settles all three tables` | `packages/worker/test/knowledge-queue.test.ts` |
| worker sync 硬超时 | `fails a timed-out sync without advancing the source cursor` | 同上 |
| 来源停用后终态 | `cancels a sync whose source was disabled before the worker ran` | 同上 |
| API queued 取消输给 claim，信号由 worker 收口 | `publishes the worker cancel signal when the queued CAS loses and the worker settles the pair` | `packages/api/test/knowledge-jobs.test.ts` |
| source 摘要触发器故障 → 回滚 → 重试同一 finish | `rolls back job and run when the source summary update fails`（补充重试段） | `packages/db/test/knowledge-lifecycle.test.ts` |
| source cursor 触发器故障 → 回滚 → 重试同一 finish | `rolls back job and run when advancing the success cursor fails`（补充重试段） | 同上 |
| sync run sourceId 错配回滚 | `rolls back the job when the sync run belongs to a different source` | 同上 |
| retry 重新 claim 保留 checkpoint/startedAt | `keeps the sync run startedAt and checkpoint when a retry re-claims the job` | 同上 |
| 拒绝终态 sync run 被 claim | `refuses to re-claim a queued job whose sync run is already terminal` | 同上 |

## 2. 实现方式（未改生产）

- worker：真实 `startKnowledgeWorker` + 真实 BullMQ queue + 自有 connector seam；cancel 由真实 Redis `knowledge:<jobId>:cancel` 键触发，超时通过临时缩短 `KNOWLEDGE_TIMEOUT_MS.sync` 走真实定时器分支，来源停用走真实 `runSync` 的 `SYNCABLE` 分支。三用例均断言 job / sync run / source 三表终态与 `source.cursor` 不推进。
- API：独享随机 PG（`createIsolatedDatabase`）+ 真实 API app + 真实 worker。测试事务先 `SELECT ... FOR UPDATE` 锁住 **sync run** 行；claim 先成功锁住 job 再卡在 run，API 读到仍为 queued 的已提交版本后，其 CAS UPDATE 只能等待 claim 事务提交。用 `pg_locks` 未授予锁事件（1 → 2）确定时序，不用 sleep。claim 提交后 API CAS 落空并按运行中分支发 cancel 键，随后真实 worker 一次事务收口三表。
- DB：沿用真实事务与定向临时触发器；新增 sourceId 错配、retry 重认领与终态 run 拒绝用例；两个已有回滚用例在移除触发器后重试同一 finish 提交并断言成功。

## 3. 首次运行与红/绿

- worker：新增 3 用例首次随整文件运行 **14/14 通过**，属验收补齐，不是 bugfix。
- DB：首次运行 15 项中 1 项红，报错 `expected 1793433054751 to be an instance of Number`。原因是测试把 primitive number 写成 `toBeInstanceOf(Number)`，不是产品行为失败；改为 `typeof === 'number'` 后 15/15 通过。新增/修改场景的终态、回滚、重试、拒绝其余断言首次即符合契约。
- API：首次运行红在测试编排，不是产品失败。最初锁 job 行时观察到 claim 的 UPDATE 等待 `transactionid`、取消 UPDATE 等待 `tuple`，两类等待无法保证 FIFO；改为锁 sync run 行后，claim 先持有 job 行再阻塞，取消的 CAS 只能等待 claim 提交，时序由真实锁事件确定。最终 4/4 通过。
- 无生产源码修复，因此本任务不声明 bugfix。

## 4. 最终验证（真实命令与计数）

构建（运行测试前）：

```sh
pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
```

结果：`tsc -b` 三包均通过。

受影响套件（正式计数）：

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/db/test/knowledge-lifecycle.test.ts \
  packages/api/test/{knowledge-source-routes,knowledge-jobs,knowledge-routes,schedule-routes}.test.ts \
  packages/worker/test/knowledge-{scheduler,queue,queue-dispatch,ingestion,reconcile,retry-policy,wiki,wiki-update,sources}.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-knowledge-gapfix-suite2.json
```

结果：`14` files / `206` total / `206` passed / `0` failed / `0` skipped。

分文件阶段报告（同命令单文件）：

- `packages/db/test/knowledge-lifecycle.test.ts`：15/15 passed，0 skipped（`/tmp/agentport-architecture-knowledge-gapfix-db.json`）。
- `packages/worker/test/knowledge-queue.test.ts`：14/14 passed，0 skipped（`/tmp/agentport-architecture-knowledge-gapfix-worker.json`）。
- `packages/api/test/knowledge-jobs.test.ts`：4/4 passed，0 skipped（`/tmp/agentport-architecture-knowledge-gapfix-api.json`）。
- 首次完整套件（biome 格式化前）：206/206 passed、0 skipped（`/tmp/agentport-architecture-knowledge-gapfix-suite.json`）。
- API 竞争调试报告（最终版前）：`/tmp/agentport-architecture-knowledge-gapfix-api-debug.json`。

静态检查：

```sh
./node_modules/.bin/biome check \
  packages/db/test/knowledge-lifecycle.test.ts \
  packages/worker/test/knowledge-queue.test.ts \
  packages/api/test/knowledge-jobs.test.ts
```

结果：`Checked 3 files in 18ms. No fixes applied.`（exit 0）。

## 5. 隔离与限制

- 真实 PG + Redis 由 backend globalSetup 每轮提供；`packages/db/test/knowledge-lifecycle.test.ts` 与 API 竞争用例各自使用 `createIsolatedDatabase`，不碰共享/开发库。
- worker 用例沿用同文件既有的 globalSetup 随机库与唯一 Redis 前缀，不触发全表对账。
- API 竞争用例从 `packages/worker/src/knowledge/queue.ts` 导入真实 worker（测试专用跨包引用，沿用 `../../worker/test/isolated-db.js` 的既有测试模式），未新增包依赖、未改生产入口。
- 未重跑 web 129：本轮只改后端 knowledge 测试，无 web 影响。
- 未提交、未 push、未改用户登录或共享库；生产源码保持原样。
- 既有测试文件里的其他未提交差异属于并行任务，未还原、未覆盖。
- 行锁编排竞争的可复用结论已补进 [PITFALLS](../PITFALLS.md)。
