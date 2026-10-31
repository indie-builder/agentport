# runtimeB short-tx 实施与真实证据

日期：2026-10-31
工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`
基线：`68241ba`
权威合同：`docs/tasks/system-architecture-runtimeB-revision.md`（本文只记录实施与结果，不替代合同）

本文对应修订后的 R5 删除编排：同一 checked-out client 持 session advisory lock → 短 tx A →
事务外 ACK（连接必须 idle）→ 同连接短 tx B 精确重核并删除 → unlock 成功后 rm。旧的
`beforeDelete` 事务回调和 warning 后 exit 0 已移除；历史结果仍保留在
`system-architecture-runtimeB-evidence.md` 与 `system-architecture-runtimeB-integration.md`，
两文件已加“已被本修订取代”的指针。

## 实施范围

- `packages/db/src/client.ts`：`Database` 改为 `NodePgDatabase<typeof schema>`，pool/client 共用查询类型。
- `packages/db/src/repo/locks.ts`：导出 `AGENT_BINDINGS_LOCK_KEY`；`withAdvisoryLock` 在同一个
  `PoolClient` 上创建 Drizzle 并交付回调；取锁/解锁/恢复设置 5s，保留 15s statement budget 和
  5s lock timeout；连接 error/end、unlock false/throw、设置恢复失败、取锁未知结果和 40s 持锁
  预算超时都 `release(true)`；连接失效时抛 retryable `SERVICE_UNAVAILABLE`。
- `packages/db/src/repo/{agents,chat}.ts`：新增 `prepareAgentDeletion` / `deleteAgent` 与
  `prepareConversationDeletion` / `deleteConversation`；A/B 都在自己的短事务内、先 `lockAgentBindings`，
  按 `AccessFilter` 重查主体与完整快照；B 只在 canonical 集合/身份完全一致时删除。
- `packages/api/src/features/runtime-deletion.ts`：唯一新增业务编排，固定
  `withAdvisoryLock(pool, AGENT_BINDINGS_LOCK_KEY, ..., 40_000)` → A → `closeSessionSandboxes` → B。
- `packages/api/src/features/{agents,chat}/routes.ts`：两个 DELETE 改走新编排；四处创建失败补偿
  也迁移到同一 conversation 编排，主体限定为本次创建者 `own_data`。
- `packages/api/src/queue/session-cleanup.ts`：连接、subscribe、publish 与 ACK 共用一个从建立连接前
  开始的 deadline；超时/失败始终 disconnect 两个连接。
- `packages/worker/src/sandbox/session-cleanup.ts`：`close(timeoutMs)` 单 deadline 有界 drain，
  超时 reject 且始终断开两个 Redis 连接；新增 `closeSessionRuntime` 统一 drain → sessions.close →
  destroyAll，失败聚合并抛出。
- `packages/worker/src/index.ts`：provider close 使用 `closeSessionRuntime`；drain timeout/rejection
  经 `runShutdown` 记录并以非零码退出，仍执行 `sessionSandboxes.close()` 与 `provider.destroyAll()`。
- 全仓库 `rg 'BeforeDeleteSandboxes|beforeDelete' packages/{db,api,worker}` 无结果。

## 红 → 绿记录

实施后首次运行并非全绿，按真实原因修正测试接线，没有放宽生产逻辑：

1. db：`delete-sandbox-hook` 10/10 通过；`locks` 首次 6/9，3 个“释放后可再取锁”断言被同轮
   其他套件持有的生产绑定键干扰。测试改用本文件唯一键后 9/9。
2. API：`delete-lifecycle` 首次因 API 包未直接依赖 `pg` 无法导入套件（0 test）；改用 `app.pool`
   的独立连接观测。`session-cleanup` 的“subscribe 永不完成”首次在 afterEach 等待 server.close
   超时；改为 unref + 不等待关闭后通过。
3. API：第二次 18/20。目标变化用例的 `agent_runs` 插入缺 `initiated_by`；owner 变化用例用
   platform 管理员得到 409。修正插入字段，并用 `owner` 角色账户（`own_data`）验证真正的 scope 404。
   第三次 20/20；追加“rm 失败仍 204”后 lifecycle 13/13。
4. worker：首次 78/79，迟到 ACK 用例的 helper 默认断言必须有 ACK；显式 `expectAck: false` 后
   79/79（shutdown 13、reconcile 1、sandboxes 59、channel 6）。
5. Docker：首次 3/3 失败，因为新 API 编排使用生产默认信道，而测试仍用随机后缀信道。改为
   “独占 Redis 容器 + 生产默认信道”后 3/3。
6. 完整矩阵首次 120/122：Docker 套件与 API 的 10s ACK 用例并行时，共享测试库上的全局绑定锁
   使 Docker 取锁超过 5s。Docker 套件改用 `createIsolatedDatabase` 独占库后，最终 122/122。

## 验证结果

全部使用 backend globalSetup 的随机 PostgreSQL、独享 Redis；Docker 套件额外使用独占数据库与
独占 Redis 容器。命令均在本树执行。

```sh
pnpm --filter @agentport/db typecheck
pnpm --filter @agentport/api typecheck
pnpm --filter @agentport/worker typecheck
# 三者均通过（tsc -b）

pnpm exec vitest run --project backend \
  packages/db/test/delete-sandbox-hook.test.ts \
  packages/db/test/locks.test.ts \
  packages/api/test/delete-lifecycle.test.ts \
  packages/api/test/session-cleanup.test.ts \
  packages/worker/test/session-cleanup-channel.test.ts \
  packages/worker/test/session-sandboxes.test.ts \
  packages/worker/test/shutdown.test.ts \
  packages/worker/test/reconcile-shutdown.test.ts \
  packages/worker/test/session-cleanup-docker.test.ts
