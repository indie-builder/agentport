# 系统架构调整分区 C：评估失败生命周期独立终审阻断与修复范围

> 复核日期：2026-10-31。树：`system-architecture-modernization`。
> 依据：数据契约 §5、§8；[eval 实施记录](system-architecture-eval-evidence.md)；独立 Opus 终审结论。
> 本文只记录发现、修复边界与验证计划；实现前先落此文件。

## 结论

**当前结论：PASS（2026-10-31 case output 修复独立最终复审）。** 最后一个阻断 `eval_results.output` 的 case 级 DB 原文泄露已在写入边界修复；本轮独立运行 14 文件、112 passed、0 failed、0 skipped。原阻断 2、3 与 index 日志补接保留前轮通过结论，本轮相关回归通过。历史阻断、修复和最终验证见下文。

原独立 Opus 终审给出 3 个阻断。修复范围为 eval 解析、失败收口、测试与 fixture；`worker/index.ts` 由单一写入者补接日志，本次复审不修改源码。

## 阻断 1：DB/infra 错误原文经 `eval_runs.error` 泄露到成功响应

### 真实链路

1. `eval-runner.ts` 的 `dbQuery` 把 Drizzle 错误包成 `DbError(message, cause)`；Drizzle 的 message
   包含 `Failed query: ...` 与 `params: [...]`，参数可能含用户输入或 secret。
2. `eval-job.ts` 的 `settleFailure` 用 `errorMessage(error)` 原样写 `failEvalRun`。
3. `eval-runner.ts` 的 `crashed` 分支也把原始 `errorMessage` 写进最终 `finishEvalRun`。
4. `GET /api/eval/runs`、`GET /api/eval/runs/:id`、`GET /api/eval/runs/:id/compare`、
   `GET /api/eval/runs/:id/export` 都成功返回该字段，绕过 HTTP 错误脱敏。
5. `worker/index.ts` 的 eval failed 事件与 settlement catch 直接 `logger.error({ err })`，
   把同一份含 SQL 参数的错误写进 worker 日志。

### 修复要求

- 只保留最小的领域中断消息：`UnrecoverableError`（已认领重投/stalled 终止）的 message 原样落库。
- 其余 DB/infra/未知错误统一落固定、可操作的公开文案；不写原始 message。
- 日志只带受控诊断字段（`evalRunId`、错误名、PG code），不序列化错误对象或 message。
- 不吞掉 processor 的原始错误：`runEvalJob` 仍向 BullMQ 抛原错误，不改 BullMQ 重试/终止行为。
- 不新建错误分类框架：复用现有 `DbError`、`UnrecoverableError` 与 `AppError` 语义，只加一个
  公开失败文案 helper。
- `eval-runner` 的最终 `crashed` 同样走该 helper，避免第二个泄露口。
- API 层不放宽/改写 schema，也不在响应层做字符串兜底；修复在写入边界完成。

### 验证

- 新增真实 PostgreSQL 故障：触发器抛错并携带 secret；断言 `eval_runs.error` 是固定公开文案，
  不含 `Failed query`、`params:`、SQL/secret。
- 新增 API wire 用例：真实 PG 故障后经 `GET /api/eval/runs`、`/:id`、`/compare`、`/export`
  正常 200，响应体无 SQL/params/secret。
- 原测试中期望 `Failed query` 或 `eval_results` 出现在 `eval_runs.error` 的断言必须删除或改为
  固定公开文案；`runEvalJob` 仍抛原错误的断言保留。

## 阻断 2：两条失败链没有被真实验证

### 2a. BullMQ 超出 `maxStalledCount` 的 deferred failure

当前测试只用 `SIGKILL` 触发一次 stalled 重投，替代 worker 的 processor 仍会执行；没有证明
BullMQ 在进入 processor 前产生 deferred failure 时，`failed` 事件仍能把 DB 收口，且 processor
确实未被调用。

修复验证：

