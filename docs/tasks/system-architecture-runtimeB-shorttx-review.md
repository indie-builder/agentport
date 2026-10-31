# runtimeB 最终独立复核

2026-10-31；工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`；既有任务基线 `68241ba`。

**结论：PASS，无实际阻断项。runtimeB 已发现的生产问题与两项测试边界问题均已闭合。**

本轮为极窄增量终审：只核 `packages/api/test/delete-lifecycle.test.ts` 的本库 PID 查找、terminate 保护与跨库同键用例，以及 `packages/db/test/locks.test.ts` 五类销毁连接后的有界释放等待。其余生产实现复用此前已经通过的独立审查和真实验证证据；本轮没有重新全审产品源码，也不将复用证据表述为本轮新测。

已读本树 `docs/DEV-WORKFLOW.md` §2、相关 `docs/PITFALLS.md` 条目、`system-architecture-runtimeB-revision.md` 必要契约、`system-architecture-runtimeB-deadlinefix-evidence.md` 最新测试边界段，以及本地 main 的根、api、db 规则。没有修改产品源码、测试、LoopX 或 Git；本轮仓库写入仅为用户指定的本文。

## 本轮审查结果

- `deletingBackendPid()` 在 `pg_locks` 中限定 `l.database = current_database()` 对应 OID，并用 `a.datid = l.database` 连接活动视图；同时要求 `a.state = 'idle'`、`a.xact_start is null`，保持原 advisory key 高低位匹配。跨库同键和同库仍处于事务中的锁不再成为该观测目标。
- `backendActivity()` 与 `terminateBackend()` 均限定当前数据库 OID；terminate 返回实际布尔结果，故障用例仍断言返回 true。没有放宽“ACK 等待阶段断线后失败、行与目录保留、主动重试才能成功”的要求。
- 新增边界用例通过已有 `createIsolatedDatabase('api_delete_lifecycle_other')` 创建随机迁移库，在另一库持同键时断言本库查询为 null，再在本库持锁时断言选中自己的 PID。清理释放本次 checked-out client、关闭本次 otherPool，并调用本次返回的 `other.close()`；共享 helper 只删除其唯一随机库，不按前缀批量清理，也不改写进程数据库地址。
- unlock false、unlock throw、恢复设置失败、取锁结果未知、持锁预算超时五类用例，继续断言 `release(true)` 恰好一次，并以已有 `lockReleased(key)` 断言最终为 true。该 helper 每 50ms 检查条件，3s 截止后仍做最终探测；这是等待 PostgreSQL 处理连接关闭，没有把最终取锁断言改为可选或忽略失败。

## 本轮独立验证

实现方报告 `/tmp/agentport-architecture-runtimeB-testboundary-green.json` 已核实为 41 passed / 0 failed / 0 skipped。独立复核重新运行相同四文件矩阵，保留默认文件并行，未过滤、跳过用例或降低断言：

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/db/test/locks.test.ts \
  packages/db/test/delete-sandbox-hook.test.ts \
  packages/api/test/delete-lifecycle.test.ts \
  packages/worker/test/session-cleanup-docker.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-testboundary-review.json
```

真实结果：exit 0，`success=true`，**4 个测试文件 / 8 suites / 41 passed / 0 failed / 0 skipped**。

| 测试文件 | Passed | Failed | Skipped |
|---|---:|---:|---:|
| `packages/api/test/delete-lifecycle.test.ts` | 14 | 0 | 0 |
| `packages/db/test/delete-sandbox-hook.test.ts` | 10 | 0 | 0 |
| `packages/db/test/locks.test.ts` | 14 | 0 | 0 |
| `packages/worker/test/session-cleanup-docker.test.ts` | 3 | 0 | 0 |

使用 backend globalSetup 的本轮随机迁移 PostgreSQL 库与独享 Redis；Docker 套件额外独占数据库与 Redis，从当前 shared/sandbox 源码编译并构建本轮派生镜像。真实 TCP 截止用例与真实 Docker 三场景均执行，未因基础设施不可用而跳过。日志中的注入销毁失败、ACK 超时及后端被终止产生的 503 是对应断言验证的预期路径，JSON 无失败。

