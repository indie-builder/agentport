---
name: agent-run-lifecycle-formal
description: "Agent Run 生命周期并发、重放、pendingFinish 与对账状态机的 TLA+ 形式化验证。每当修改 run 入队（enqueueRunJob / failQueuedRunEnqueue）、认领与执行（runAgentJob）、pendingFinish 交接与终态结算（claimRunTerminal / finalizeRun / handOffPendingFinish）、对账（reconcileRunning / reconcileQueued）或取消（cancelAgentRun / cancelRun）逻辑时使用。"
---

# Agent Run 生命周期形式化验证

本技能把 `AgentRunLifecycle` 的状态机约束固化为可复跑的 TLA+ 模型检查，专门守卫单元测试和单线程集成测试很难覆盖的并发交错、BullMQ 锁过期重投递（stall）和崩溃对账窗口。

## 一键复跑命令

在当前仓库或 worktree 根目录执行：

```bash
bun run verify:formal
```

- 执行脚本为 `scripts/verify-formal.ts`（已接入本地 CI `scripts/ci.ts`）。
- 依赖本机已安装 Java 17+；首次运行会自动校验并按需下载带 SHA-256 校验的 `tla2tools-1.7.4.jar` 到 `.cache/`。
- 输出语义：
  - `PASS`：门禁模型 `AgentRunLifecycle.cfg` 全部 6 条不变量通过。
  - `BUG-RED`：3 个历史 Bug 变体按预期触发指定不变量失败（证明门禁规则仍能抓出对应退化）。
  - `FINDING`：2 条当前开放真实竞态发现仍然可复现；若某条 Finding 已被生产代码修复并导致该项通过，脚本会报错提示将其移回 `AgentRunLifecycle.cfg` 并删除对应的 `Finding*.cfg`。

## 结果解读与状态图查看

**重要**：每当跑完模型或看到反例后，使用 `/statechart` 技能读取最短反例路径或导出状态转移图，以源码中的状态与动作名看懂系统如何走到违反状态，不要直接硬啃原始 TLC 文本轨迹。

## 覆盖范围与同步基准

- **同步 commit**：`15241b0a`
  - **推进规则**：只有确认 TLA+ 模型与最新源码语义完全一致并通过 `bun run verify:formal` 后，才可将此 commit SHA 向前推进。
- **覆盖的源码文件与函数**：
  - `packages/api/src/modules/runs/enqueue.ts`：`enqueueRunJob`、`failQueuedRunEnqueue`
  - `packages/api/src/modules/runs/cancel-run.ts`：`cancelAgentRun`
  - `packages/db/src/repo/chat/run-context.ts`：`cancelRun`
  - `packages/db/src/repo/runs.ts`：`failUnstartedRun`（联动 `packages/db/src/repo/run-predicates.ts` 的 `isNeverStartedFailure` / `neverStartedFailureFilter`，以及 `packages/db/src/repo/chat/messages.ts` 的 `requeueInfraFailedRun` 等谓词与原子迁移）
  - `packages/worker/src/runs/execute.ts`：`runAgentJob` 认领事务、`publishRun` 失败回退 `queued`、可重试失败回队列、`handOffPendingFinish`、`finalizeRun`
  - `packages/worker/src/runs/run-finish.ts`：`claimRunTerminal`、`finalizeRun`、`handOffPendingFinish`
  - `packages/worker/src/scheduling/reconcile.ts`：`probeJobGone`、`reconcileRunning`、`reconcileQueued`

## 边界与假设

- **有界并发参数**（定义在 `formal/agent-run-lifecycle/*.cfg`）：
  - `Producers = {"P1", "P2"}`：2 个并发生产者（`P1` 为初始入队，`P2` 为并发重放/重试入队）。
  - `Workers = {"W1", "W2"}`：2 个并发 Worker。
  - `MaxAttempts = 2`：对应 `packages/shared/src/run-stream.ts` 中 `runEnqueueOptions` 的 `attempts: 2`。
- **已建模内容**：
  - 数据库核心状态（`queued` / `running` / `succeeded` / `failed` / `cancelled`）、`errorKind`、`startedAt`、`pendingFinish`、`sandboxId`。
  - BullMQ job 状态（`none` / `waiting` / `active` / `completed` / `failed`）、尝试次数与最多 1 次锁过期重投递（`BullMQStall`）。
  - 生产者入队/查重/清理终态残留/失败回写与恢复、Worker 认领与执行、对账器探测与收敛、排队/运行中取消。
- **明确未覆盖范围**：
  - `sandbox` 容器内部 Claude Agent SDK 事件流、工具审批与消息持久化细节。
  - PostgreSQL 行锁与事务隔离内部实现、死锁重试与数据库连接池行为。
  - `eval-runner` 与 `memory-review` 分支路径、Redis 集群脑裂以及真实物理时间超时/指数退避时长（模型用离散状态迁移代替计时等待）。
  - 跨 run、跨会话或跨频道的全局排队与调度竞争。

## 6 条已证门禁不变量（`formal/agent-run-lifecycle/AgentRunLifecycle.cfg`）