- 独享 Redis + 独立 PG。
- 子进程用生产 `runEvalJob` 认领并阻塞，父测试 `SIGKILL`。
- 替代 worker 设 `maxStalledCount: 0`、短 `lockDuration/stalledInterval`，让真实
  `moveStalledJobsToWait` 写入 `deferredFailure`。
- 断言替代 worker 的 processor 计数为 0，job 以 stalled 原因失败，`handleEvalJobFailed`
  收口 DB 为 failed，保留已落库 passed/results，并释放同 agent 的 running 唯一占用。
- 不降低生产 `maxStalledCount`、不新增恢复协议；只在测试 worker 配置里制造超出阈值。

### 2b. `failEvalRun` 自身 SQL 失败

需要证明：processor 收口写入失败时仍抛原错误；真实 `failed` 事件回调有 `.catch`、没有
unhandled rejection；原 1 小时 queue-probe reconciler 最终释放 running 唯一占用。

修复验证：

- 真 PG 触发器让 `eval_runs` 的 `status='failed'` UPDATE 失败。
- 另一个触发器让最终 `status='succeeded'` UPDATE 失败，使 processor 先走到失败收口。
- 真实 BullMQ worker 跑 `runEvalJob`，`failed` 监听按生产方式调用
  `handleEvalJobFailed(...).catch(...)`；断言无 unhandledRejection、DB 仍 running。
- 移除触发器、把 `created_at` 调到 1 小时前，用真实 queue probe 跑
  `reconcileOrphanedEvalRuns`，断言最终 failed、错误为既有 `EVAL_LOST_ERROR`、同 agent 可再次
  创建评估。
- 不把阈值改成 5 分钟，不伪造手工 DB 收口。

## 阻断 3：redelivery fixture 消费共享 `agent-runs` 队列

`eval-redelivery.test.ts` 的 fixture 使用共享 `RUNS_QUEUE` 与 backend globalSetup 的 Redis。
同轮其它套件若也消费 `agent-runs`，可能抢走本次子 run job。仅用 mock 不能证明干扰消失。

修复要求：

- 该测试进程使用 `startRedisContainer()` 独享 Redis，配合 `createIsolatedDatabase()` 独立 PG。
- 子进程、替代 worker、run fixture 都指向独享 Redis。
- 清理只关闭本次 queue/worker、停止本次容器、删除本次数据库；不删除共享队列里的其它 job。
- 不新增生产协议、不更换生产队列名、不用 mock 冒充隔离。
- 同轮 consumer 干扰以真实独立基础设施消除，不能声称“mock 后不存在”。

## 文件边界

独占：

- `packages/worker/src/eval-job.ts`
- `packages/worker/src/eval-runner.ts`
- `packages/db/src/repo/eval.ts`（只有必须时）
- `packages/worker/test/eval-result-write.test.ts`
- `packages/worker/test/eval-redelivery.test.ts`
- `packages/worker/test/eval-snapshot.test.ts`
- `packages/worker/test/fixtures/eval-worker-process.ts`
- 新增 API wire 用例（`packages/api/test/eval-error-redaction.test.ts`）

不修改：

- `packages/worker/src/index.ts`（runtime B 接线者独占）。必须改日志时只在
  [eval 接线 patch](system-architecture-eval-integration-fix.md) 给出精确 diff，不并写。
- knowledge/chat/core/shared/web、其他分区、LoopX、Git 发布、付费模型。

## 验证命令与证据

先红后绿；完整 eval 范围与新增场景分别输出 JSON：

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/eval-redelivery.test.ts \
  packages/worker/test/eval-result-write.test.ts \
  packages/worker/test/eval-snapshot.test.ts \
  packages/api/test/eval-error-redaction.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-eval-fix-red.json
