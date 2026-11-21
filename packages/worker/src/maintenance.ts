import { pathToFileURL } from 'node:url';
import { outputMessageAnchors, removeChannelInputs } from '@agentport/core';
import { createDb, repo, schema } from '@agentport/db';
import {
  DEFAULT_JOB_RETENTION,
  evaluateSloStatuses,
  MAINTENANCE_QUEUE,
  QUEUE_REGISTRY,
} from '@agentport/shared';
import { createBunRedisClient, Queue, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { loadConfig } from './config.js';
import { createWorkerLogger } from './logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const OPS_ALERT_INTERVAL_MS = 5 * 60 * 1000;

export async function reconcileExpiredApprovals(
  db: ReturnType<typeof createDb>['db'],
  logger: Logger,
  now: Date,
): Promise<number> {
  const rows = await repo.runs.expireStaleApprovals(db, now);
  for (const row of rows) {
    await repo.audit.writeAudit(db, logger, {
      actor: 'worker',
      actorKind: 'service',
      action: 'agent.run.approval.expired',
      ...(row.runId === null ? {} : { target: row.runId }),
      input: { approvalId: row.id, serverId: row.serverId, toolName: row.toolName },
      status: 'ok',
    });
    const sourceId =
      row.channelId === null ? `approval:${row.runId}:${row.id}` : `channel-approval:${row.id}`;
    await repo.notifications.markBySource(db, 'approval', sourceId).catch((err: unknown) => {
      logger.warn({ err, approvalId: row.id }, 'approval notification cleanup failed');
    });
  }
  return rows.length;
}

export async function runOpsAlerts(input: {
  db: ReturnType<typeof createDb>['db'];
  logger: Logger;
  redisUrl: string;
}): Promise<void> {
  const now = new Date();
  const [settings, slo] = await Promise.all([
    repo.governance.getAlertSettings(input.db),
    repo.governance.getSloSettings(input.db),
  ]);
  const failedRuns = settings.runFailures.enabled
    ? await repo.governance.countRecentFailedRuns(
        input.db,
        new Date(now.getTime() - settings.runFailures.windowMinutes * 60_000),
      )
    : 0;
  let queueCounts: Array<{
    name: string;
    failed: number;
    waiting: number;
    oldestWaitingMs: number | null;
  }> = [];
  if (settings.queueFailed.enabled || settings.queueWaiting.enabled || slo.enabled) {
    const connection = createBunRedisClient(new RedisClient(input.redisUrl));
    const queues = QUEUE_REGISTRY.map((queue) => queue.name).map(
      (name) => new Queue(name, { connection }),
    );
    try {
      queueCounts = await Promise.all(
        queues.map(async (queue) => {
          const [counts, oldest] = await Promise.all([
            queue.getJobCounts('failed', 'waiting').catch(() => null),
            queue.getWaiting(0, 0).catch(() => []),
          ]);
          return {
            name: queue.name,
            failed: counts?.failed ?? 0,
            waiting: counts?.waiting ?? 0,
            oldestWaitingMs:
              oldest[0] === undefined ? null : Math.max(0, now.getTime() - oldest[0].timestamp),
          };
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
  const alerts: Array<{
    kind: string;
    title: string;
    body: string;
    link: string;
    sourceId: string;
  }> = [
    ...(settings.runFailures.enabled && failedRuns >= settings.runFailures.threshold
      ? [
          {
            kind: 'run_failures',
            title: '运行失败告警',
            body: `最近 ${settings.runFailures.windowMinutes} 分钟有 ${failedRuns} 次运行失败，达到 ${settings.runFailures.threshold} 次阈值`,
            link: '/operations',
            sourceId: `ops-alert:run_failures:${Math.floor(now.getTime() / OPS_ALERT_INTERVAL_MS)}`,
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
            link: '/operations',
            sourceId: `ops-alert:queue_failed:${Math.floor(now.getTime() / OPS_ALERT_INTERVAL_MS)}`,
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
            link: '/operations',
            sourceId: `ops-alert:queue_waiting:${Math.floor(now.getTime() / OPS_ALERT_INTERVAL_MS)}`,
          },
        ]
      : []),
  ];
  if (slo.enabled) {
    const since = new Date(now.getTime() - slo.windowMinutes * 60_000);
    const [runs, providerStats] = await Promise.all([
      repo.observability.runWindowStats(input.db, since),
      repo.observability.providerWindowStats(input.db, since),
    ]);
    const queueWaits = queueCounts.flatMap((queue) =>
      queue.oldestWaitingMs === null ? [] : [queue.oldestWaitingMs],
    );
    const providerRequests = providerStats.reduce((total, row) => total + row.requests, 0);
    const providerErrors = providerStats.reduce((total, row) => total + row.errors, 0);
    const statuses = evaluateSloStatuses({
      settings: slo,
      finishedRuns: runs.finished,
      successRate: runs.finished > 0 ? runs.succeeded / runs.finished : 0,
      p95LatencyMs: runs.p95LatencyMs,
      latencySamples: runs.latencySamples,
      queueOldestWaitMs: queueWaits.length === 0 ? null : Math.max(...queueWaits),
      queueSamples: queueWaits.length,
      providerRequests,
      providerErrors,
    });
    const bucket = Math.floor(now.getTime() / (slo.windowMinutes * 60_000));
    for (const status of statuses) {
      if (status.ok !== false) continue;
      alerts.push({
        kind: `slo_${status.key}`,
        title: `SLO 未达标：${status.label}`,
        body: `目标 ${status.target}，实际 ${status.actual}（样本 ${status.sampleSize}）`,
        link: '/observability',
        sourceId: `slo:${status.key}:${bucket}`,
      });
    }
  }
  const providers = await repo.modelProviders.listModelProviders(input.db);
  for (const provider of providers) {
    if (!provider.enabled || provider.monthlyBudgetUsd === null) continue;
    const budget = Number(provider.monthlyBudgetUsd);
    if (budget <= 0) continue;
    const ratio = Number(provider.alertRatio);
    if (provider.usage.costUsd < budget * ratio) continue;
    alerts.push({
      kind: 'provider_budget',
      title: `模型供应商预算告警：${provider.name}`,
      body: `当月成本 $${provider.usage.costUsd.toFixed(2)}，达到月预算 $${budget.toFixed(2)} 的 ${Math.round(ratio * 100)}%。`,
      link: '/models',
      sourceId: `provider-budget:${provider.id}:${now.toISOString().slice(0, 7)}`,
    });
  }
  await reconcileExpiredApprovals(input.db, input.logger, now).catch((err) => {
    input.logger.warn({ err }, 'approval expiry reconcile failed');
  });
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
          link: alert.link,
          sourceId: alert.sourceId,
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
  channelInputsCleaned: number;
  providerLogsDeleted: number;
  durationMs: number;
}

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
  const providerLogsDeleted = await repo.modelProviders.pruneProviderRequestLogs(
    db,
    new Date(Date.now() - effective.runDays * DAY_MS),
  );
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
  const prunedChannelMessages = await repo.maintenance.pruneChannelMessages(
    db,
    effective.messageDays,
  );
  let channelInputsCleaned = 0;
  for (const message of prunedChannelMessages) {
    try {
      await removeChannelInputs({
        root: workspacesDir,
        channelId: message.channelId,
        messageId: message.id,
      });
      channelInputsCleaned += 1;
    } catch (err) {
      logger.warn(
        { err, channelId: message.channelId, messageId: message.id },
        'channel inputs cleanup failed',
      );
    }
  }
  const summary: MaintenanceSummary = {
    ...effective,
    agentVersionsDeleted,
    runsDeleted: runs.runs,
    runMessagesDeleted: runs.messages,
    orphanMessagesDeleted,
    channelMessagesDeleted: prunedChannelMessages.length,
    channelInputsCleaned,
    providerLogsDeleted,
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
        opts: DEFAULT_JOB_RETENTION,
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const logger = createWorkerLogger(config);
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