## runtimeB 已发现项闭合

| 已发现问题 | 闭合结论与证据 |
|---|---|
| 旧删除事务内等待 Redis ACK、持锁连接与事务连接分离，主体/快照重核及清理失败退出不满足修订 | 已由 short-tx 修订落地：同 client 持 session lock → tx A → 事务外 ACK → tx B → 成功解锁后清目录；范围/完整快照重核、断线不换池、连接销毁和 shutdown 失败退出已有独立 PASS。复用 `/tmp/agentport-architecture-runtimeB-shorttx-review.json`：122 passed / 0 failed / 0 skipped，以及 shorttx/deadlinefix 实施证据。本轮四文件也覆盖删除主链路与锁行为。 |
| 控制查询只有服务端 timeout，真实 TCP 黑洞仍挂起；持锁 deadline 未覆盖设置恢复 | 已修为控制查询 5s 客户端截止、确认拿锁即启动持锁预算、超时销毁原连接且不换池继续。此前独立 `/tmp/agentport-architecture-runtimeB-deadlinefix-review-safe.json` 27 passed / 0 failed / 0 skipped；本轮 locks 14/14 再次执行，含 5 个真实 TCP 阻断用例。 |
| Docker 重启场景只关闭容器，未经过完整删除编排 | 已改走 `deleteWithClose` 完整编排，并断言容器关闭、DB 行删除与目录回收。此前独立 safe 报告中的真实 Docker 3/3；本轮真实 Docker 3/3 再次通过。 |
| branch 复制失败时补偿删除失败，仍清除 transcript / outputs / inputs，造成行保留而文件丢失 | 已修为删除编排返回非 null 成功快照才清目录，失败保留行与文件并维持原 CONFLICT。复用独立 `/tmp/agentport-architecture-runtimeB-branchfix-review.json`：branch 3 + attachments 19 = 22 passed / 0 failed / 0 skipped；详见 `system-architecture-runtimeB-branchfix-evidence.md` 独立定向复审段。本轮未重跑 branch。 |
| 集群级 `pg_locks` 仅按 key 选择连接，可能选中或终止另一库的后端 | 当前数据库 OID、活动 datid、idle/无事务过滤及 terminate 本库保护已核；新增真实跨库同键用例通过。本轮 lifecycle 14/14，原竞争 PID 检查与 terminate 场景均通过。 |
| `release(true)` 后立即探测锁，误把服务端异步释放窗口当作失败 | 五处复用已有有界 `lockReleased`，最终成功断言与精确一次销毁断言均保留。本轮 locks 14/14，原 unlock throw 失败用例通过。 |

另已核实既有 deadlinefix 生产矩阵 127、回归 103、额外 memory 48 的 JSON 均为 success=true、0 failed、0 skipped；db/api/worker typecheck 和 biome 复用对应实施记录的已通过结果，本轮未重跑。

首轮 `/tmp/agentport-architecture-runtimeB-deadlinefix-review.json` 的 38 passed / 2 failed 是历史失败证据，两项分别为 PID 跨库选择与 unlock throw 后立即取锁。本轮未将该历史报告改写为通过，使用新的完整四文件 41/41 独立报告证明两项已关闭；带两项过滤的历史 http-safe 结果不作为本轮完整通过依据。

## 覆盖边界与下一步

本轮只审新增测试边界及其必要 fixture，没有新增理论防护、重跑全仓、重新审查此前已 PASS 的生产实现或 SDK。未发现需要本轮另行修正的文档/实现冲突；shorttx 历史证据中“下一连接可立即取得同键”按最新 deadlinefix 测试边界段理解为销毁连接后有界等待并最终取锁成功。

修订中已接受的限制仍有效：全局绑定锁会在 ACK 等待期间影响其他准入；删除持锁总预算为 40s；丢失 COMMIT 回应时结果未知，B 已提交后 unlock/reset 失败不能回滚，均保留目录并报告失败。branch 成功补偿后的文件清理仍沿用既有 best-effort 忽略处理，见 branchfix 证据的文案校正。本轮没有扩展这些已明确的范围。

下一步：本次独立复核无待修阻断，可交回主任务汇总；未提交、未推送、未合并。