```

绿后追加原有 eval 范围（eval/reconcile/shutdown/api/db）到
`/tmp/agentport-architecture-eval-fix-green.json`，并报告文件数、通过/失败/跳过。

## 完成报告要求

- 改动的文件清单与每个文件的行为变化。
- 红/绿 JSON 的 counts，新增场景无 skip。
- 真实 deferred failure、settlement 失败 + 1h reconcile、独享 Redis 的 redelivery 证据。
- `worker/index.ts` 是否待接线：列出 patch 文件与精确位置。
- 后续独立 Opus 只复核本次修复与新增影响；不重跑本报告已覆盖的全量探索。

## 独立定向复审（2026-10-31）

### 基线、范围与结论

- 树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`；HEAD/基线 `68241bab58ad8ec59727d70677bec790af2a5ae2`。既有全部未提交差异属于原任务及并行分区，未覆盖、还原或提交。
- 已读根 CLAUDE、DEV-WORKFLOW、PITFALLS、数据契约 §5/§8、eval evidence/integration-fix，以及本地最新 main `e87704bf093c87dab932d61b1d98580d17e2b6cf` 的 API/worker/db 模块规则。
- 固定审查 runner/job、repo eval 必要局部、index 的 eval processor/failed 日志接线及指定测试；因发现公开结果泄露，必要扩读 `repo/chat.ts` 的 admitChatRun 消息写入和 eval API detail/compare/export 输出路径。
- 按现有单 worker、eval concurrency=1、默认一次尝试审查，不扩展多 worker 恢复或理论防护。未重审已通过的核心生命周期、runtime B cleanup 待修段或其他分区。
- **结论：阻断。只剩下列 1 个安全阻断；原阻断 2、3 与 index 日志接线 PASS。**

### 必须修复 1：单 case 内的 DB 错误仍作为结果正文公开

- **位置**：`packages/worker/src/eval-runner.ts:291-303`（尤其 `else output = errorMessage(result.failure)`）；错误来源在该文件 `runOneCase` 的 `dbQuery`，包含 `chatRepo.admitChatRun`、读取子 run/消息等真实数据库调用。
- **场景**：在本次新建并迁移的随机库中预置授权用户、专家、快照用例；临时 `BEFORE INSERT ON messages` 触发器抛真实 PG 错误，再调用生产 `executeEvalRun`。`admitChatRun` 的消息 INSERT 失败，Drizzle message 含完整 SQL 与消息 JSON 参数；`dbQuery` 包成 `DbError`，case 的 `Effect.result` 将其当普通用例失败，之后原文成功插入 `eval_results.output`。没有模型调用、真实队列消费或开发数据操作。
- **实测结果**：批次 `status=failed`、`evalRun.error=null`、1 条结果；`results[0].output` 同时命中 `Failed query`、`params:` 和本次随机 secret；真实 `repo.evalRepo.getComparison` 返回的 `rows[0].base.output` 也包含 secret。第一次对 `agent_runs` INSERT 注入也确认 SQL/params 泄露；第二次消息 INSERT 将随机 secret 放入实际 SQL 参数，确认内容泄露。
- **公开链路**：`packages/db/src/repo/eval.ts:322-330` 原样保留 output；`packages/api/src/features/eval/routes.ts:473` 返回 compare rows，`:510` 导出 results，`:538` 返回 detail results。当前 wire 测试只在 addResult 自身失败后手动调用失败事件收口，没有成功持久化失败 case 的 output，因此未覆盖此路径。列表不含结果正文，此次没有发现列表新增泄露。
- **最小修复**：在这唯一 case 失败写入处识别已确定的 `DbError`，对其使用现有固定公开文案；其他预期 case/领域失败保持当前行为，不泛化错误框架、不在响应层做字符串过滤。新增真实消息写入故障的行为用例，断言持久化 output 及 detail/compare/export 的 output 不含 SQL/params/注入 secret，并保留普通 case 失败仍继续下一条的行为。不要用 secret 本身正常存在于 prompt 的事实冒充 output 无泄露，应直接检查 output 字段。
- **不修复的后果**：数据库写入/读取偶发失败时，评估报告可把数据库结构和 SQL 参数作为模型回答返回；固定 `eval_runs.error` 无法遮住该结果字段。

### 已通过的定向复核

