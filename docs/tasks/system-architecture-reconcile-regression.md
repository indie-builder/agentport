# reconcile-queue 套件全表扫描污染（测试隔离回归）

- 基线：`68241ba`
- 范围：仅 `packages/worker/test/reconcile-queue.test.ts`；生产 `src/reconcile.ts` 未改动。

## 现象

全仓 `vitest run` 中该套件 19 条用例失败 13 条，典型断言：

- `probes at most four candidates at a time`：expected 6 to be 4
- 多条 `expected 1/2 to be +0`、publish 次数从 1 变 2

## 定位

- 该套件单独完整跑：19/19 通过，排除生产回归。
- backend globalSetup 每轮只建一个测试库，所有测试文件同库并行；该套件用私有 fake queue 调用生产 `reconcileOrphanedRuns`，函数扫描整张 `agent_runs` 表。同轮其他套件提交的 queued/running 记录被当成自己的候选，而这些 job 在私有队列中不存在，于是被误判孤儿并写入 failed/发布事件。
- 与 `docs/PITFALLS.md`「测试：私有队列配全表对账会互相收敛别的测试记录」一致。

## 修复

- 模块加载时调用 `createIsolatedDatabase('worker_reconcile_queue_probe')` 独享随机库。
- 显式使用返回的 `url` 建连，不写 `process.env.DATABASE_URL`，不回落共享库；helper 只在基础设施不可达时返回 null 让调用方跳过，建库、迁移或库身份不符失败会抛出。
- `afterAll` 先结束连接池再 `close()`，只删除本套件创建的库。
- 未修改生产对账、未放宽断言、未 skip、未关闭 dev worker；用例内事务回滚保留（对账扫描全表，残留夹具仍会污染同文件后续用例）。

## 验证

| 阶段 | 命令 | 结果 |
| --- | --- | --- |
| 修复前全仓 | `/tmp/agentport-architecture-final-all.json` | 该套件 13 failed |
| 修复前单跑 | `pnpm vitest run --project backend packages/worker/test/reconcile-queue.test.ts` | 19/19 passed |
| 修复后单跑 | 同上，JSON `/tmp/agentport-architecture-reconcile-isolation-after-solo.json` | 19/19 passed |
| 相关套件同轮并行 | reconcile-queue / reconcile-queue-redis / reconcile-eval / reconcile-eval-redis / reconcile-shutdown / knowledge-reconcile / run-pending-finish，JSON `/tmp/agentport-architecture-reconcile-isolation-parallel.json` | 47/47 passed（各套件均 passed） |
| 静态检查 | `pnpm exec biome check packages/worker/test/reconcile-queue.test.ts` | 通过 |

## 未覆盖

全仓其余失败套件（agents-access、memory-routes、output-shares、subagent-export、run-pending-finish 的 error-only 结果、session-sandbox-sdk）与本任务无关，未处理。
