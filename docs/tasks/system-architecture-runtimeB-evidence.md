# 系统架构现代化 R5：会话容器关闭与删除生命周期（B 线证据）

> 2026-10-31 修订：R5 删除编排与关停部分以
> `system-architecture-runtimeB-revision.md` 和 `system-architecture-runtimeB-shorttx-evidence.md`
> 为准。本文的 94/94、Docker 3/3 等历史结果保持原样，但对应的事务内 `beforeDelete` 方案已被
> 同连接 A → 事务外 ACK → B 方案取代，不再作为新实现依据。

日期：2026-10-31
范围：`docs/tasks/system-architecture-runtime-contract.md` R5.3 / R5.4。
本文件记录 B 线（关闭与删除生命周期）的实现、完整接线与真实证据；接线步骤见
`docs/tasks/system-architecture-runtimeB-integration.md`。

## 结果概览

- 已实现并接线：API 侧关闭请求客户端、worker 侧内部关闭信道、`SessionSandboxes.closeIdle`、
  `deleteAgent` / `deleteConversation` 事务内 `beforeDelete` 回调，以及两个 DELETE 路由与
  worker 启动/关停接线。
- 路由级验收：真实 Fastify HTTP → 删除事务 → Redis 请求/ACK → DB 删除 → 目录回收。
- 未新增服务、BullMQ Worker、持久删除状态、schema 列或迁移；未改凭据/登录/付费/Git/LoopX。

## 文件与职责

| 文件 | 内容 |
|---|---|
| `packages/shared/src/sandbox-session.ts:65` | 跨进程协议唯一来源：请求/ACK schema、请求信道、ACK 信道、10s 等待预算。放在已存在的 shared 文件中并由现有 barrel 导出，避免新增子路径 export。 |
| `packages/worker/src/sandbox/sessions.ts:256` | `closeIdle(conversationId, sandboxIds)`：只关闭目标会话空闲容器；active / leaseHeld / acquirePending 拒绝；合并进行中的 `destroyEntry`；没有入口时按持久化容器名 `destroyById`；失败聚合且保留 `broken` 以便重试。 |
| `packages/worker/src/sandbox/session-cleanup.ts:33` | `startSessionCleanupChannel`：订阅内部信道、入口校验一次、检查 deadline、逐目标关闭、全成功才 ACK；`close()` 先退订再等待进行中的确认。 |
| `packages/api/src/queue/session-cleanup.ts:48` | `closeSessionSandboxes`：合并/去重目标、唯一 requestId、deadline、订阅 ACK 后发布、有界等待；失败/超时抛 `SERVICE_UNAVAILABLE`（可重试），由删除事务回滚。 |
| `packages/db/src/repo/chat.ts:147` | `deleteConversation(db, id, beforeDelete?)`：锁内查 sandboxIds，调用回调后再删除；回调抛错回滚。 |
| `packages/db/src/repo/agents.ts:567` | `deleteAgent(db, id, beforeDelete?)`：绑定锁内查全部会话及各会话 sandboxIds，调用回调后再删除；回调抛错回滚。 |
| `packages/api/src/features/chat/routes.ts:799` | DELETE handler 在 repo 回调内调用 `closeSessionSandboxes`；仅在 ACK + DB 删除成功后清理该会话目录。 |
| `packages/api/src/features/agents/routes.ts:735` | DELETE handler 同样在 repo 回调内关闭；成功后回收 `sdk-sessions`、`session-sandboxes`、outputs、inputs，保留全部记忆。 |
| `packages/worker/src/index.ts:139` | 启动时 `await startSessionCleanupChannel`；关停先在 `provider.close` 内退订并等待 in-flight（10s 预算），再关闭 `SessionSandboxes` 与 provider。 |
| `packages/api/test/delete-lifecycle.test.ts` | 路由级 HTTP/目录/锁内准入验收；故障用例使用独享 Redis 实例。 |
| `packages/api/test/session-cleanup-responder.ts` | 测试进程内启动真实 worker 关闭信道，记录关闭目标；不 mock 路由回调。 |

## R5.3 不变量对照