1. **批次公开错误与日志**：`publicEvalFailureMessage` 对 DbError/普通错误落固定文案；crashed、processor settlement、index failed/settlement 日志只给受控诊断字段；真实 PG wire 用例 list/detail/compare/export 全部通过。以上通过不包含前述 case output 漏口。
2. **UnrecoverableError 实际边界**：runner 唯一构造点为固定 `EVAL_INTERRUPTED_ERROR`；BullMQ `worker.js:587-591` 在 processor 前将 deferredFailure 构造成该类，stalled Lua 写的是固定 `job stalled more than allowable limit`。`dbQuery` 总是构造独立的 `DbError`，`DbError` 不是 Error 子类；SQL 错误的文本/name 不会改变 `instanceof UnrecoverableError`。额外真实 PG 错误实测 `instanceof` 为 false、公开文案为固定值。未发现 SQL 伪装类型的实际入口，不为此另报理论阻断。
3. **deferred failure**：真实 SIGKILL + 替代 BullMQ worker `maxStalledCount=0` 用例通过；processor 调用 0，failed 事件使 DB failed，passed/results/子 run 集合保持，释放同 agent 唯一占用。
4. **settlement SQL 故障**：真实 finish/fail 触发器故障用例通过；processor 原始 finish 错误保留，failed 回调无 unhandled rejection、日志无原文，故障解除后原 1 小时 queue-probe reconciler 释放 running 占用。未改变阈值。
5. **隔离**：redelivery 自建随机 PG 和独享 Redis；子进程、替代 worker、agent-runs fixture 使用该容器地址。flushdb、容器删除与数据库删除只针对本次返回资源，不消费同轮 globalSetup 队列。
6. **index 接线**：真实 index 导入测试捕获生产 failed 回调，两处 payload 精确断言 jobId/errorName/errorCode；收口仍收到原错误，异步 catch 有覆盖。该 mock 边界证据与真实队列套件已在同次独立运行整合。

### 本次独立验证

先构建当前 shared/core/db/sandbox dist：

```sh
pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db --filter @agentport/sandbox build
```

退出码 0。随后完整运行指定 eval/API wire/index 及导入 index 的相关套件：

```sh
pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/eval-snapshot.test.ts \
  packages/worker/test/eval-result-write.test.ts \
  packages/worker/test/eval-redelivery.test.ts \
  packages/worker/test/reconcile-eval.test.ts \
  packages/worker/test/reconcile-eval-redis.test.ts \
  packages/worker/test/shutdown.test.ts \
  packages/api/test/eval.test.ts \
  packages/api/test/eval-enqueue-failure.test.ts \
  packages/api/test/eval-error-redaction.test.ts \
  packages/db/test/eval-run-page.test.ts \
  packages/worker/test/eval-index-log.test.ts \
  packages/worker/test/run-pending-finish.test.ts \
  packages/worker/test/run-runtime-identity.test.ts \
  packages/worker/test/memory-review.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-eval-fix-review.json
```

真实结果：**14 文件，105 passed，0 failed，0 skipped，退出码 0**。其中原完整 eval/API 范围 64 项、index 日志 1 项、相关入口回归 40 项。独立 PG 追加实测发现的 output 泄露未改测试源码，因此不计入这 105 项；库与触发器随本次独享库关闭删除。

历史 JSON 已核对：`/tmp/agentport-architecture-eval-fix-full.json` 64/64、`/tmp/agentport-architecture-eval-indexlog-green.json` 1/1、`/tmp/agentport-architecture-eval-indexlog-suites.json` 40/40。本轮不回退源码重做其 red。

### 文档冲突与后续

- evidence 的历史段落仍描述共享 Redis，并将 integration patch 标为未应用；其后修复记录、integration-fix 完成段与当前源码已表明独享 Redis和两处日志接线落地，以后者为准。按本轮仅允许更新本复审文件的边界，未改其他文档。
- evidence 的“分区 C 已完成”需以本次阻断为准；105 项全绿不足以关闭安全目标。修复后只复核 case DB 错误的写入/公开路径及新增影响，不重扫已通过生命周期。
- 本轮仅更新本复审记录；未改源码/测试/配置、LoopX、Git 发布或其他分区。未运行真实付费模型、全仓测试或 runtime B cleanup 验收。

