# codebase-review 队列完成通知丢失（QueueEvents 首个 XREAD）

## 目标

修复并固定 `runNativePluginAction`（native-plugins）与 `testStdioInSandbox`（sandbox-probes）的完成通知窗口：

- 背景症状（Opus 诊断）：fullbackend 两套首例 20s 超时、末例应超时却成功；6 轮目标单跑 60/60，历史首卡无法唯一归因。
- 已受控复现：`QueueEvents` 连接 ready 不保证首个 `XREAD` 已开始，默认 `$`；`waitUntilFinished` 注册监听后回查 `isFinished` 仍未完成 → job 完成 → 首个 `XREAD` 才执行，`$` 在**执行时**解析为流尾，完成通知被跳过。
- 验收：回归测试在修复前红、修复后绿；真实私有 Redis + 真实 Worker + 真实产品客户端；不改共享 env/库/服务。

## 方案

`QueueEvents` 最小改动：显式 `lastEventId: '0-0'`，让首个 `XREAD` 从可回放位置开始。修复窗口内写入的 `completed:<jobId>` 会在连接后重放时被投递。

已核官方源码（本地安装 `bullmq@6.5.0`）：

- `dist/esm/classes/queue-events.js`：`let id = opts.lastEventId || '$'`；事件按 `completed` / `completed:<jobId>` 双通道 emit。
- `dist/esm/interfaces/queue-options.d.ts`：`QueueEventsOptions.lastEventId?: string`，语义为“从已知 Id 继续消费”。
- `dist/esm/classes/job.js#waitUntilFinished`：先注册 `completed:<jobId>` / `failed:<jobId>` 监听，再 `await queueEvents.waitUntilReady()`，随后 `isFinished` 回查。
- 事件流保留量：`queue.js` 默认 `maxLenEvents = 10000`，`publishEvent` 用 `XADD ... MAXLEN ≈ 10000`。
- 旧事件过滤：`waitUntilFinished` 只监听当前 `jobId` 的通道，BullMQ jobId 唯一；不影响其它事件。

保持原有：超时预算、错误 schema（`fail('SERVICE_UNAVAILABLE'/'UPSTREAM_FAILED')`）、连接清理（`disconnect` / `close`）。不新增轮询等待、不抽共享通用框架。

测试侧：真实私有 Redis（globalSetup）、真实 Worker 直连 Redis、真实产品客户端经 TCP 门闩代理连 Redis。代理只扣住首个 `XREAD`；用 `MONITOR` 确认产品已执行 `isFinished` 回查（此刻 job 仍未完成），再让 Worker 返回并放行 `XREAD`。修复前 `$` 跳过完成事件 → 预算内返回超时失败；修复后 `0-0` 重放 → 返回 Worker 结果。

代价：每次调用从流起点回放保留窗口（默认最多 1 万条事件），插件安装/试连频率有限；只解析事件、不额外往返，故接受。

## 基线与范围

- 起点：`worktree-codebase-review-loop`，HEAD `e060e3a`。
- 初始未提交差异：均为本 review loop 其它任务产出，不属于本任务；本任务目标文件初始无差异。
- 允许改动：
  - `packages/api/src/features/plugins/native.ts`
  - `packages/api/src/features/servers/sandbox-probe.ts`
  - `packages/api/test/native-queue.test.ts`
  - `packages/api/test/sandbox-probe.test.ts`
  - 新增 `packages/api/test/queue-events-gate.ts`（仅测试用门闩/监控 helper，不属于产品运行代码）
  - 本文件
- 不改：共享 env、数据库、Redis/globalSetup、helpers、其它源码与测试。

## 当前有效决定

- 本切口由作者子代理直接执行（不另派下级代理），不是用户全局约束；用户已授权最终提交 PR 与合并。
- 产品修复只考虑 `lastEventId` 可回放方案；若源码/行为证明候选不成立，报告替代方案，不盲修。
- 测试不得只断言 constructor 选项；必须用真实 Redis/Worker 固定丢失时序。
- 不增大 Vitest timeout 掩盖；不改共享配置。
- Worker 用 `afterEach` 登记 `close(true)`，避免测试超时后遗留消费者把后续“无 consumer”用例跑成功；`close(true)` 不等待永不完成的 job。
- 保留原“无 consumer 超时”断言。

## 已替代项及原因

无。

## 步骤

