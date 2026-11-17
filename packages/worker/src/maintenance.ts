import { pathToFileURL } from 'node:url';
import { outputMessageAnchors } from '@agentport/core';
import { createServiceLogger } from '@agentport/core/logger';
import { createDb, repo, schema } from '@agentport/db';
import {
  DATA_DOMAIN_BUILDS_QUEUE,
  DATA_DOMAIN_ENRICHMENTS_QUEUE,
  EVAL_RUNS_QUEUE,
  KNOWLEDGE_JOBS_QUEUE,
  KNOWLEDGE_SYNC_TRIGGERS_QUEUE,
  MAINTENANCE_QUEUE,
  NATIVE_PLUGINS_QUEUE,
  RUNS_QUEUE,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  SANDBOX_PROBES_QUEUE,
  SCHEDULE_TRIGGERS_QUEUE,
} from '@agentport/shared';
import { createBunRedisClient, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { loadConfig } from './config.js';
import { version } from './version.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OPS_ALERT_INTERVAL_MS = 5 * 60 * 1000;

export async function runOpsAlerts(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  redisUrl: string;
}): Promise<void> {
  const now = new Date();
  const settings = await repo.governance.getAlertSettings(input.db);
  const failedRuns = settings.runFailures.enabled
    ? await repo.governance.countRecentFailedRuns(
        input.db,
        new Date(now.getTime() - settings.runFailures.windowMinutes * 60_000),
      )
    : 0;
  let queueCounts: Array<{ name: string; failed: number; waiting: number }> = [];
  if (settings.queueFailed.enabled || settings.queueWaiting.enabled) {
    const connection = createBunRedisClient(new RedisClient(input.redisUrl));
    const queues = [
      RUNS_QUEUE,
      EVAL_RUNS_QUEUE,
      KNOWLEDGE_JOBS_QUEUE,
      KNOWLEDGE_SYNC_TRIGGERS_QUEUE,
      SCHEDULE_TRIGGERS_QUEUE,
      RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
      SANDBOX_PROBES_QUEUE,
      NATIVE_PLUGINS_QUEUE,
      DATA_DOMAIN_BUILDS_QUEUE,
      DATA_DOMAIN_ENRICHMENTS_QUEUE,
    ].map((name) => new Queue(name, { connection }));
    try {
      queueCounts = await Promise.all(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts('failed', 'waiting');
          return { name: queue.name, failed: counts.failed ?? 0, waiting: counts.waiting ?? 0 };
        }),
      );
    } catch (err) {
      input.logger.error({ err }, 'ops alert queue counts failed');
      queueCounts = [];
    } finally {
      await Promise.all(queues.map((queue) => queue.close())).finally(() =>
        connection.disconnect(),
      );
    }
  }
  const failed = queueCounts.reduce((total, queue) => total + queue.failed, 0);
  const waiting = queueCounts.reduce((total, queue) => total + queue.waiting, 0);
  const alerts = [
    ...(settings.runFailures.enabled && failedRuns >= settings.runFailures.threshold
      ? [
          {
            kind: 'run_failures',
            title: '运行失败告警',
            body: `最近 ${settings.runFailures.windowMinutes} 分钟有 ${failedRuns} 次运行失败，达到 ${settings.runFailures.threshold} 次阈值`,
          },
        ]
      : []),
    ...(settings.queueFailed.enabled && failed >= settings.queueFailed.threshold
      ? [
          {
            kind: 'queue_failed',
            title: '队列失败告警',
            body: `队列共有 ${failed} 个失败任务，达到 ${settings.queueFailed.threshold} 个阈值。${queueCounts
              .filter((queue) => queue.failed > 0)
              .map((queue) => `${queue.name}: ${queue.failed}`)
              .join('；')}`,
          },
        ]
      : []),
    ...(settings.queueWaiting.enabled && waiting >= settings.queueWaiting.threshold
      ? [
          {
            kind: 'queue_waiting',
            title: '队列积压告警',
            body: `队列共有 ${waiting} 个等待任务，达到 ${settings.queueWaiting.threshold} 个阈值。${queueCounts
              .filter((queue) => queue.waiting > 0)
              .map((queue) => `${queue.name}: ${queue.waiting}`)
              .join('；')}`,
          },
        ]
      : []),
  ];
  if (alerts.length === 0) return;
  const recipients = await repo.governance.listAlertRecipientBusinessIds(input.db);
  await Promise.all(
    alerts.flatMap((alert) =>
      recipients.map((businessId) =>
        repo.notifications.createNotification(input.db, {
          businessId,
          kind: 'ops_alert',
          title: alert.title,
          body: alert.body,
          link: '/operations',
          sourceId: `ops-alert:${alert.kind}:${Math.floor(now.getTime() / OPS_ALERT_INTERVAL_MS)}`,
        }),
      ),
    ),
  );
  input.logger.info(
    { failedRuns, failed, waiting, alerts: alerts.length },
    'operations alerts checked',
  );
}

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
  const settings = await repo.ops.getRetentionSettings(db);
  const effective: Retention = {
    runDays: settings?.runDays ?? retain.runDays,
    messageDays: settings?.messageDays ?? retain.messageDays,
    agentVersions: settings?.agentVersions ?? retain.agentVersions,
  };
  const agentVersionsDeleted = await repo.maintenance.pruneAgentVersions(
    db,
    effective.agentVersions,
  );
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
  const runs = await repo.maintenance.pruneRuns(db, effective.runDays, pruneOptions);
  const orphanMessagesDeleted = await repo.maintenance.pruneOrphanMessages(
    db,
    effective.messageDays,
    pruneOptions,
  );
  const channelMessagesDeleted = await repo.maintenance.pruneChannelMessages(
    db,
    effective.messageDays,
  );
  const summary: MaintenanceSummary = {
    ...effective,
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
  await Promise.all([
    queue.upsertJobScheduler('daily', { every: DAY_MS }, { name: 'daily' }),
    queue.upsertJobScheduler(
      'ops-alerts',
      { every: OPS_ALERT_INTERVAL_MS },
      {
        name: 'ops-alerts',
        opts: { removeOnComplete: 100, removeOnFail: 200 },
      },
    ),
  ]);
  await queue.close();

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    (job) =>
      job.name === 'ops-alerts'
        ? runOpsAlerts(input)
        : runMaintenance(input.db, input.logger, input.retain, input.workspacesDir),
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
  const logger = createServiceLogger({
    service: 'worker',
    env: config.NODE_ENV,
    version,
    level: config.LOG_LEVEL,
  });
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