## 修复记录（2026-10-31）

- `packages/worker/src/eval-runner.ts`：case 失败写 `eval_results.output` 前识别 `DbError`，复用既有 `publicEvalFailureMessage` 落固定公开文案；普通用例/队列/领域失败仍保留可读原文。只改这一处写入边界，未引入新错误框架。
- `packages/worker/test/eval-result-write.test.ts`：新增真实随机 PG `BEFORE INSERT ON messages` 故障，secret 位于消息 SQL 参数；断言持久化 output 为固定文案且不含 `Failed query`/`params:`/消息表/secret；另加普通队列失败仍返回可读原文的对照。
- `packages/api/test/eval-error-redaction.test.ts`：新增同一真实 messages INSERT 故障经生产 `executeEvalRun` 后，DB output 与 detail/compare/export 的 output 均不含 SQL/params/secret。
- `packages/worker/test/eval-snapshot.test.ts`：既有 `db down` 期望改为固定公开文案；该 mock 经 `dbQuery` 包装为 `DbError`，行为随安全目标变化。
- 红：2 files / 11 tests，2 failed（两条新用例均以 `Failed query: insert into "messages"` 失败），9 passed，0 skipped（`/tmp/agentport-architecture-eval-outputfix-red.json`）。
- 绿：14 files / 108 tests，108 passed，0 failed，0 skipped（`/tmp/agentport-architecture-eval-outputfix-green.json`）；`@agentport/worker`、`@agentport/api` typecheck Done。
- 未修改 `worker/index.ts`、repo/locks/agents/chat、其余分区；未 Git/LoopX/付费模型，未改用户数据。
- 结论：本安全阻断已按最小写入边界修复，待独立 Opus 只复核本修复与新增影响。

## case output 修复独立最终复审（2026-10-31）

**结论：PASS，无剩余阻断。** 本结论仅关闭上述最后一个 case 级 DB output 泄露，不扩展为其他分区验收。

### 固定范围与判断

- 树与基线保持 `/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`、`68241bab58ad8ec59727d70677bec790af2a5ae2`；读根 CLAUDE、DEV-WORKFLOW、PITFALLS 和本地最新 main `e87704bf093c87dab932d61b1d98580d17e2b6cf` 的 worker/api/db 模块规则、eval review/evidence 后开始。
- 核对相对基线的实际 runner/result-write/snapshot diff 和新增 API wire 文件；只重新审查 case 失败写入分支、直接调用及类型边界、对应新增断言。未重审已通过的 deferred/redelivery/Redis/index 设计，但保留其完整相关回归。
- `packages/worker/src/eval-runner.ts:295` 在唯一 case 失败 output 写入点识别 `instanceof DbError` 并调用既有 `publicEvalFailureMessage`。`runOneCase` 的版本读取、`admitChatRun` 事务、子 run 读取和消息读取均经该文件同一 `dbQuery` 构造 `DbError`，中间没有转换为普通 Error；`Effect.result` 保留该错误对象。外层 DB 失败不经过 case output，沿既有批次公开文案收口。未发现本次修复遗漏的同根直接数据库路径，不增加理论防护。
- `packages/worker/test/eval-result-write.test.ts:207` 与 `packages/api/test/eval-error-redaction.test.ts:187` 通过真实 PG messages INSERT 触发器，在实际消息 SQL 参数中放入随机 secret，走生产 `executeEvalRun`。本轮持久化 output 和真实 detail/compare/export 的 output 都精确等于固定公开文案，无 `Failed query`、`params:` 或 secret。断言直接检查 output；prompt/snapshot 合法保留原输入不被误判为错误泄露。API 用例的精确相等也排除了 messages 表名等 SQL 文本。
- `packages/worker/test/eval-result-write.test.ts:247` 的普通队列错误仍为 `run queue unavailable`；snapshot 的 child failed/cancelled/timeout 用例保持领域说明并继续下一条。`:417` 的 `db down` mock 经真实 `dbQuery` 包装为 `DbError`，改为固定文案符合新边界。
- `DbError` 是 core 导出的普通类；本地包装与分类使用同一导入的类，无需新增 `_tag` 兼容分支或按文本猜测错误类型。未改公开 API schema、结果结构或队列协议。

