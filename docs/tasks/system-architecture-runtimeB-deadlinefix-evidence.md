# runtimeB 客户端控制查询截止与 Docker 重启编排证据

日期：2026-10-31
工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`
权威合同：`docs/tasks/system-architecture-runtimeB-revision.md`、`docs/tasks/system-architecture-runtimeB-shorttx-evidence.md`
范围：只修 Opus 终审剩余 P1（控制查询客户端截止、持锁 deadline 起点）与 P2（Docker 重启 case 的完整删除编排）；不改 API 路由、其他生产代码、LoopX 或 Git。

## 问题与选定修法

### P1：服务端 timeout 管不住网络黑洞

真实 TCP 代理把锁请求的服务端响应截住后，现有 `withAdvisoryLock` 仍会挂起：`statement_timeout`/`lock_timeout`
只约束 PostgreSQL 执行，无法让客户端在请求或响应丢失时结束等待。修法：

- `packages/db/src/repo/locks.ts` 增加控制查询的客户端截止 `CONTROL_QUERY_TIMEOUT_MS = 5_000`，覆盖读
  `statement_timeout`/`lock_timeout`、`set_config`、`pg_advisory_lock`、`pg_advisory_unlock` 与设置恢复。
- 每个控制查询与 5s timer 竞速；超时立即 `release(true)` 销毁连接一次并抛出 retryable
  `SERVICE_UNAVAILABLE`，随后跳过 finally 里的 unlock/恢复，不再在失效连接上等待。
- `holdTimeoutMs` timer 改为在 `pg_advisory_lock` 成功、确认 `lockHeld = true` 后立即启动，覆盖其后的
  设置恢复、tx A/B、ACK 与 unlock；触发时同样先销毁一次连接再打断当前 await。生产删除仍传 `40_000`，
  memory 调用不传该参数，业务 statement budget 仍为连接原有的 15s。
- 已确认连接失效（`error`/`end` 或控制查询失败）时不再尝试 unlock，直接销毁连接；释放仍由一次性标记保证。
- 回调仍在原 checked-out client 上执行；销毁后迟到回调的后续 SQL 失败，不能换连接继续删除。

本地 API 核对（不新增超时框架）：

- `@types/pg@8.23.1` 的 `ClientConfig` 有 `query_timeout`，但 `QueryConfig` 没有该字段，按查询传入不是类型化公开接口。
- `pg@8.23.1` 运行时读取 `config.query_timeout`；读超时只把错误交给查询回调，非 pipeline 模式不会销毁 socket，
  已发出的查询仍在等响应。单靠它不能保证连接可回收，因此采用显式 race + `release(true)`，并在证据中保留该取舍。

### P2：Docker 重启 case

`packages/worker/test/session-cleanup-docker.test.ts` 第三个用例原先只调用测试内的 `requestClose`，绕过了
DB 删除。现改为：

1. 关闭原清理信道并启动新的 `SessionSandboxes` + 清理信道，模拟 worker 重启后没有 session entry。
2. 调用现有 `deleteWithClose`（即 `deleteAgentWithSandboxes`）走完整编排：新 worker 按 persisted sandboxId
   关容器 → API 确认后删除 DB 行。
3. 删除前确认 agent 行与含假 secret 的目录存在；删除后断言容器消失、`repo.agents.getAgent` 为 null，
   再对真实目录执行回收并断言 `access` 返回 `ENOENT`。

仍使用独占数据库与独占 Redis 容器；`stopRedisContainer` 只清理本轮创建的容器。

## 红 → 绿

新增 5 个真实 PG + TCP 代理用例（`packages/db/test/locks.test.ts`）：分别阻断读设置响应、取锁响应、
恢复设置响应、unlock 请求，以及“持锁 timer 覆盖设置恢复”。红跑在修复前：

```sh
rtk bypass pnpm exec vitest run --project backend packages/db/test/locks.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-deadlinefix-red.json
```

真实结果：9 passed / 5 failed / 14 total；5 个新用例全部 12s 超时，证明旧实现不会自行结束等待。

修复后：

```sh
rtk bypass pnpm exec vitest run --project backend packages/db/test/locks.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-deadlinefix-green-locks.json
```

真实结果：14 passed / 0 failed / 14 total。关键断言：

- 读设置、取锁、恢复、unlock 四类控制查询都在约 5.02–5.09s 结束，`release(true)` 恰好一次。
- 取锁响应被黑洞时，服务端已执行取锁；销毁连接后观察连接可再次取得同一 key。
- unlock 请求被丢弃时，服务端仍持锁；客户端 5s 截止销毁连接后同一 key 可再次取得。
- 持锁 budget 100ms + 恢复响应被黑洞时，约 118ms 结束，证明 timer 在确认拿锁后即启动，而不是等设置恢复之后。
- 原有 40s/50ms late-callback 用例仍通过：超时后迟到的 `db.execute` 失败，不继续删除；`release(true)` 一次。

## P2 真实 Docker

```sh
rtk bypass pnpm exec vitest run --project backend packages/worker/test/session-cleanup-docker.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-deadlinefix-green-docker.json
```

真实结果：3 passed / 0 failed / 3 total。第三个用例走 `deleteWithClose` 后依次确认：容器已不存在、
agent 行为 null、目录删除后 `access` 返回 `ENOENT`。

## 回归与矩阵

```sh
pnpm --filter @agentport/db typecheck
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/worker typecheck
pnpm exec biome check packages/db/src/repo/locks.ts packages/db/test/locks.test.ts \
  packages/worker/test/session-cleanup-docker.test.ts