| 合同要求 | 实现与测试 |
|---|---|
| 删除锁持有到关闭 ACK 与 DB 删除完成 | 回调在 `db.transaction` 内、锁之后、DELETE 之前调用；`delete-sandbox-hook.test.ts` 与 `delete-lifecycle.test.ts` 分别在 repo 与真实 HTTP 入口证明延迟 ACK 期间准入被阻塞，删除提交后返回 404。 |
| 请求唯一 id / 到期 / 精确 conversation + persisted sandboxIds | shared schema + API 客户端 `randomUUID()` + `deadline`；目标按会话合并、容器 id 去重；路由用例断言请求携带精确会话与 sandboxId。 |
| worker 拒绝 active / leaseHeld / acquirePending | `SessionSandboxes.closeIdle` 前置判断；`session-sandboxes.test.ts` 覆盖 active、新 lease、acquire 等待 idle destroy 三种忙态，均不销毁。 |
| 复用 destroyEntry / destroyById | 有入口走 `destroyEntry`（并发合并、失败保留 `broken`）；无入口按持久化 id 走 `provider.destroyById`；不新增 provider API。 |
| 不强杀新 run | 忙态直接拒绝；空闲入口的容器 id 不在目标集合时不销毁，只清理持久化的旧 id。 |
| ACK 仅全关成功；超时失败回滚 | worker 收集所有目标错误，任一错误回 `ok:false`；API 超时/失败抛可重试 503；repo 回调抛错使事务回滚。路由用例覆盖关闭失败、worker 不在线、在线但不 ACK 三种结果，均保留 DB 行与目录。 |
| 保留目录 | DB 删除与目录清理都在 ACK 成功之后；`delete-lifecycle.test.ts` 断言 ACK 前目录仍存在、204 后目标目录才消失，其他会话目录保持。 |
| 真实 Redis / 独立 PG / Docker 假 secret | backend globalSetup 提供独立 PG/Redis；路由故障用例再启动独享 Redis 实例隔离 Pub/Sub；Docker 用例从当前源码构建一次性镜像，写入假 secret，确认容器删除后才删目录。 |
| 关闭后才能 rm | Docker 用例先通过关闭信道确认容器不存在，再执行目录回收；路由用例以延迟 ACK 证明 204 与 rm 都在确认之后。 |
| 保留所有 memory | 删除路径未触碰 `agent-memory`、子专家记忆、个人记忆、`sdk-sessions` 之外记忆资产；agent 路由用例断言父/子/个人/其他 agent 记忆仍在。 |
| index shutdown 等清理 | `provider.close` 内先 `sessionCleanup.close()`（退订并等待 in-flight），用 `SESSION_CLEANUP_TIMEOUT_MS` 显式限时 10s；超时后继续关闭 SessionSandboxes/provider，API 会超时回滚，不存在新的无界退出路径。 |
| 无新服务/持久删除状态 | 仅 Redis pub/sub 有限请求/应答与现有 provider。 |

## 行为测试矩阵

| 用例文件 | 关键断言 |
|---|---|
| `packages/db/test/delete-sandbox-hook.test.ts` | 锁内可见实体；distinct sandboxIds；回调失败回滚；queued/running 冲突且不回调；agent 删除按会话分组；延迟 ACK 时准入阻塞、提交后 404/AGENT_NOT_FOUND。 |
| `packages/worker/test/session-sandboxes.test.ts` | idle 关闭；空 persisted id 仍关闭会话 idle 容器；active/新 lease/acquirePending 拒绝；无入口按 id + 去重；失败可重试；部分失败继续其余；旧 id 不误杀当前容器。 |
| `packages/worker/test/session-cleanup-channel.test.ts` | 真实 Redis 请求/ACK；过期拒绝；非法请求不执行不 ACK；失败目标后继续其余；`close()` 等待 in-flight。 |
| `packages/api/test/session-cleanup.test.ts` | 请求字段与去重；成功 ACK 才返回；失败 ACK 与超时都抛可重试 503；无目标为 no-op。 |
| `packages/api/test/delete-lifecycle.test.ts` | 真实 HTTP：关闭确认前不返回 204、目录不动；关闭失败/worker 离线/不 ACK 均 503 且行与目录保留；重试成功；queued run 409 不回调；延迟 ACK 时准入阻塞；agent 删除回收 session-sandboxes 并保留父/子/个人/其他 agent 记忆。 |
| `packages/worker/test/session-cleanup-docker.test.ts` | 真实 Docker idle supervisor + 假 secret：关闭后容器消失、删行；销毁失败时实体/容器/目录都保留，恢复后重试成功；worker 无入口时按 persisted sandboxId 清理。 |