### 独立验证与证据

- 已核 `/tmp/agentport-architecture-eval-outputfix-red.json`：2 文件、11 项，9 passed、2 failed、0 skipped；两条新增 messages INSERT 用例均在 output 精确相等断言处失败，实际收到 `Failed query: insert into "messages" ...`。未回退当前源码重做历史红。
- 已核 `/tmp/agentport-architecture-eval-outputfix-green.json`：14 文件、108 passed、0 failed、0 skipped；补充 green2 为 2 文件、11 passed。
- 本轮先执行 `pnpm --filter @agentport/shared --filter @agentport/core --filter @agentport/db --filter @agentport/sandbox build`，全部 Done、退出码 0；并行执行 `pnpm --filter @agentport/worker --filter @agentport/api typecheck`，两者 Done、退出码 0。
- 本轮独立完整命令：

```sh
rtk bypass pnpm exec vitest run --project backend --no-file-parallelism \
  packages/worker/test/eval-snapshot.test.ts \
  packages/worker/test/eval-result-write.test.ts \
  packages/worker/test/eval-redelivery.test.ts \
  packages/worker/test/reconcile-eval.test.ts \
  packages/worker/test/reconcile-eval-redis.test.ts \
  packages/worker/test/shutdown.test.ts \
  packages/api/test/eval.test.ts \
  packages/api/test/eval-enqueue-failure.test.ts \
  packages/api/test/eval-error-redaction.test.ts \
  packages/db/test/eval-run-page.test.ts \
  packages/worker/test/eval-index-log.test.ts \
  packages/worker/test/run-pending-finish.test.ts \
  packages/worker/test/run-runtime-identity.test.ts \
  packages/worker/test/memory-review.test.ts \
  --reporter=json --outputFile=/tmp/agentport-architecture-eval-outputfix-review.json
```

- 真实结果：**14 文件、112 passed、0 failed、0 skipped，退出码 0**；相对历史绿报告增加的 4 项全部在并行更新的 shutdown 套件（9 → 13），其余 13 文件项数一致。未审查该并行变更的设计，不把其通过扩大为其他分区 PASS。报告的 31 test suites 包含嵌套 describe，不冒充文件数。
- 四个目标源码/测试文件在本轮完整回归前后 SHA-256 一致：runner `0abbbd9c5ae7589a134d5fdeffc2e01a604e0295341dceb8be21b26c1da715b0`；result-write `15a0c4254f8ac75f5cc4a40cf8dd6cbb1d6e6e01960e09b00bfadf8f4da29608`；snapshot `e5b3627cf244e22545ad50f8fd5bd5736ddff1364cbd592542cc0b2f2ece6fb2`；API redaction `e6c0f07f57a6776fd262bf4f2ce7e3d00cfe3cbe1909fa3f951fa6112ee8c5c7`。
- globalSetup 经 setup-env 提供随机已迁移 PostgreSQL 库和独享临时 Redis；result-write、redelivery 额外各建自己的随机库，redelivery 独享 Redis。所有数据库/Redis 前置实际可用，无 skip；teardown 无错误，清理只针对返回的本次资源。未修改用户登录、开发库或共享 Redis。

### 限制、文档冲突与交付

- evidence 历史段落仍有共享 Redis / integration patch 未应用的旧描述（前轮已登记）；以其后修复段和当前源码为准。evidence 下一步的“待独立 Opus”已由本节 PASS 完成；本轮只更新获准的本 review 文件。
- 相关入口回归中的 runtime identity 故障注入仍打印非 eval 的 `agent run crashed` SQL 日志；它属于既有其他分区日志边界，不是本次 case output 修复的回归，本轮未扩大到该日志设计审查。
- 仅修改本 review 文档；未改源码/测试/配置、LoopX 或 Git，未提交、未合入。未运行付费模型、全仓测试、动态删除 shorttx 或其他已通过分区复审。