```

三者 typecheck 通过；biome 无 error/warning。

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/db/test/delete-sandbox-hook.test.ts \
  packages/db/test/locks.test.ts \
  packages/api/test/delete-lifecycle.test.ts \
  packages/api/test/session-cleanup.test.ts \
  packages/worker/test/session-cleanup-channel.test.ts \
  packages/worker/test/session-sandboxes.test.ts \
  packages/worker/test/shutdown.test.ts \
  packages/worker/test/reconcile-shutdown.test.ts \
  packages/worker/test/session-cleanup-docker.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-deadlinefix-green-matrix.json
```

真实结果：19 files / 127 tests passed / 0 failed / 0 skipped（原 122 + 5 个新 client-deadline 用例）。

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/api/test/chat-attachments.test.ts \
  packages/api/test/conversations.test.ts \
  packages/api/test/agents-access.test.ts \
  packages/api/test/chat-admission.test.ts \
  packages/api/test/personal-memory.test.ts \
  packages/api/test/memory-changes.test.ts \
  packages/worker/test/personal-memory.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-deadlinefix-green-regression.json
```

真实结果：14 files / 103 tests passed / 0 failed / 0 skipped；三个 memory 调用方行为不变。

额外定向复跑使用 `statement_timeout = 0` 的锁相关 memory 套件：

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/api/test/delegation-memory-lock.test.ts \
  packages/api/test/memory-reviews.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-deadlinefix-green-memory-extra.json
```

真实结果：4 files / 48 tests passed / 0 failed / 0 skipped。

## 已知边界

- 控制查询截止是 5s；删除持锁总预算仍是 40s，memory 调用不新增总时限。
- 取锁/解锁超时后由销毁 TCP 连接让 PostgreSQL 结束后端并释放 session lock；这是网络中断下的恢复方式，
  不是换连接继续删除。
- 测试用真实 5s 验证生产数值准确；只有“持锁 timer 覆盖恢复”用 100ms 局部 budget 缩短用例时间。
- Docker 用例的目录回收由测试按删除成功后的目标路径执行并断言；API 路由的 rm 编排不在本次文件范围。
- 未提交、未推送、未执行 LoopX；等待主会话 Opus 按固定差异终审。

## 终审复审：测试边界修复

独立终审首矩阵为 38 passed / 2 failed（`/tmp/agentport-architecture-runtimeB-deadlinefix-review.json`），两项均为测试选择连接/等待释放的边界问题；生产源码的锁截止、删除编排与 branch 行为已 PASS，本轮只改测试，不动生产源码。

### P1：`pg_locks` 集群级查询选错连接

`delete-lifecycle.test.ts` 的 `deletingBackendPid()` 原查询只按 advisory key 匹配并 `limit 1`；`pg_locks` 覆盖整个集群，Docker 套件在另一隔离库持同一绑定键时会被选中，随后 `pg_terminate_backend` 可能误伤非本轮连接（首矩阵竞争用例即因此比较到不同 PID）。

修法：

- `deletingBackendPid()` 增加 `l.database = 当前数据库 OID`、`a.datid = l.database`、`a.state = 'idle'`、`a.xact_start is null`，只选择本库空闲、无事务的 session 锁，不再仅凭 `limit 1`。
- `backendActivity()` 同样限定 `datid = 当前数据库`；`terminateBackend()` 只在当前数据库内终止并返回布尔值，用例断言确实终止了目标连接。
- 新增真实 PG 边界用例：用 `createIsolatedDatabase` 建另一隔离库并在其中持同一 advisory key，断言本库无人持锁时 `deletingBackendPid()` 返回 `null`，本库自己持锁时仍精确选中该连接。该临时库在 `finally` 中只关闭/删除本次创建的唯一库。

红跑（旧 helper，仅该边界用例）：

```sh
rtk bypass pnpm exec vitest run --project backend packages/api/test/delete-lifecycle.test.ts \
  -t 'ignores the same advisory key' \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-testboundary-red.json
```

真实结果：`expected 131402 to be null`——旧查询确实返回了另一隔离库的 PID。

### P2：`release(true)` 后立即取锁偶发 false

`locks.test.ts` 的 unlock false/throw、设置恢复失败、取锁结果未知、持锁 budget 超时五类用例，在 `release(true)` 销毁连接后立即用单次 `pg_try_advisory_xact_lock` 断言可再次取锁；socket 关闭与服务端释放异步，首矩阵 unlock throw 用例因此偶发 false。

修法：五处改用已有 `lockReleased(key)`（50ms 轮询、3s 有界上限），不新增固定 sleep，最终仍断言锁可再次取得，没有放宽释放要求。

### 验证

```sh
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/db typecheck
pnpm exec biome check packages/api/test/delete-lifecycle.test.ts packages/db/test/locks.test.ts
```

均通过（biome 无 error/warning）。

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/db/test/locks.test.ts \
  packages/db/test/delete-sandbox-hook.test.ts \
  packages/api/test/delete-lifecycle.test.ts \
  packages/worker/test/session-cleanup-docker.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-testboundary-green.json
```

真实结果：8 suites（4 个测试文件）/ 41 tests passed / 0 failed / 0 skipped；其中 `delete-lifecycle` 14、`delete-sandbox-hook` 10、`locks` 14、真实 Docker 3。包含首矩阵失败的两个用例；PG/Redis/Docker 均为本轮真实资源，临时库和容器只删除本次返回的唯一资源。
