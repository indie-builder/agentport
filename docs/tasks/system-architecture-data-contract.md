# 系统架构调整：调度与数据生命周期契约

> 裁决日期：2026-10-31。核实基线：`68241bab58ad8ec59727d70677bec790af2a5ae2`。
> 工作树：`/Users/xbjt/Documents/myself/agentport/.claude/worktrees/system-architecture-modernization`。
> 本次仅新增本文件；不修改主任务记录、其他契约、源码、配置或 LoopX，不提交。

## 1. 范围与裁决

实际缺口是：来源 cron 的入口只验证分段；知识同步的 job、sync run、source 摘要分别提交；评估批次在 worker 重启后的队列重投与 DB 认领契约不一致。这些都会影响真实单机运行，无须用多 worker 或新服务解释。

保持 Fastify / Zod、Drizzle / PostgreSQL、BullMQ / Redis 和官方 Agent SDK。实现不新增服务、Temporal、第二套执行循环、DB 表、列、索引或迁移；不改变登录，不清库，不发布 Git。现有 SDK 调用协议、沙盒执行与权限不在此次调整内。

| 项目 | 裁决 | 最小完整调整 |
|---|---|---|
| cron 输入语义 | 接受 | 保持 5 段、UTC；共享结构 schema，API 的 schema refine 复用 BullMQ 原生解析 |
| 一个坏来源阻断其他调度 | 接受 | scheduler 逐来源隔离更新/移除错误，继续其他来源；不在 worker 再加同一入口语义校验 |
| sync run 与 job 创建原子性 | 接受 | DB 仓库提供同一创建事务，手动、用户重试、定时触发共用 |
| 同来源重复同步 | 接受整合现有机制 | 三入口复用 scheduler 已有的事务级 advisory lock 与在途检查，不新建锁系统 |
| 同步终态与游标一致性 | 接受 | DB 仓库的一次事务拥有 job、sync run、source 摘要与成功游标；成功/失败/取消/对账/调度入队失败全覆盖 |
| 评估 worker 重启后自动续跑 | 拒绝 | 未要求恢复模型执行；已认领批次发生重投时明确失败，保留已有结果与 passed，不重跑 case |
| 评估失败生命周期 | 接受 | processor 的 awaitable 失败收口 + BullMQ 自身终止路径的 failed 事件兜底 + 原有孤儿对账 |
| 把评估孤儿阈值从 1 小时降至 5 分钟 | 拒绝作为本次修法 | 阈值不改变认领根因；保留 1 小时兜底，正常重投路径直接收口 |
| 新扫全表、outbox、持久终态意图、心跳/租约 | 拒绝 | 现有事务、jobId 去重与对账足够；不增加第二个恢复系统 |
| ops scheduler Queue 的 onClose | 延期 | 独立连接收尾问题，不阻断本契约；不夹带到此次数据修复 |
| retrieval 无引用导出 | 延期 | 与这三条链路无关，不做顺手清理 |

## 2. 独立核实的源码与官方依据

以下为基线行号，实施后以函数名定位。

### 2.1 cron

- `packages/shared/src/knowledge.ts:253–255` 仅以正则要求恰好五个非空段，且只接受一个字面空格作间隔；`sourceBase.syncCron` 在创建入口使用它。
- `packages/api/src/features/knowledge/source-routes.ts:21–30` 的 PATCH 复制同一正则。
- `packages/shared/src/ops.ts:8–11` 已有导出的 `cronSchema`，trim 后按空白分为五段。它是结构校验，不是实际 cron 解析。
- `packages/api/src/features/ops/schedule-sync.ts:24–30` 已有 `isSchedulableCron`：`getNextMillis(Date.now(), { pattern: cron, tz: 'UTC' }) !== undefined`，同时捕获解析异常。
- `packages/api/src/features/ops/routes.ts:30–38` 已在 Fastify body schema 中以 refine 使用实际解析。
- `packages/worker/src/knowledge/scheduler.ts:173–191` 逐条 await upsert / remove，没有逐来源错误隔离；一条表达式抛错会跳出整轮，后面的 upsert 和删除均不执行。
- 本地版本为 BullMQ `6.5.0`，其传递依赖是 `cron-parser@5.10.2`。`dist/cjs/classes/job-scheduler.js:297–347` 中 defaultRepeatStrategy / getNextMillis 使用同一 `CronExpressionParser.parse`，无下一次时间时返回 undefined；upsert 没有下一次时间时也不创建 job。

本次用包的 CommonJS 正式入口执行，无 Redis、无服务启动：

