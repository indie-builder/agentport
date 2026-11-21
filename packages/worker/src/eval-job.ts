import { type Database, repo } from '@agentport/db';
import { evalRunJobSchema } from '@agentport/shared';
import type { Logger } from 'pino';
import { evalFailureDiagnostics, executeEvalRun, publicEvalFailureMessage } from './eval-runner.js';

const evalRepo = repo.evalRepo;

async function settleFailure(
  db: Database,
  logger: Logger,
  evalRunId: string,
  error: unknown,
): Promise<void> {
  try {
    await evalRepo.failEvalRun(db, evalRunId, publicEvalFailureMessage(error));
  } catch (settleError) {
    logger.error(
      { evalRunId, ...evalFailureDiagnostics(settleError) },
      'eval run failure settlement failed',
    );
  }
}

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
