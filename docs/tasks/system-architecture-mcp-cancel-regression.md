# MCP 取消 HTTP 回归：job 观测竞态

## 目标
修复全仓联合验证唯一失败：`packages/api/test/agent-tools-cancel-http.test.ts` 第 206 行
`expect(await getQueue().getJob(run.id)).toBeUndefined()` 偶发失败（Job 仍在）。
不改生产代码、不靠宽松断言或固定 sleep 凑绿；保留取消终态、断开中止、job 最终不存在的断言。

## 方案
取消路径先提交 DB 终态 `cancelled`，再执行 `queue.getJob(...).remove()`；测试在轮询到 DB
终态后立刻断言 job 不存在，把「DB 已终态」误当成「queue.remove 已完成」。同一测试文件里的
`afterAll`/桩实现与 `agent-tools-cancel-signal.test.ts` 已证明 remove 是取消后的异步步骤。

改为复用现有 `waitFor`（25ms 轮询、5s 上限）等待 job 消失，再断言 DB 终态：
先等 `getJob === undefined`，再 `runStatus === 'cancelled'`。两项都是有界真实条件，不引入 sleep/skip。

## 基线与范围
- 基线：`68241ba`；本任务只改测试与任务记录。
- 允许改动：`packages/api/test/agent-tools-cancel-http.test.ts`、本记录。
- 生产 MCP 取消路径不在本任务 diff；未发现生产缺陷。

## 当前有效决定
- 根因判定为测试观测竞态，不是生产取消逻辑缺陷。
- 不使用固定 sleep、不降低断言、不 skip。
- 不修改 `cancelAgentRun` / stub 的取消语义。

## 已替代项及原因
- 原断言「DB 终态后立即断言 job 不存在」被有界 `waitFor` 替代：前者依赖 remove 恰好在两次
  断言之间完成。

## 步骤
- [x] 单 suite 基线复跑（8 次串行 + 8 并发）未自然复现，确认是窄窗口偶发。
- [x] 控制实验：在桩的 DB 取消与 `getJob/remove` 之间临时加 250ms，稳定复现第 206 行同一失败。
- [x] 改为 `waitFor(job === undefined)` 后再断言 `cancelled`。
- [x] 同窗口放大 250ms 下复跑通过，证明新等待吸收该窗口。
- [x] 移除临时放大代码，跑最终单 suite、相关 cancel/queue 并行套件与 8 并发压测。

## 改动文件
- `packages/api/test/agent-tools-cancel-http.test.ts`
- `docs/tasks/system-architecture-mcp-cancel-regression.md`

## 下一步
无。若最终 Opus 终审要求，复核本测试 diff 与验证证据。

## 验证
环境：随机独立 PostgreSQL（`createIsolatedDatabase`）+ 共享 Redis，仅清理本套件 run/job。

| 场景 | 命令/产物 | 结果 |
|---|---|---|
| 基线单 suite（8 串行） | 本地 vitest dot | 8/8 全 3 passed（未自然复现） |
| 基线 8 并发 | `/tmp/agentport-architecture-final-mcp-cancel-stress-*.json` | 8/8 全 3 passed |
| 控制实验（250ms 放大窗口，旧断言） | `/tmp/agentport-architecture-final-mcp-cancel-ordering-red.json` | 2 passed / 1 failed：`expected Job{ …(21) } to be undefined`（与全仓失败一致） |
| 修复后单 suite | `/tmp/agentport-architecture-final-mcp-cancel-final-single.json` | 3/3 passed |
| 修复后 250ms 放大窗口 | `/tmp/agentport-architecture-final-mcp-cancel-widened-green.json` | 3/3 passed |
| 相关 cancel/queue 并行（10 文件） | `/tmp/agentport-architecture-final-mcp-cancel-final-parallel.json` | 52/52 passed，0 skip |
| 修复后 8 并发 | `/tmp/agentport-architecture-final-mcp-cancel-final-stress-*.json` | 8/8 全 3 passed |

`biome check` 该测试文件通过。未跑全仓（按要求）。