```sh
node --input-type=commonjs -e 'const {getNextMillis}=require("./packages/api/node_modules/bullmq"); for(const pattern of ["99 99 99 99 99","0 0 31 2 *","*/5 * * * *","0 0 29 2 *"]){try{console.log(JSON.stringify({pattern,next:getNextMillis(Date.UTC(2026,9,31),{pattern,tz:"UTC"})}));}catch(e){console.log(JSON.stringify({pattern,error:e.message}));}}'
```

真实结果：

| pattern | 结果 |
|---|---|
| `99 99 99 99 99` | 抛 `Constraint error, got value 99 expected range 0-59` |
| `0 0 31 2 *` | 抛 `Invalid explicit day of month definition` |
| `*/5 * * * *` | 返回 `1793405100000` |
| `0 0 29 2 *` | 返回 `1835395200000`，闰日表达式可调度，不应误拒绝 |

BullMQ 官方说明默认 cron 策略使用 cron-parser，秒字段可选。产品仍选择已有的五段分钟粒度，并不因底层支持秒就扩展入口。

### 2.2 知识同步

- 手动来源同步 `source-routes.ts:384–400` 与用户重试 `knowledge/routes.ts:1153–1173` 先插入 sync run，再独立创建 job；第二次写失败会留下无 job 的 run。
- scheduler 的创建 `knowledge/scheduler.ts:55–87` 已是事务，并有同来源事务级 advisory lock，但入队最终失败 `104–114` 又分别提交 job 与 sync run，未更新 source 摘要。
- `knowledge/queue.ts:247–271` 先 finishJob，再 finishSyncRun，再 updateSource。第一笔已经把 job 变终态后，后面失败时，重投无法再次 claimJob；现有对账只扫描 queued/running job，不能再找回这个 running sync run。
- `knowledge/ingestion.ts:1127–1137` 的成功路径也先 finishSyncRun，再独立提交 source 游标与摘要；而 job 还要等 queue 返回后另一次 finish。失败与取消时不能仅包装 queue.finish 而漏掉这里。
- `knowledge/reconcile.ts:99–108` 先将 job failed，再独立 finishSyncRun，且 catch 后只告警；source 摘要不更新。
- `knowledge/routes.ts:1189–1202` 的排队取消也是三次独立写。运行中取消现有语义是只发 Redis cancel key，等 worker abort 后写终态，应保留。
- `repo/knowledge.ts:1096–1112` 的 finishSyncRun 没有活动状态条件；`runSync:993–996` 无条件恢复 running。新契约不能让这两处重新打开已经结束的同步。
- source 删除对 sync run 与 job 都有 `ON DELETE CASCADE`，见 `packages/db/src/schema.ts:1414,1458`；删除来源后不重建关联记录。

### 2.3 评估

- `packages/api/src/features/eval/routes.ts:300–349` 的批次与 caseSnapshot 持久化后再入队，jobId 为 evalRunId，没有配置 attempts，实际默认一次。
- `packages/db/src/repo/eval.ts:130–136` 仅允许 `claimedAt IS NULL AND status='running'` 的首次认领。
- `packages/worker/src/eval-runner.ts:149–160` 对已有 claimedAt 的重投直接 return。BullMQ 会把正常返回的 processor 标为 completed，即使 DB 批次仍 running。
- `packages/worker/src/index.ts:1275–1294` 的 eval failed 事件只日志，没有收口。
- `eval-runner.ts:291–302` 最终 finishEvalRun 失败被 catch 后只日志，processor 仍可能成功返回；权限检查之前的 agent 查询等错误则可能抛到 BullMQ，但同样没有批次失败收口。
- `packages/worker/src/shutdown.ts:4,55–76` 对 active run worker（包括 eval worker）排空最多等 10 秒，之后仍可能退出；BullMQ 的 close 自身没有业务超时，这 10 秒是项目施加的进程排空期限。
- `packages/worker/src/reconcile.ts:16,97–123` 当前只探测超过 1 小时的 running eval，job 消失/终态才 failed；active/waiting/delayed 等保持。调低这个阈值不会让已认领的重投执行正确。
- `packages/db/src/schema.ts:778` 的 partial unique index 使该 agent 的 running 批次阻塞新评估。终态必须真实落库，不能只把 Redis job completed。

BullMQ `6.5.0` 本地 `worker.js:43` 默认 `maxStalledCount=1`；stalled job 可回 waiting。它与普通失败 attempts 不同。`job-scheduler.js`、`worker.js:620–627` 与 `moveStalledJobsToWait-9.lua:74–98` 同时确认：超出 stalled 次数时可产生 deferredFailure，BullMQ 可能在进入业务 processor 前就失败。因此只包业务 processor 的 catch 仍不覆盖全部失败路径。

### 2.4 一手资料

查证日期均为 2026-10-31：

