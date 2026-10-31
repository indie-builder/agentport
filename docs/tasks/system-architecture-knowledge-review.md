# knowledge 独立 Opus 终审验收缺口补齐

## 目标

补齐 [数据契约](system-architecture-data-contract.md) §8 与 [knowledge 实施证据](system-architecture-knowledge-evidence.md) 之间的验收缺口，不重构生产架构、不改 eval/chat/web/core/LoopX、不提交。

Opus 已核实当前 diff 无确认生产 bug、backend 199/web 129 复跑通过；本任务只把契约要求但实施证据未覆盖的五类场景写成真实行为测试，并给出诚实计数与证据。

## 方案

只在 `packages/{worker,db,api}/test` 对应 knowledge 套件内补用例；源码默认不改，真实红测证明缺陷后才做 knowledge 最小修复。

1. **worker sync 真实终态**（`packages/worker/test/knowledge-queue.test.ts`）：用真实 queue + 真实 `startKnowledgeWorker` + connector seam，分别覆盖 Redis cancel、worker 硬超时、来源停用；均断言 job/sync run/source 三表终态且 source.cursor 不推进。
2. **API queued 取消输给 claim**（`packages/api/test/knowledge-jobs.test.ts`）：独立 PG 上持有行锁，按真实锁等待顺序让 worker claim 先赢、API queued CAS 后输；确定性等待 `pg_locks` 事件而不是 sleep；API 必须发 cancel 信号，随后由真实 worker 三表收口。
3. **source 摘要/cursor 触发器故障回滚后可重试**（`packages/db/test/knowledge-lifecycle.test.ts`）：在既有回滚用例后移除触发器，重试同一 finishJob 提交成功。
4. **sync run sourceId 错配回滚**（同文件）：run 存在但 sourceId 与 job 不一致时 finishJob 抛错并回滚 job；恢复关联后同一提交成功。
5. **retry 重新 claim 保留 checkpoint/startedAt、拒绝终态 run**（同文件）：job 退回 queued 再 claim 时 run.startedAt 与 cursorAfter 不变；人为把 job 重置为 queued 后 claim 终态 run 必须抛错回滚，不复活终态。

隔离：真实 PG + Redis 走 backend globalSetup；需要全表/独占锁语义的套件使用 `createIsolatedDatabase`；不新服务、不迁移、不新增校验框架。

## 基线与范围

- 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`，分支 `refactor/system-architecture-modernization`。
- 起点：沿用本树当前未提交实现（knowledge A/B 已实施）；本轮只新增/修改测试与本记录。
- 独占写入：
  - `packages/worker/test/knowledge-queue.test.ts`
  - `packages/db/test/knowledge-lifecycle.test.ts`
  - `packages/api/test/knowledge-jobs.test.ts`
  - 本记录与证据文件
- 不改：源码（除非新用例先红且原因确认为 knowledge 生产缺陷）、eval/删除/chat/web/core/LoopX、DB schema/迁移、其他套件。

## 当前有效决定

- 测试一律先跑诚实用例；首绿记为验收补齐，不伪装 bugfix；首红先定位真实原因再最小修复。
- 不手工修异常数据制造绿：故障注入只用于证明回滚与拒绝路径，断言真实终态。
- 跨全表/独占锁用例使用独享随机库；其余沿用 globalSetup 随机库与临时 Redis，不回落共享库。
- 不加 sleep 控制竞争；用 `pg_locks` 等待事件与 connector 信号确定时序。
- 未获授权不 Git 发布，交付时说明未合入。
- 独立 Opus 已返回 PASS（14 files / 206/206、0 skipped），生产逻辑无确认错误；初始 199 与 web 129 是补齐前时点，不与本轮 206 混算。

## 已替代项及原因

无。

## 步骤

- [x] 读 CLAUDE/DEV-WORKFLOW/PITFALLS、数据契约 §8、knowledge 证据与模块规则。
- [x] 创建本记录，固定五类缺口与独占范围。
- [x] 写五类测试并先跑，记录红/绿真实原因。
- [x] 只在真实红测指向生产缺陷时做 knowledge 最小修复（本轮红测均为测试编排/断言问题，未改生产源码）。
- [x] 跑新增用例与完整受影响 suite，记录 counts/skip/files。真实结果：14 files / 206 passed / 0 failed / 0 skipped。
- [x] 更新证据文件，交 Opus 定向复核；独立 Opus 已返回 PASS（14 files / 206/206、0 skipped）。

## 改动文件

- `packages/worker/test/knowledge-queue.test.ts`
- `packages/db/test/knowledge-lifecycle.test.ts`
- `packages/api/test/knowledge-jobs.test.ts`
- `docs/tasks/system-architecture-knowledge-review.md`
- `docs/tasks/system-architecture-knowledge-review-evidence.md`
- `docs/PITFALLS.md`（新增行锁编排竞争的踩坑条目）

## 下一步

独立 Opus 定向复核已返回 PASS：14 files / 206/206、0 skipped（`/tmp/agentport-architecture-knowledge-gapfix-review.json`），生产逻辑无确认错误。未获授权不 Git 发布。

## 验证

真实命令、通过/失败/跳过数量与报告路径见 [执行证据](system-architecture-knowledge-review-evidence.md)。摘要：

- 首次红均来自测试编排/断言（DB `toBeInstanceOf(Number)`、API 行锁等待类型），不是产品缺陷；未改生产源码。
- 最终受影响套件：`14` files / `206` passed / `0` failed / `0` skipped（`/tmp/agentport-architecture-knowledge-gapfix-suite2.json`）。
- 独立 Opus 复审：同范围 `14` files / `206` passed / `0` skipped（`/tmp/agentport-architecture-knowledge-gapfix-review.json`），PASS。
- 分文件：DB 15/15、worker queue 14/14、API jobs 4/4，均 0 skipped。
- `biome check` 三个改动测试文件通过；`shared`/`core`/`db` 构建通过。
