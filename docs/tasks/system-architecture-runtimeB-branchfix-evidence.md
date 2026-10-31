# runtimeB 分支补偿数据丢失修复证据

2026-10-31；工作树 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`，基线 `68241ba`。本任务只修 `packages/api/src/features/chat/routes.ts` 分支回滚的局部补偿顺序，并新增聚焦测试；未改运行时合同、主记录、LoopX 或 Git。

## 问题（终审 P1）

分支接口在复制失败时调用 `deleteCreatedConversation()` 后无条件删除 transcript / outputs / inputs。删除编排在关闭 ACK 失败/超时或 tx B 发现 queued/running 时会抛错，DB 会话行仍保留，但三条目录已被删，形成不可恢复的半份状态。

## 修复语义

`packages/api/src/features/chat/routes.ts` 的 `rollback`：

- 先取编排结果：只有返回非 `null` 成功快照（DB 行已确认删除）后才 `rm` transcript、`removeConversationOutputs`、`removeConversationInputs`。
- 编排抛错时捕获并记录 `branch rollback deletion failed; keeping runtime files`（含 `err`、`conversationId`），保留全部文件；不再吞掉原始复制错误。
- 返回给用户的仍是原复制失败的 `CONFLICT` 与其原文案，不被补偿失败的 503 覆盖。
- 未扩大删除授权、未新增错误码、未改响应 schema 或目录格式；其余三处 `deleteCreatedConversation` 补偿调用未改。

## 文件与改动量

| 文件 | 改动 |
|---|---|
| `packages/api/src/features/chat/routes.ts` | `rollback` 局部：约 +13/-4（仅该块） |
| `packages/api/test/branch-cleanup.test.ts` | 新增聚焦测试 1 文件，3 条用例 |

## 红 → 绿

命令统一为：

```
rtk bypass pnpm exec vitest run packages/api/test/branch-cleanup.test.ts --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-branchfix-<stage>.json
```

- `red`（修复前）：`success=false`，3/3 执行，1 passed / 2 failed。
  - ACK 拒绝：`sdk-sessions/<branchId>` 期望保留，实际 false。
  - 关闭期间 queued run 冲突：同一断言失败。
  - 成功补偿用例已通过（旧实现成功时确实会删）。
- `green`（修复后）：`success=true`，3 passed / 0 failed / 0 skipped。
- 回归：`chat-attachments.test.ts` 19 passed / 0 failed。
- `pnpm --filter @agentport/api typecheck`：通过。
- `biome check` 两个改动文件：通过。

报告位于 `/tmp/agentport-architecture-runtimeB-branchfix-red.json`、`...-green.json`、`...-regression.json`、`...-final2.json`（临时文件，不入库）。

## 测试如何命中故障缝

测试文件独占 Docker Redis 实例（与 `delete-lifecycle` 同法），避免默认 Pub/Sub 信道上其它套件的 responder 抢答，从而确定 ACK 归属。`ProbeCloser` 在关闭确认阶段拿到真实分支会话 id：

1. 落盘三类目录（transcript / outputs / inputs）。
2. `reject` 模式让 `closeIdle` 抛错 → ACK 失败 → 编排 503。
3. 或插入一条 queued run → tx B 活动检查 409。

两种失败后断言：分支行数仍为 1，三类目录均存在，HTTP 仍为原复制失败的 `CONFLICT`。成功用例断言行数为 0 且三类目录已删除。

测试替身只改动本文件，未改 `session-cleanup-responder.ts`。

## 日志与错误语义

| 场景 | DB | 文件 | 日志 | 响应 |
|---|---|---|---|---|
| 复制失败 + 关闭 ACK 失败/超时 | 保留 | 保留 | 原复制错误 `warn`（原因文案）+ 补偿失败 `warn` | 原 `CONFLICT` |
| 复制失败 + tx B queued/running 冲突 | 保留 | 保留 | 同上 | 原 `CONFLICT` |
| 复制失败 + 补偿成功 | 删除 | 删除（best-effort，清理失败沿用既有忽略处理） | 原复制错误 `warn` | 原 `CONFLICT` |

## 已知边界

- 编排返回 `null`（会话已不存在或已被并发删除）时同样保留文件，但不额外记录日志；这是安全侧选择，未新增分支以保持最小改动。
- 测试在关闭缝里预置三类文件，用于稳定观察 rm 行为；真实回滚时已复制出的 transcript 是同一被保护对象。

## 独立定向复审（2026-10-31）

结论：**PASS，无阻断项**。以 `68241ba` 为基线，仅复核 `routes.ts:963` 的 rollback 局部及 `branch-cleanup.test.ts`；扩读删除编排、活动判定及真实 Redis responder 以确认测试缝，不重审其他 routes 差异或正在并行修改的 locks。已读本树 CLAUDE / DEV-WORKFLOW / PITFALLS、本地 main 最新根及 api/db 规则、runtimeB-revision。

- 只有删除编排返回非 `null` 快照才进入三类目录清理；异常捕获记录补偿失败并返回 `null`，不改变原复制失败的 `CONFLICT` 与原因。编排原生返回 `null` 也保留文件，不额外记录日志可接受。
- 测试经真实 HTTP 路由、真实 PG A/B 和真实 Redis 请求/ACK；只替换容器关闭端，在 ACK 阶段取得实际分支 id 并落盘，未 mock 删除编排或 ACK。ACK 拒绝和 tx B queued 冲突均证明分支行仍存在、三类目录保留；成功补偿证明行和三类目录均删除。既有红灯 JSON 确认为 1 passed / 2 failed，失败对应上述两个保留场景。
- 先执行 `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db build`，成功后独立运行：

```sh
rtk bypass pnpm exec vitest run --project backend packages/api/test/branch-cleanup.test.ts packages/api/test/chat-attachments.test.ts --reporter=json --outputFile=/tmp/agentport-architecture-runtimeB-branchfix-review.json
```

真实结果：exit 0，`success=true`，branch 3/3、attachments 19/19，合计 **22 passed / 0 failed / 0 skipped**。backend 使用本轮随机迁移 PG 库及独享 Redis；branch 文件额外独占 Redis，避免跨库 Pub/Sub 抢答。

覆盖限制：本轮未单独注入 ACK timeout 或 running run；前者沿同一异常返回路径保留文件，后者在同一 SQL `inArray(status, ['queued', 'running'])` 判定中拒绝，均经静态核对。测试断言 HTTP 状态/错误码及目录存在性，原错误文案、补偿 warn 和 `null` 分支经静态核对。

文案校正：原表格“成功补偿”一行的“失败仅 warn”与实现不符，已改为“清理失败沿用既有忽略处理”。现有三个文件清理调用使用 `.catch(() => undefined)`，清理失败会被忽略。本修复未修改这一既有处理，本轮不将其扩展为产品源码改动。原复制失败与补偿删除失败的 warn 均存在。