- [BullMQ Repeat strategies](https://docs.bullmq.io/guide/job-schedulers/repeat-strategies)：cron-parser、可选秒字段。
- [BullMQ Repeat options](https://docs.bullmq.io/guide/job-schedulers/repeat-options)：`pattern` 与 `tz`，UTC 用 `tz: 'UTC'`。
- [BullMQ Stalled jobs](https://docs.bullmq.io/guide/workers/stalled-jobs)：stalled 回 waiting 重新处理，超过停滞限制失败。
- [BullMQ Graceful shutdown](https://docs.bullmq.io/guide/workers/graceful-shutdown)：close 等 active 完成、没有内置等待上限；非正常退出依赖 stalled 恢复。
- [BullMQ Stop retrying jobs](https://docs.bullmq.io/patterns/stop-retrying-jobs)：`UnrecoverableError` 跳过重试；attemptsStarted 与 attemptsMade 不同。
- [Drizzle Transactions](https://orm.drizzle.team/docs/transactions)：`db.transaction`、事务返回值与 rollback。
- [PostgreSQL Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)：多条写入以全有或全无方式提交；单独执行的每条语句默认各自提交，不能实现跨语句原子性。

不涉及 SDK 配置、目录、API 或恢复接口变更，未以 SDK session resume 冒充评估批次恢复；本次无需扩查或修改 SDK。

## 3. cron 契约

### 3.1 单一规则与依赖边界

1. 保留已有 `@agentport/shared` 导出的 `cronSchema`，由 `shared/src/knowledge.ts` 从 `./ops.js` 引用，删除本地 cron5Schema；知识来源 PATCH 同样使用 cronSchema。结构规则统一为 trim、五个空白分隔段、UTC，null 表示关闭定时同步，PATCH undefined 表示不改。
2. 将现有 isSchedulableCron 移至 `packages/api/src/lib/cron.ts`。这里只需要 BullMQ 的 getNextMillis，不创建 Queue。ops 路由与知识来源路由都直接从该文件导入；schedule-sync 删除原函数，不留无调用转发。
3. 知识创建 body 用 knowledgeSourceInputSchema.refine 校验非 null 的 syncCron，PATCH 在本地 patch schema 上 refine 非 null / 非 undefined 的 syncCron，path 指向 `syncCron`。沿用 Fastify Zod 入口与 INVALID_INPUT 响应，handler 不再 parse。ops 沿用原有 schema refine，改 import 即可。
4. shared 保持浏览器可用且只依赖现有 Zod，不引入 BullMQ、cron-parser 或 Node 模块。不存在 shared → API 或 worker → API 导入。
5. 不新增 shared 公共符号：cronSchema 已由 `shared/index.ts` 的 `export * from './ops.js'` 导出。本分区不修改 shared/index.ts；该文件继续归另一共享导出契约的执行者所有。若实施发现必须新增跨包符号，先由主会话明确单一导出写入者后再派发，不并写 barrel。

### 3.2 scheduler 行为

- DB 仍为调度权威；active 且 cron 非空的来源参与 desired。
- 不预先再调用 isSchedulableCron / cron-parser：upsert 本身调用 BullMQ 解析；这里只隔离既有库内坏数据和外部 Redis 操作失败，不建立第二套入口校验。
- 每个来源的“移除旧的不同 pattern → upsert 当前 pattern”在独立 try/catch 内执行。已有 pattern 与 DB 不同必须先移除，避免 DB 改成坏值后旧 cron 继续触发；移除失败则本来源暂不 upsert，记录来源 ID 并交下轮重试。
- upsert 抛错或返回 undefined 均不能当成功；记录来源 ID 与操作阶段后继续其余来源。无需修改来源业务 status、cron 或写永久错误字段。
- existing 与 desired 相同则不重复 upsert。对不再 desired 的 scheduler 逐条删除，也逐条隔离失败。Redis 整体不可用时允许入口 getJobSchedulers 失败并交现有顶层日志，不声称本轮成功。
- 非法来源不阻断合法来源更新及暂停/删除来源的 scheduler 回收。source 自身数据保留供用户修正；不自动迁移或“修好”cron。

## 4. 知识同步数据所有权

### 4.1 创建事务

在 `packages/db/src/repo/knowledge.ts` 内新增一个有明确领域含义的 `createSyncJob(db, sourceId)` 操作，替代三入口各自拼装的 run/job 插入。无须拆新仓库层或引入通用状态机。

事务顺序固定：

1. 复用现有 `pg_advisory_xact_lock(hashtext(sourceId))`；在事务内重读来源，缺失 / 非 active / 已有 queued 或 running job 分别返回可区分的结果。
2. 读取本次 cursorBefore、baseId，自主生成 sync run 与 job 的 TypeID。
3. 同一事务插入 queued sync run 与 queued sync job，job payload 为 `{type:'sync',sourceId,syncRunId}`；任一失败全部回滚。
4. 返回两行或必要 ID；Redis add 始终在 DB commit 之后，不把网络等待放进 DB 事务。

手动入口将缺失映射现有 404、非 active / 在途映射 409；用户 retry 对 sync 同样检查当前来源，生成新 run/job，保留旧历史。定时触发对已暂停/删除/清空 cron 的陈旧消息继续 skipped；它在创建前保留现有 cron 非空条件，创建操作再承担当前 source 与在途事实。定时重复变 duplicate。

手动与定时同时发生是现有代码明确承认的实际窗口，可能共同改同一 source 游标；此次是把已经存在的 scheduler 锁用于三条真实入口，不增加分布式防护或多 worker 支持。

API 入队失败沿用现有错误返回：DB 中完整的 queued pair 留给既有 knowledge reconciler 补投。scheduler 现有三次入队失败后若保留“本次触发 failed”语义，必须调用下述原子终态操作，`fromStatus='queued'`，且仅 CAS 赢者改 sync run / source；若任务已被 worker 认领，不再覆盖。不要同时保留独立 updateJob + finishSyncRun。

### 4.2 终态的唯一实现者

DB 仓库的 finishJob 升级为“一个 job 的原子终态提交”，所有业务调用方通过它完成。queue、API cancel、scheduler 与 reconciler 是调用者，不是四份终态实现。

输入保留现有 status/error/step/progress，并明确：

- `fromStatus` 是单个允许的前态，默认 running；排队取消与 scheduler 入队失败传 queued。不得用“所有活动状态都能收”模糊化来源。
- sync 成功结果包括 cursorAfter 与 stats，复用现有 FinishSyncRunInput 的字段类型；仅成功 sync 必须携带结果。非 sync 不需要。
- 操作返回真正完成状态转换的 job 或 null；只有非 null 的调用方计数 / 报成功。

一次 Drizzle 事务的范围：

1. `UPDATE knowledge_jobs ... WHERE id=? AND status=fromStatus RETURNING *`，作为终态 CAS。未赢返回 null，之后不写 sync run 或 source。
2. 对 sync，用持久化 job 的关联 sourceId / payload.syncRunId 定位其 sync run，条件更新 queued/running 为与 job 相同的终态；同时确认其 sourceId 与 job.sourceId 相同。现有表没有 syncRunId 外键，因此关系缺失/错配必须抛错回滚，不能把“payload 解析失败”当成允许半提交的理由。
3. 同步更新 source.lastSyncAt / lastSyncStatus / lastError。成功才在同一事务推进 source.cursor，并写 run.cursorAfter / stats。失败、取消不推进 source.cursor；run 的中间 cursorAfter 可保留为诊断检查点，绝不能自动当成下次来源游标。
4. 使用同一完成时间。任何后续 SQL 失败，job 终态也必须回滚，继续让现有重投/对账看到活动 job。

DB 生成的 sync payload 在创建操作形成确定类型。外部 API 与队列外部数据沿用各自信任边界校验；这里的关联条件是跨行数据完整性，不在 queue、ingestion、reconcile 多层重复 safeParse 后静默跳过。

仍活跃的 job 关联行不应凭空缺失：来源真实删除有 cascade，不重建已删数据。删源并发若导致事务失去对象，让本次事务失败或 CAS 为 null，后续按已删除处理，不能插回来源。

### 4.3 摄取、认领、重试

- runSync 只执行内容同步、权限失效处理、文档禁用与检查点，返回 `{cursorAfter,stats}`。删除末尾 finishSyncRun / updateSource(cursor) 两写，不在业务层成功结束 sync run。
- runKnowledgeJob / dispatchKnowledgeJob 传递 sync 的成功结果，其余类型返回 void；queue 获得结果后只调用一次原子 finishJob。非 sync/wiki 的既有行为保持。
- 同步开始时不再无条件把终态 run 改回 running。将 queued sync run → running、startedAt 设置收进 claimJob 的同一事务；job 条件 queued → running 仍是唯一认领依据。内部重试时 run 可保持 running，重复认领不得擦除已落库检查点或重开终态。
- 现有 retryable 失败将 job running → queued，sync run 保持 running，source.cursor 不变；SIGTERM 退回 queued 同样保留。这里是同一次运行的尝试，不是 terminal finish。
- 内容版本、blob、外部抓取和整个 connector 循环不放进长事务。此次原子性只涵盖创建 pair、认领相关行与最终关联状态/游标，不声称整个同步所有文档全有或全无。
- 原 createSyncRun / finishSyncRun 若只剩测试引用，更新 fixture 使用真实创建/认领操作后删除；若还有合理内部用途，只作为事务内辅助，不再留可被业务直接调用的第二终态入口。删除前全仓 rg 引用，避免死导出。

### 4.4 每条终态路径必须接入

| 入口 | 前态 | 事务结果 |
|---|---|---|
| worker 成功 | running | job/run succeeded，source 成功摘要与 cursor，run stats 同步提交 |
| worker 永久错误/最后一次失败/超时 | running | job/run failed，source 失败摘要，cursor 不动 |
| worker 运行中用户取消或停用来源 | running | job/run cancelled，source 取消摘要，cursor 不动 |
| API 排队取消 | queued | job/run cancelled 与 source 摘要一次提交；输给认领则保持现有发 cancel key 逻辑 |
| scheduler 三次入队失败 | queued | 仅 CAS 赢者把 pair failed、更新 source 摘要；已认领不覆盖 |
| knowledge reconciler 判丢失/超时 | running | 使用相同 finishJob，不再直接 update 终态后另调 failSyncRun |
| 重试退回 / SIGTERM 退回 | running → queued | 非终态，不填 endedAt、不写 source 终态摘要、不推进游标 |
| 重复投递已终态 / 迟到取消 / 迟到对账 | 无可转换前态 | null，无任何关联写入 |

不得新增“扫 sync run 找孤儿”的第二轮全表修补：修的是造成孤儿的提交边界。已有历史异常若需要处理，由用户另行授权一次性操作，不自动修主库。

## 5. 评估生命周期契约

### 5.1 状态与恢复目标

- DB status=running 同时代表尚未认领和执行中，保留现有 schema。claimedAt=NULL 可首次执行，claimedAt 非空表示该批次曾经启动过。
- 仍为 waiting/delayed 且未认领的任务，在 worker 重启后正常首次执行；只重启 API 不影响 worker 的进行中批次。
- 已认领批次的 stalled 重投不续跑、不清 claimedAt、不再创建 case 子 run、不重复模型花费；批次明确 failed，错误说明执行被中断、需要重新发起。
- 保留已经持久化的 eval_results、caseSnapshot 与 DB 的 passed。不能传 passed:0 覆盖已完成结果，也不能把未完成 case 合成成功/失败结果。
- 已 failed/succeeded/cancelled 的批次投递仍正常跳过；迟到结果和 finish 保持现有 status=running 条件，不覆盖终态。

### 5.2 最小完整失败路径

1. executeEvalRun 保留首次 claim。claim 失败后重读当前批次：已终态/不存在则跳过；仍 running 且已认领，则抛明确的 `UnrecoverableError` 表示不能恢复本批次。不能把它作为成功的 duplicate return。生产调用由持有该 job 的 BullMQ processor 发起，不创建额外直接执行入口。
2. 删除 executeEvalRun 最终 finish 只日志吞错的 catch：最终持久化失败必须传播给 processor。单 case 预期失败仍按现有逻辑记录结果，不改变 serial case 语义、snapshot 或权限校验。
3. 在现有 eval processor 边界 await executeEvalRun，并以 try/catch 捕获执行/认领/最终持久化错误；catch 中 await DB 条件失败操作后重新抛错。DB 失败操作更新 status/error/finishedAt，**不写 passed**。可放在 `repo/eval.ts` 的领域操作 `failEvalRun`；不为此让普通 finish 的 passed 参数变得含糊。
4. evalWorker.failed 仍记录日志，并在真实最终失败时调用同一个 failEvalRun；覆盖 BullMQ 在 processor 前产生的 deferred stalled failure。显式 `.catch` 记录 DB 收口失败，不能给 EventEmitter 留 unhandled rejection；事件回调不是关停可等待的事务保障。
5. 当前 eval 没有应用重试，保持默认一次，不为本次修改添加 attempts/backoff。若需要判断事件是否最终失败，必须包含 UnrecoverableError / deferredFailure，不能仅凭 attemptsMade 比 attempts；本地已证实 stalled 与普通 attempts 分离。优先保持当前一次失败就终止的配置，不增加通用重试策略。
6. 同一条件失败操作可被 processor 与 failed 事件先后调用，只允许 running → failed，第二次无操作；它不得改变原有已取消或成功批次。原子单条 UPDATE 即可，不需要额外多表事务。
7. 现有 reconcileOrphanedEvalRuns 作为进程/DB 持续不可用的兜底，保留 1 小时候选阈值、5 分钟 tick 和队列 probe。Redis 失败、active/waiting/delayed 时不误杀。它不是正常 stalled 重投收口的前提。

不修改 shutdown 的 10 秒排空期限，不无限等待评估，不增加进程 bootId / 租约字段 / 新队列监听服务。未要求终止已发出的普通 agent 子 run：它们仍由现有 agent run 的超时、取消及 reconciler 管理；此次不扩展跨批次取消协议。批次失败后不再从旧 processor 开新 case，既有 status 检查与 addResult 的条件事务负责拒绝迟到结果。

### 5.3 诚实的持久化边界

- 正常 processor 错误或已认领重投，在处理本次投递时立即尝试将 DB 置失败；不能出现“Redis completed、DB running”且被当作正确完成的路径。
- BullMQ 在 processor 前终止时 failed 事件尝试收口；若该进程在事件处理前又死掉、DB 持续不可用或 Redis 数据丢失，可能仍需原有 1 小时阈值后的对账。不能承诺在所有故障下秒级结束。
- 不保证 exactly once 模型调用，也不保证从中断点续跑；保证此次选择的恢复政策是显式失败、保留已落库证据、不主动重跑同一批次的模型。

## 6. 文档冲突与精确修正文案

本次只在本文件列出修法，以下文件实际修改归后续实施/集成者。

1. `docs/ARCHITECTURE.md:484` 的“重启不丢跑批”把 API 解耦与 worker 执行恢复混在一起，当前源码只能证明批次/快照持久化。实施后替换整行：

   > `| 评估跑批在 worker 队列内 | 批次与用例快照先持久化，API 重启不打断 worker 执行；未认领的队列任务可在 worker 重启后执行 | eval-runs 并发 1；已认领批次中断后不续跑，重投或队列最终失败时条件置 failed，保留已有结果；事件或 DB 收口失败仍由原有超过 1 小时的队列探测对账兜底 |`

2. `docs/ARCHITECTURE.md:424` 明确记录手动同步非事务检查窗口。三入口创建操作统一后，替换最后两句为：

   > 手动同步、失败任务重试与定时触发通过同一 DB 创建事务，使用来源级事务锁检查 queued/running 任务；同一来源已有在途同步时，手动/重试返回 409，定时触发跳过。

3. `docs/ARCHITECTURE.md:434` 声称“终态只写一次”，对 job CAS 成立，对当前 finishSyncRun 无条件写及多次独立提交不完整。实施后补充：

   > 知识 job 终态由 DB 仓库条件事务一次提交；sync 同时提交 sync run 终态、source 摘要与成功游标。失败/取消不推进 source.cursor；中间检查点仅保存在本次 sync run，任务内部重试不重新打开终态。

4. `packages/shared/src/ops.ts:7` 注释说“完整解析在 core/worker 侧”，实际已在 API ops schema refine 完成。按本方案应改成“结构校验；实际可调度性由 API schema 使用 BullMQ 解析”，不再误导后续执行者。
5. `knowledge/queue.ts:243–245` 注释说“队列是终态唯一写入方”，实际 success、API cancel、scheduler、reconcile 都在写。实现后唯一实现方为 DB 仓库；更新该注释及 runSync 的重开注释，避免注释与职责继续冲突。

第 2、3、5 项是本次架构契约实施后必须同步的事实变化；不得提前把尚未实现的行为写成已交付。

## 7. 受影响文件与单一写入者

以下是后续实现清单，当前未修改这些文件。

| 分区 | 实现文件 | 对应测试与范围 |
|---|---|---|
| A：cron 入口 | `packages/shared/src/knowledge.ts`、`packages/shared/src/ops.ts` 注释；`packages/api/src/lib/cron.ts` 新增；`packages/api/src/features/ops/{routes,schedule-sync}.ts`；`packages/api/src/features/knowledge/source-routes.ts` schema 部分 | `packages/api/test/{knowledge-source-routes,schedule-routes}.test.ts` |
| B：knowledge 生命周期 | `packages/db/src/repo/knowledge.ts`；`packages/api/src/features/knowledge/{source-routes,routes,service}.ts` 创建/取消/重试部分；`packages/worker/src/knowledge/{queue,ingestion,reconcile,scheduler}.ts` | `packages/worker/test/knowledge-{ingestion,queue,queue-dispatch,reconcile,scheduler}.test.ts`；`packages/api/test/knowledge-{source-routes,jobs}.test.ts`；必要时新增 DB 原子性测试 |
| C：eval 恢复 | `packages/db/src/repo/eval.ts`；`packages/worker/src/{eval-runner,index}.ts` eval 局部；`reconcile.ts` 默认不改，若为复用收口更新只限 eval 部分 | `packages/worker/test/{eval-snapshot,eval-result-write,reconcile-eval,reconcile-eval-redis,shutdown}.test.ts`；新增实际重启投递测试（见 §8）；`packages/api/test/{eval,eval-enqueue-failure}.test.ts` |
| D：集成与文档 | `docs/ARCHITECTURE.md` 的上述局部 | 由主会话指定单一文档执行者；本契约写者本次不碰 |

### 并行执行策略

- Sonnet high 分区 C 可立即与 A/B 并行，文件独立。复杂恢复判断已由本契约固定，执行者不自行扩为续跑。
- A/B 不能同时写 source-routes.ts、knowledge-source-routes.test.ts；scheduler.ts 的 cron 隔离与事务调用也不能交给两个写者同时改。最少交接的方案是同一 Sonnet high 知识分区执行者承担 A+B，在其内部先固定 DB 操作签名，再迁移调用方。
- 若主会话需要把 A 独立并行：A 先只提交 ops/shared/lib 与 schedule-routes.test.ts 的成果，将 source-routes 的 schema 变更和知识 scheduler 隔离交给 B；明确不写知识共享文件。B 等待 A 的 helper 落地后接入知识 schema，此处唯一依赖是 import 的确定接口。
- `shared/index.ts` 不归本分区；已有 cronSchema 导出足够。本文件不产生其他 shared 导出请求。
- 若另一系统架构分区正在改 worker/index.ts，C 先完成 eval-runner/repo/test，再由被指定的 index.ts 单一写入者接入 eval processor 与事件；不得两个代理并写不同段。
- 集成后由独立 Opus high 按固定 diff + 本契约 + 验证证据终审，重点核对三行事务、所有终态入口、重投不重复模型和测试隔离。此次未授权提交，终审不能变成 Git 发布动作。

## 8. 全范围验收

### 8.1 行为矩阵与故障注入

必须用可失败的行为测试证明，不能只 mock 调用次数或只跑 typecheck。

**cron / scheduler**

- POST 与 PATCH 都拒绝 `99 99 99 99 99`、`0 0 31 2 *`，path=`syncCron`、400 INVALID_INPUT，DB 不落非法值；有效范围/步长/闰日、trim/多空白、null 关闭、PATCH 省略均覆盖。
- 真实隔离 PG 直接插入一个坏 active source 与一个合法 source，再运行真实 Redis scheduler.sync：坏来源告警，合法 scheduler 仍存在；同轮 paused/已删来源的 scheduler 仍移除。
- 来源从已有有效 cron 直接改成非法值时，旧 scheduler 被移除，后续合法来源继续同步；不改变该来源 DB 状态。
- Redis upsert/remove 的确定性故障可按队列 seam 注入，证明逐来源继续和下一轮修复；不要为测失败关闭共用 Redis。

**knowledge 创建 / 终态**

- 真 PG 使用定向临时触发器在 knowledge_jobs INSERT 抛错：三入口对应的创建操作都不得留下 sync run。测试调用真实仓库，不能把 transaction mock 成函数调用。
- 手动、retry、定时并发争用同 source：只产生一对活动记录，其余 409/duplicate；来源不同可独立创建。直接用 Promise.all 触发真实锁竞争，不靠 sleep 估计并发。
- 分别在 sync run 终态 UPDATE、source 摘要 UPDATE、source 成功 cursor UPDATE 注入 SQL 错误：job/run/source 全部回滚；去掉故障后重试同一提交成功，不留 job 已终态而 run running。
- 成功 / 失败 / 超时 / 运行取消 / queued 取消 / 调度入队失败 / reconcile 均断言 job、sync run、source 三处；成功才改 cursor，失败/取消保持原 cursor。source.lastError 与 run/job 一致，失败统计不伪造成功。
- 排队取消与 claim 竞争：取消赢则三处 cancelled；claim 赢则 API 发取消信号，由 worker 一次事务收口。重复完成、迟到对账和重复取消不覆写既有终态/游标。
- sync retry 与 shutdown 回 queued、checkpoint、凭证失权处理、完整枚举删除、Wiki follow-up、非 sync / wiki 任务原有测试继续通过。直接 runSync 的单测应改为验证执行结果；完整状态断言必须经过真实 claim + terminal seam，不继续把摄取层当终态拥有者。
- 入队异常后要用真实 Redis reconciler 证明 queued pair 能补投；scheduler 最后入队失败的 queued CAS 不得覆盖已经被 worker claim 的任务。

**eval 重启 / 重投**

- 必须新增真实 PG + Redis + 实际进程退出测试。可增加 `packages/worker/test/fixtures/eval-worker-process.ts` 最小测试入口，只装配生产 eval 执行/失败边界，禁止复刻恢复算法；如必须提取 seam，只提取实际会被生产与测试共同调用的 eval job handler，不复制 index.ts 实现。
- 父测试创建独立队列/前缀、随机 PG；子进程在真正 claim 后发 IPC ready，在 case/model seam 阻塞。父进程收到 ready 后 SIGKILL 子进程，再启动替代消费者；通过 BullMQ 真 stalled 检测重新投递同 job，最终 DB failed、finishedAt 非空、部分 results/passed 保留、没有新增 case 子 run，且该 agent 能再次创建评估。测试内可缩短 lockDuration/stalledInterval，不改生产时限，不伪造手工更改 DB 或删锁冒充重启。
- 为验证真实生产边界，测试子进程应只替换 case 执行/外部模型边界，不替换 claim/finish/fail/queue 逻辑。已有 eval-snapshot / eval-result-write 保留 snapshot、权限、单 case 失败与真实 DB 结果故障覆盖。
- 未认领任务重启后首次执行；已终态投递无操作；已有 active/waiting/delayed 的运行不被 reconciler 误杀；Redis probe 失败不改批次。
- processor 外层错误、最终 finish SQL 故障、BullMQ 在进入 processor 前的 deferredFailure 都必须验证 DB 收口。processor/failed 事件收口本身失败时，用原有 1 小时对账测试证明最终释放 running 唯一占用；不要把这个故障改成五分钟阈值。
- 单批次已完成部分 case 后终止时 passed 不归零；cancel 与失败竞争只允许第一终态，晚到结果不能推进 passed。不要因批次失败删除已有报告或子 run。

### 8.2 隔离与验证命令

从本工作树执行；不要启动 API/开发 worker，不读取生产数据，不清主库。backend globalSetup 已负责每轮随机迁移 PostgreSQL 库与独享临时 Redis；全表 reconcile 用例进一步使用自身随机库，避免不同私有队列把同库别的记录当孤儿。基础设施不可用出现 skip 时，不得宣称数据生命周期验收通过。

下面是实施后的验收命令，**本次仅定契约，尚未执行这些行为测试**。现有依赖/dist/typecheck/build 全仓基线绿属于上游事实审计提供的证据，本次不把它记作修改后验证。

```sh
pnpm --filter @agentport/shared build
pnpm --filter @agentport/core build
pnpm --filter @agentport/db build
pnpm typecheck
pnpm exec vitest run --project backend --no-file-parallelism packages/api/test/knowledge-source-routes.test.ts packages/api/test/knowledge-jobs.test.ts packages/api/test/schedule-routes.test.ts packages/worker/test/knowledge-scheduler.test.ts packages/worker/test/knowledge-ingestion.test.ts packages/worker/test/knowledge-queue.test.ts packages/worker/test/knowledge-queue-dispatch.test.ts packages/worker/test/knowledge-reconcile.test.ts packages/worker/test/knowledge-retry-policy.test.ts packages/worker/test/eval-snapshot.test.ts packages/worker/test/eval-result-write.test.ts packages/worker/test/reconcile-eval.test.ts packages/worker/test/reconcile-eval-redis.test.ts packages/worker/test/shutdown.test.ts packages/api/test/eval.test.ts packages/api/test/eval-enqueue-failure.test.ts
```

固定新增测试路径，便于独立验收与复核：

- `packages/db/test/knowledge-lifecycle.test.ts`：真实事务及故障注入。
- `packages/worker/test/eval-redelivery.test.ts`：真实进程退出与 BullMQ 重投。
- 仅在需要子进程入口时新增上述 fixture；它不是产品入口，不启动整套 app。

```sh
pnpm exec vitest run --project backend --no-file-parallelism packages/db/test/knowledge-lifecycle.test.ts packages/worker/test/eval-redelivery.test.ts
pnpm exec vitest run --project backend --no-file-parallelism packages/worker/test/knowledge-wiki.test.ts packages/worker/test/knowledge-wiki-update.test.ts packages/worker/test/knowledge-sources.test.ts packages/api/test/knowledge-routes.test.ts
pnpm build
```

新增 cron helper 或 eval handler 的机械检查只跑实际改动路径；不额外创建 CI/钩子。implementation 验证需报告通过/失败/跳过数量，确认新增数据/重启测试无 skip，并保留故障注入断言与真实运行结果。上述测试路径是契约约定；若合并分区调整文件名，同步一次验收命令，不让命令引用不存在文件。

## 9. 本次文档交付证据与边界

- 已读本树 CLAUDE.md、DEV-WORKFLOW §2、PITFALLS；核实 HEAD 为声明基线。
- 初始 `.vitest/json/output.json`、`.loopx/`、`docs/tasks/system-architecture-modernization.md` 为既有差异，本次不编辑或还原。
- 已独立读上述具体源码与 BullMQ 本地实现，并查阅 §2.4 一手资料；cron 的四个输入有本次真实执行结果。
- 本次没有实现数据修复，也没有新增/运行 PG/Redis 故障注入或重启测试；它们是后续实施的完成门槛，不是已通过结果。未启动服务、未清库、未动登录或 Git 发布。
- 没有全仓重扫、真实模型/企业来源验收或 SDK 续跑研究；不做与本契约无关的 onClose、死导出或基础设施改造。
