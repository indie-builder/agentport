# eval 失败日志接线 patch（交 runtime B / `worker/index.ts` 单一写入者）

> 日期：2026-10-31。背景见 [eval 独立终审阻断](system-architecture-eval-review.md) 阻断 1。
> `packages/worker/src/index.ts` 当前由 runtime B 接线者独占；本分区未修改该文件。
> 本 patch 只脱敏 eval failed / settlement 日志，不改 processor、事件顺序或重试行为。
> 已落地的前提：`packages/worker/src/eval-runner.ts` 导出 `evalFailureDiagnostics(error)`，
> 返回 `{ errorName, errorCode? }`，不序列化 message/cause。

## 精确改动

### 1. import 区

现有：

```ts
import { handleEvalJobFailed, runEvalJob } from './eval-job.js';
```

改为：

```ts
import { handleEvalJobFailed, runEvalJob } from './eval-job.js';
import { evalFailureDiagnostics } from './eval-runner.js';
```

### 2. eval failed 事件（约 `src/index.ts:1281-1287`）

现有：

```ts
evalWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'eval job failed');
  // processor 前就终止的 deferred stalled failure 也在这里条件收口；事件回调不能留 unhandled rejection。
  handleEvalJobFailed({ db, logger, job, error: err }).catch((settleError: unknown) => {
    logger.error({ err: settleError, jobId: job?.id }, 'eval job failure settlement failed');
  });
});
```

改为：

```ts
evalWorker.on('failed', (job, err) => {
  // DB 错误原文可能含 SQL 参数；只记错误类型与 PG code。
  logger.error({ jobId: job?.id, ...evalFailureDiagnostics(err) }, 'eval job failed');
  // processor 前就终止的 deferred stalled failure 也在这里条件收口；事件回调不能留 unhandled rejection。
  handleEvalJobFailed({ db, logger, job, error: err }).catch((settleError: unknown) => {
    logger.error(
      { jobId: job?.id, ...evalFailureDiagnostics(settleError) },
      'eval job failure settlement failed',
    );
  });
});
```

## 验收

- 应用 patch 后 `pnpm --filter @agentport/worker typecheck` 通过。
- worker 日志中 eval 失败只出现 `jobId/errorName/errorCode`，不出现 `Failed query`、`params:` 或 secret。
- 不改 `evalWorker` 的 processor、并发、close 顺序；不影响现有 deferred failure / 重投行为。
- 本 patch 未由 eval 分区应用；控制会话串行交接给 index 写入者。

## 完成状态（2026-10-31，index 单一写入者）

- 已应用：`packages/worker/src/index.ts` 从 `./eval-runner.js` 导入 `evalFailureDiagnostics`，eval failed / settlement 两处日志只记 `jobId/errorName/errorCode`；未改 processor、cleanup、shutdown 与其它分区接线。
- 新增独立聚焦测试 `packages/worker/test/eval-index-log.test.ts`：真实导入 `src/index.ts`，捕获 failed 回调日志；红（旧代码仍带 `err` 原文）→ 绿。
- 验证：`pnpm --filter @agentport/worker typecheck` 通过；`eval-index-log` 1/1；`run-runtime-identity`、`run-pending-finish`、`memory-review` 共 40/40；`biome check` 通过。
- `packages/worker/src/index.ts` 已释放；后续「删除短事务修订」可直接写该文件。
