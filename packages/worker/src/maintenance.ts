import { pathToFileURL } from 'node:url';
import { createDb, newId, repo, schema } from '@agentport/db';
import { Queue, Worker } from 'bullmq';
import pino, { type Logger } from 'pino';
import { loadConfig } from './config.js';

export const MAINTENANCE_QUEUE = 'maintenance';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface Retention {
  runDays: number;
  messageDays: number;
  agentVersions: number;
}

export interface MaintenanceSummary extends Retention {
  agentVersionsDeleted: number;
  runsDeleted: number;
  runMessagesDeleted: number;
  orphanMessagesDeleted: number;
  durationMs: number;
}

/** 审计表与 eval_results 不在清理范围内：前者要长期保留，后者用于历史对比。 */
export async function runMaintenance(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  retain: Retention,
): Promise<MaintenanceSummary> {
  const startedAt = Date.now();
  const agentVersionsDeleted = await repo.maintenance.pruneAgentVersions(db, retain.agentVersions);
  const runs = await repo.maintenance.pruneRuns(db, retain.runDays);
  const orphanMessagesDeleted = await repo.maintenance.pruneOrphanMessages(db, retain.messageDays);
  const summary: MaintenanceSummary = {
    ...retain,
    agentVersionsDeleted,
    runsDeleted: runs.runs,
    runMessagesDeleted: runs.messages,
    orphanMessagesDeleted,
    durationMs: Date.now() - startedAt,
  };

  await db.insert(schema.auditLog).values({
    id: newId('audit'),
    actor: 'worker',
    action: 'maintenance.pruned',
    target: JSON.stringify(summary),
    status: 'ok',
    durationMs: summary.durationMs,
  });
  logger.info(summary, 'maintenance pruned');
  return summary;
}

/** 注册每日重复任务；同一 scheduler id 重复注册只会更新，不会叠加。 */
export async function startMaintenanceWorker(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  redisUrl: string;
  retain: Retention;
}): Promise<Worker> {
  const queue = new Queue(MAINTENANCE_QUEUE, { connection: { url: input.redisUrl } });
  await queue.upsertJobScheduler('daily', { every: DAY_MS });
  await queue.close();

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    () => runMaintenance(input.db, input.logger, input.retain),
    { connection: { url: input.redisUrl } },
  );
  worker.on('failed', (job, err) => {
    input.logger.error({ jobId: job?.id, err }, 'maintenance job failed');
  });
  return worker;
}

// 手动触发：pnpm --filter @agentport/worker maintenance
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const { db, pool } = createDb(config.DATABASE_URL);
  try {
    await runMaintenance(db, logger, {
      runDays: config.RETAIN_RUN_DAYS,
      messageDays: config.RETAIN_MESSAGE_DAYS,
      agentVersions: config.RETAIN_AGENT_VERSIONS,
    });
  } finally {
    await pool.end();
  }
}