# Test Files 9 passed (9)
# Tests 122 passed (122)
# JSON: /tmp/agentport-architecture-runtimeB-shorttx-final.json
```

矩阵内的真实行为证据：

- **同连接与锁**：A/B 与持锁 client 的 `pg_backend_pid()` 相同；`pool max=1` 连续两个事务完成；
  第二 session 的 `pg_try_advisory_xact_lock` 在持锁期间为 false，释放后为 true。
- **事务外 ACK**：HTTP DELETE 等待 ACK 时，用独立连接按 advisory 锁找到删除 PID，
  `pg_stat_activity.state='idle'` 且 `xact_start IS NULL`；实体在该窗口仍可见；准入被全局绑定锁挡住，
  删除成功释放后准入得到 `CONVERSATION_NOT_FOUND`，关闭失败释放后准入恢复为 202。
- **断线不换池**：ACK 期间 `pg_terminate_backend(删除PID)` 后放行 ACK，DELETE 返回 retryable 503，
  行与目录保留；主动重试以新连接成功 204。
- **快照重核**：ACK 期间新增 runner/sandbox 目标 → 409；并发 ADD 让 owner 改变 → owner
  `own_data` 返回 404；行、目录均保留。
- **失败语义**：关闭失败 503 保留并重试成功；rm 失败（路径被普通文件占住）仍返回 204，
  DB 已删、文件保留，日志路径不倒置提交结果。
- **锁故障分支**：真实 PG 上窄故障注入 unlock=false、unlock throw、lock_timeout 恢复失败、
  取锁 reject，均 `release(true)` 且下一连接可立即取得同键；40s 预算用 50ms 短预算证明超时会销毁
  client，迟到回调的下一条 SQL 失败。
- **Redis 信道**：成功 ACK 只认本 requestId；worker 离线、ACK 超时/迟到、subscribe 永不完成、
  publish 失败都受同一 deadline 且 `disconnect` 两个连接；worker `close(80ms)` 对挂起 drain
  reject 并断开两连接。
- **关停**：drain 成功 exit 0；drain timeout 与 channel rejection 都经 `runShutdown` 记录并 exit 1，
  同时仍执行 `sessions.close` 与 `destroyAll`；两路同时失败聚合成 `AggregateError`。
- **真实 Docker**：idle supervisor 关闭后才删行；destroy 失败保留行与 secret 目录并可重试；
  worker 重启无 entry 时按 persisted ID 关闭。3/3 通过。

## 回归

```sh
pnpm exec vitest run --project backend \
  packages/api/test/chat-attachments.test.ts \
  packages/api/test/conversations.test.ts \
  packages/api/test/agents-access.test.ts \
  packages/api/test/chat-admission.test.ts \
  packages/api/test/personal-memory.test.ts \
  packages/api/test/memory-changes.test.ts \
  packages/worker/test/personal-memory.test.ts
# Test Files 7 passed (7)
# Tests 103 passed (103)
# JSON: /tmp/agentport-architecture-runtimeB-shorttx-regression-final.json
```

四个创建失败补偿调用随签字一起迁移；记忆调用者未改业务文件，`withAdvisoryLock` 的新参数可继续忽略，
定向记忆套件通过。

## 已知边界

- 全局绑定锁在 ACK 窗口会短暂挡住其他专家的准入、绑定修改和经过绑定锁的记忆操作；单会话删除也有
  同样的全局代价。这是修订明确接受的取舍，未新增第二锁键或锁管理器。
- 40s 是删除局部持锁上限；竞争准入仍受自身 15s statement timeout 约束，可能得到可重试基础设施失败。
- B 已提交后 unlock/reset 失败会返回服务失败并保留目录，不能声称可回滚；该分支由真实 PG 窄故障
  注入覆盖，但未在 HTTP 层注入。
- 没有执行提交、LoopX 或付费模型；等待独立 Opus 按固定差异终审。

## 2026-10-31 追加：Opus 终审 P1/P2 固定修法

独立 Opus 终审发现两点，已按固定契约修复并重新取证，详见
[system-architecture-runtimeB-deadlinefix-evidence.md](system-architecture-runtimeB-deadlinefix-evidence.md)：

- **P1（已修）**：服务端 `statement_timeout` 不能限制网络黑洞。真实 TCP 代理截住锁请求响应后旧实现仍挂起
  （6.211s 样本；本轮 5 个新用例修复前均 12s 超时）。现在所有控制查询（读设置、取锁、unlock、恢复）都有
  5s 客户端截止，超时立即 `release(true)` 一次并跳过 finally 清理；`holdTimeoutMs` 从确认拿锁即启动，
  覆盖设置恢复、tx A/B 与 unlock。业务 statement 仍 15s，memory 持锁总预算未变。新增真实 PG + TCP 阻断
  请求/响应用例 5 个，修复后 `locks.test.ts` 14/14 通过。
- **P2（已修）**：Docker 重启 case 从只调 `requestClose` 改为现有 `deleteWithClose` 完整编排，并断言
  容器关闭 → DB 行删除 → 目录清理。真实 Docker 3/3 通过。
- **复跑**：runtimeB 矩阵 19 files / 127 tests 通过（0 failed / 0 skipped）；记忆与创建失败补偿回归
  14 files / 103 tests、额外锁相关 memory 4 files / 48 tests 通过；db/api/worker typecheck 与 biome 均通过。
- 本次仍未提交、未推送、未执行 LoopX；等待主会话 Opus 按固定差异终审。
