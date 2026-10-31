import { type Database, repo } from '@agentport/db';
import { evalRunJobSchema } from '@agentport/shared';
import type { Logger } from 'pino';
import { evalFailureDiagnostics, executeEvalRun, publicEvalFailureMessage } from './eval-runner.js';

const evalRepo = repo.evalRepo;

/**
 * 评估 job 的生产边界：processor 与 failed 事件共用同一个条件失败收口。
 * 测试进程只替换外部 case/模型边界，继续调用本文件，不复刻恢复判断。
 */
async function settleFailure(
  db: Database,
  logger: Logger,
  evalRunId: string,
  error: unknown,
): Promise<void> {
  try {
    await evalRepo.failEvalRun(db, evalRunId, publicEvalFailureMessage(error));
  } catch (settleError) {
    // 收口写入本身失败时保留原始错误继续抛；reconcile 仍是超过 1 小时的兜底。
    // DB 错误原文可能含 SQL 参数，日志只留受控诊断字段。
    logger.error(
      { evalRunId, ...evalFailureDiagnostics(settleError) },
      'eval run failure settlement failed',
    );
  }
}

/** processor：执行/认领/最终持久化错误先条件置 failed（不写 passed），再抛给 BullMQ。 */
export async function runEvalJob(input: {
  db: Database;
  logger: Logger;
  redisUrl: string;
  job: { data: unknown };
}): Promise<void> {
  const parsed = evalRunJobSchema.safeParse(input.job.data);
  if (!parsed.success) {
    throw new Error(`invalid eval job payload: ${parsed.error.message}`);
  }
  const { evalRunId } = parsed.data;
  try {
    await executeEvalRun({
      db: input.db,
      logger: input.logger,
      redisUrl: input.redisUrl,
      evalRunId,
    });
  } catch (error) {
    await settleFailure(input.db, input.logger, evalRunId, error);
    throw error;
  }
}

/** failed 事件兜底：覆盖 BullMQ 在进入 processor 前产生的 deferred stalled failure。 */
export async function handleEvalJobFailed(input: {
  db: Database;
  logger: Logger;
  job: { data: unknown } | undefined;
  error: unknown;
}): Promise<void> {
  const parsed = evalRunJobSchema.safeParse(input.job?.data);
  if (!parsed.success) return;
  await settleFailure(input.db, input.logger, parsed.data.evalRunId, input.error);
}
