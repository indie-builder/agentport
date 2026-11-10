import { pathToFileURL } from 'node:url';
import { outputMessageAnchors } from '@agentport/core';
import { createDb, repo, schema } from '@agentport/db';
import { createBunRedisClient, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { eq } from 'drizzle-orm';
import pino, { type Logger } from 'pino';
import { loadConfig } from './config.js';

const MAINTENANCE_QUEUE = 'maintenance';
const DAY_MS = 24 * 60 * 60 * 1000;

interface Retention {
  runDays: number;
  messageDays: number;
  agentVersions: number;
}

interface MaintenanceSummary extends Retention {
  agentVersionsDeleted: number;
  runsDeleted: number;
  runMessagesDeleted: number;
  orphanMessagesDeleted: number;
  channelMessagesDeleted: number;
  durationMs: number;
}

/** 审计表与 eval_results 不在清理范围内：前者要长期保留，后者用于历史对比。 */
export async function runMaintenance(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  retain: Retention,
  workspacesDir: string,
): Promise<MaintenanceSummary> {
  const startedAt = Date.now();
  const agentVersionsDeleted = await repo.maintenance.pruneAgentVersions(db, retain.agentVersions);
  // 已发布成果的锚点先完整读齐再删消息；任一 manifest 读取失败都中止本轮，不留不可 fork 的成果。
  const conversations = await db
    .select({ slug: schema.agents.slug, conversationId: schema.conversations.id })
    .from(schema.conversations)
    .innerJoin(schema.agents, eq(schema.agents.id, schema.conversations.agentId));
  const retainedMessageIds = new Set<string>();
  for (const conversation of conversations) {
    for (const id of await outputMessageAnchors({
      root: workspacesDir,
      slug: conversation.slug,
      conversationId: conversation.conversationId,
    })) {
      retainedMessageIds.add(id);
    }
  }
  const pruneOptions = { retainedMessageIds: [...retainedMessageIds] };
  const runs = await repo.maintenance.pruneRuns(db, retain.runDays, pruneOptions);
  const orphanMessagesDeleted = await repo.maintenance.pruneOrphanMessages(
    db,
    retain.messageDays,
    pruneOptions,
  );
  const channelMessagesDeleted = await repo.maintenance.pruneChannelMessages(
    db,
    retain.messageDays,
  );
  const summary: MaintenanceSummary = {
    ...retain,
    agentVersionsDeleted,
    runsDeleted: runs.runs,
    runMessagesDeleted: runs.messages,
    orphanMessagesDeleted,
    channelMessagesDeleted,
    durationMs: Date.now() - startedAt,
  };

  await repo.audit.writeAudit(db, logger, {
    actor: 'worker',
    actorKind: 'service',
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
  workspacesDir: string;
}): Promise<Worker> {
  const connection = createBunRedisClient(new RedisClient(input.redisUrl));
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  await queue.upsertJobScheduler('daily', { every: DAY_MS });
  await queue.close();

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    () => runMaintenance(input.db, input.logger, input.retain, input.workspacesDir),
    { connection },
  );
  worker.on('closed', () => connection.disconnect());
  worker.on('failed', (job, err) => {
    input.logger.error({ jobId: job?.id, err }, 'maintenance job failed');
  });
  return worker;
}

// 手动触发：bun run --filter @agentport/worker maintenance
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });
  const { db, client } = createDb(config.DATABASE_URL);
  try {
    await runMaintenance(
      db,
      logger,
      {
        runDays: config.RETAIN_RUN_DAYS,
        messageDays: config.RETAIN_MESSAGE_DAYS,
        agentVersions: config.RETAIN_AGENT_VERSIONS,
      },
      config.WORKSPACES_DIR,
    );
  } finally {
    await client.close();
  }
}