1. `TypeOK`：所有状态变量始终落在合法的枚举集合与计数边界内，不会出现非法状态组合。
2. `NoDoubleExecution`：同一条 run 在任意时刻最多只有一个 Worker 持有执行权，不会两个 Worker 同时执行同一任务导致重复扣费或消息覆盖。
3. `NoTerminalWhileUnconfirmed`：只要沙盒停稳状态未确认（存在 `pendingFinish`），数据库里的 run 状态就必须保持 `running`，不会提前落终态。
4. `NoPendingFinishOverwrite`：一旦 Worker 交接了 `pendingFinish` 结果，对账器绝不会把它误判为失联失败并覆盖原来的成功或失败结论。
5. `AtMostOneTerminalWinner`：已经启动过的 run 在整个生命周期最多只有一次胜出的终态结算写入，不会重复落终态或重发终态事件。
6. `TerminalMonotonic`：已经启动过的 run 一旦落入终态，数据库状态和启动后终态就再也不会回退或被改写成别的终态。

## 3 个历史 Bug 变体（回归红灯守卫）

1. `BugWorkerClaimRunning.tla`（`BugWorkerClaimRunning.cfg`）：模拟 Worker 认领事务错误允许认领已处于 `running` 的 run，触发 `NoDoubleExecution` 违反，证明“防重复执行认领门禁”有效。
2. `BugPendingFinishOverwrite.tla`（`BugPendingFinishOverwrite.cfg`）：模拟对账器在 `ReconcileRunningFinalize` 去掉 `pendingFinish` 一致性检查，在并发交接窗口把已有结论覆盖为 `failed`，触发 `NoPendingFinishOverwrite` 违反。
3. `BugDoubleTerminalClaim.tla`（`BugDoubleTerminalClaim.cfg`）：模拟 `WorkerFinalize` 去掉 `dbStatus = "running"` 的原子条件，导致已终结的 run 被再次写入终态，触发 `AtMostOneTerminalWinner` 违反。

## 2 条当前开放真实发现（Findings）

以下两条发现目前在源码中真实存在，不得通过削弱不变量或修改模型来隐藏：

1. `FindingNoStuckEnqueueFailure.cfg`（`NoStuckEnqueueFailure`，见 `docs/DECISIONS-PENDING.md` `D-93`）：即使有生产者入队成功且队列任务已 `completed`（未走“失联对账”），并发重投递回滚 `queued` 与异常路径仍可能把 DB 卡在未启动的 `failed (infra)`。
2. `FindingEnqueueOkImpliesJobWasActive.cfg`（`EnqueueOkImpliesJobWasActive`，见 `docs/DECISIONS-PENDING.md` `D-94`）：BullMQ 保留同 `jobId` 终态 job 期间并发执行 `enqueueRunJob`，后到的 `queue.add` 会命中去重并静默返回成功，导致生产者既没新建等待任务也没看到活跃任务却误以为入队成功。

## 如何区分“真实源码竞态 Bug”与“建模/脚本误差”

当 `bun run verify:formal` 报出反例或新改动破坏既有不变量时，按以下步骤判定：

1. 用 `/statechart` 读出最短反例路径，定位触发迁移的动作名（如 `WorkerClaimTx`、`WorkerPublishStartedFail`、`ProducerAddJobOk`）。
2. 打开对应的源码函数，逐项核对：
   - **原子边界**：只有单个 DB `UPDATE ... WHERE` 或带 `FOR UPDATE` 的事务才在模型中合并为一步；凡是跨越 `await`、分开访问 Redis 与 PostgreSQL 的逻辑，在模型中必须拆成多步以暴露中间窗口。
   - **前置与条件**：源码里的 `WHERE` 条件、状态判断和 BullMQ 真实语义（如 `jobId` 去重、终态保留、stall 重投递、调用异常后服务端可能已写入）是否如实建模。
3. **判定结论**：
   - 若反例每一步都能在真实源码中发生，则是**真实源码竞态 Bug**：要么修复源码，要么在用户决策前将其记录为 `FINDING` 与 `docs/DECISIONS-PENDING.md` 条目，**严禁**削弱不变量凑绿灯。
   - 若源码已经通过锁、事务条件或业务前置挡住了反例中的某一步，而模型漏写了该约束，才属于**建模/脚本误差**，应修正模型并注明依据的源码行。

## 何时以及如何更新模型并推进同步 commit

1. **触发时机**：改动了「覆盖范围」中列出的任意文件/函数、修改了 `runEnqueueOptions` 的重试/保留参数，或修复了 `D-93` / `D-94` 之一。
2. **更新步骤**：
   - 按最新源码的控制流与原子边界同步更新 `formal/agent-run-lifecycle/AgentRunLifecycle.tla`（必要时同步更新 3 个 `Bug*.tla` 变体）。
   - 若某个开放 Finding 已在源码中修复，按 `scripts/verify-formal.ts` 规则将对应不变量移回 `formal/agent-run-lifecycle/AgentRunLifecycle.cfg` 并删除对应的 `Finding*.cfg`。
   - 运行 `bun run verify:formal` 确认门禁 `PASS`、历史 Bug 保持 `BUG-RED`，并用 `/statechart` 复核状态图符合预期。
   - 确认模型与源码完全对齐后，再把本文件中「覆盖范围与同步基准」的同步 commit 更新为当前最新 commit SHA。