## 验证命令与真实结果

先确保当前 `shared/core/db` 产物，再跑 API/worker 类型检查与行为测试：

```sh
pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build
# 结果：成功

pnpm --filter @agentport/api typecheck
# 结果：成功

pnpm --filter @agentport/worker typecheck
# 结果：成功
```

接线前红基线（新路由用例，旧实现尚未发关闭请求）：

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/api/test/delete-lifecycle.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-integration-red.json
# 结果：8 个用例中 7 失败（成功路径拿不到关闭调用、失败/离线/超时路径返回 204，
# agent 目录未回收，延迟 ACK 竞态不成立）；唯一通过的 409 用例本就不调用关闭回调。
```

接线后最终范围（路由 + 删除链路基线 + 既有回归）：

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/api/test/delete-lifecycle.test.ts \
  packages/api/test/conversations.test.ts \
  packages/api/test/agents.test.ts \
  packages/api/test/agents-access.test.ts \
  packages/api/test/chat-attachments.test.ts \
  packages/api/test/output-retention.test.ts \
  packages/api/test/outputs-routes.test.ts \
  packages/api/test/session-cleanup.test.ts \
  packages/db/test/delete-sandbox-hook.test.ts \
  packages/worker/test/session-sandboxes.test.ts \
  packages/worker/test/session-cleanup-channel.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-integration-final.json
# 结果：22 个文件、174/174 通过，0 失败，0 跳过。
```

Docker 单独验证（真实容器 + 假 secret + 一次性派生镜像）：

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/worker/test/session-cleanup-docker.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-integration-docker.json
# 结果：3/3 通过。
```

记忆目录回归（覆盖 WORKSPACES_DIR 测试入口调整）：

```sh
rtk bypass pnpm exec vitest run --project backend \
  packages/api/test/memory-files.test.ts packages/api/test/memory-changes.test.ts \
  packages/api/test/memory-reviews.test.ts packages/api/test/memory-routes.test.ts \
  packages/api/test/personal-memory.test.ts packages/api/test/delegation-memory-lock.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-integration-memory.json
# 结果：12 个文件、131/131 通过。
```

`biome check`：本任务改动的 11 个文件通过。`packages/api/src/features/agents/routes.ts` 仍有两条
既有 `useOptionalChain` 报错（第 201、1408 行，不在本任务改动内），未顺手修改。

Docker 用例只在 `docker info` 可用且本机存在 `agentport/sandbox:dev` 时运行；镜像按本轮源码在临时
目录构建，测试结束删除派生镜像与容器，不批量清理其他容器。

## 已知限制 / 未观察项

1. **路由测试用进程内 worker 处理器**：HTTP 路由、Redis、repo、DB、目录都是真实链路；
   `closeIdle` 由测试桩记录目标，容器销毁语义由 `session-cleanup-docker.test.ts` 的真实 Docker 用例覆盖。
   没有启动完整生产 worker 进程（index 启动/关停接线只做了 typecheck，未做进程级 SIGTERM 集成验证）。
2. **ACK 超时用例耗时约 10s**：与生产 `SESSION_CLEANUP_TIMEOUT_MS` 相同，不能用更短预算，
   否则测试与真实等待语义不一致。
3. **忙态映射为 503**：worker 的 busy/失败统一编码为 ACK error，API 客户端返回可重试
   `SERVICE_UNAVAILABLE`；合同允许服务不可用或冲突，本轮不额外引入 ACK 错误码。
4. **目录 rm 仍为 best-effort**：ACK 成功且 DB 删除后，rm 失败只记日志；这是合同允许的
   既有清理限制，不宣称凭据无残留。
5. **测试入口改用物理临时目录**：`packages/api/test/helpers.ts` 的默认工作区路径改走
   `realpathSync(tmpdir())`，避免 macOS 的 `/var` → `/private/var` 符号链接触发既有记忆安全校验；
   安全实现未改。此调整让 `agents.test.ts` 两条既有失败恢复通过。