- [x] 读 CLAUDE / DEV-WORKFLOW / PITFALLS，核 BullMQ 6.5.0 `lastEventId`、`waitUntilFinished`、事件保留与过滤源码。
- [x] 新增测试门闩 helper；在两个目标套件各加一条“完成早于首个 XREAD”回归，先跑出红。
- [x] 给两处 `QueueEvents` 加 `lastEventId: '0-0'`，保持预算/schema/清理不变。
- [x] 目标套件重跑至绿；确认原“无 consumer 超时”用例仍通过。
- [x] `afterEach` 登记 Worker `close(true)`，移除仅靠 test body `finally` 的清理。
- [x] api typecheck + biome；精确清理测试资源。
- [x] 更新本记录并交 Opus review（最终提交由主会话在 review 与验证后执行）。

## 改动文件

- `packages/api/src/features/plugins/native.ts`：`QueueEvents` 加 `lastEventId: '0-0'`。
- `packages/api/src/features/servers/sandbox-probe.ts`：同上；`StdioProbeOptions` 增加可选 `redisUrl`（缺省仍用进程 `REDIS_URL`，路由不传），供回归测试指向门闩代理。
- `packages/api/test/native-queue.test.ts`：新增完成通知回归；Worker 改为 `afterEach` 登记 `close(true)`；管理 Queue 复用并关闭。
- `packages/api/test/sandbox-probe.test.ts`：同上，回归直接调用 `testStdioInSandbox` 并传 `redisUrl`。
- `packages/api/test/queue-events-gate.ts`（新增）：仅测试用的 TCP 门闩（扣首个 XREAD）与 `MONITOR` 观察 `isFinished`；事件驱动，不轮询，不参与产品运行。
- `docs/tasks/codebase-review-queue-events.md`

## 下一步

独立 Opus review 已通过（aa19），已验收；用户已授权最终提交 PR 与合并，由主会话在最终验证后执行。

## 验证

### 红（临时移除两处 `lastEventId`，最终测试与门闩）

```text
pnpm exec vitest run packages/api/test/native-queue.test.ts packages/api/test/sandbox-probe.test.ts
（连续 3 轮，结果一致）
× returns the worker result when the job finishes before the first event read starts 2019ms
× returns the worker result when the job finishes before the first event read starts 2027ms
Tests  2 failed | 10 passed (12)
native: promise rejected "AppError: 插件安装等待超时（2 秒）…"
sandbox: expected { ok: false, tools: [], …(2) } to match object { ok: true, …(1) }
```

失败在各自 2s 预算内、原因正是完成通知被跳过；其余 10 条（含两条“无 consumer 超时”）通过。

### 绿（恢复 `lastEventId: '0-0'`）

```text
pnpm exec vitest run packages/api/test/native-queue.test.ts packages/api/test/sandbox-probe.test.ts
（多轮，轮数记录存在冲突，不记确数；最后一次红验证恢复修复后再跑 2 轮）
Test Files  2 passed (2)
Tests  12 passed (12)
```

### 静态检查

```text
pnpm --filter @agentport/api typecheck
$ tsc -b            # 无错误输出

pnpm exec biome check <5 个改动文件>
Checked 5 files in 5ms. No fixes applied.
```

### 诊断记录与限制

- 首轮红出现过 20s 超时而非 2s 失败，定位为测试门闩自身缺陷：`holding` 写在连接外，扣住 QueueEvents 的 XREAD 时把 Queue 连接上的 `isFinished` 也扣住。改为每连接独立 `holding` 后，红连续 3 轮稳定在约 2.02s 预算内失败（2 failed | 10 passed），绿多轮 + 最终 3 轮通过。这是测试支撑缺陷，不是产品缺陷。
- 原 fullbackend 历史现象无法唯一归因：6 轮目标单跑 60/60 说明该窗口是时序相关；首例 20s 超时与“完成通知丢失后 `waitUntilFinished` 一直等到测试 20s 上限”一致，但历史日志不足以排除其它原因。末例“应超时却成功”与“超时用例遗留 worker 消费了后续 job”一致，`afterEach` 的 `close(true)` 关闭了这条路径，但同样无法用历史运行唯一证明。
- 未跑完整 backend 套件；按任务范围只跑两个目标文件、api typecheck 与 biome。主会话本轮完整 backend 为 241 files（1 failed / 240 passed）、2340 tests（1 failed / 2339 passed）；唯一失败是 `agent-package-runtime-environment.test` 全表计数并发干扰（expected 34 / actual 32），与本次队列修复无关，Sonnet 正在修复；不写全绿。
