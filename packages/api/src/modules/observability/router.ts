import { observabilityContract } from '@agentport/contract/observability';
import { repo } from '@agentport/db';
import { evaluateSloStatuses, type QueueSnapshot, type SloStatus } from '@agentport/shared';
import { implement } from '@orpc/server';
import type { Queue } from 'bullmq';
import type { Config } from '../../config.js';
import { requireUser } from '../../http/access.js';
import { domainAudit } from '../../http/audit.js';
import type { RequestContext } from '../../http/context.js';
import { getQueues } from '../../queue/catalog.js';
import { jobCounts } from '../../queue/metrics.js';

const QUEUE_CACHE_MS = 5000;

let queueCache: { at: number; rows: QueueSnapshot[] } | undefined;

const os = implement(observabilityContract).$context<RequestContext>();

const audit = domainAudit('observability');

async function queueSnapshot(queue: Queue, log: RequestContext['log']): Promise<QueueSnapshot> {
  try {
    return { name: queue.name, ...(await jobCounts(queue)) };
  } catch (err) {
    log.warn({ err, queue: queue.name }, 'observability queue snapshot failed');
    return {
      name: queue.name,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      oldestWaitingMs: null,
    };
  }
}

async function queueSnapshots(
  redisUrl: string,
  nodeEnv: Config['NODE_ENV'],
  log: RequestContext['log'],
): Promise<QueueSnapshot[]> {
  if (queueCache !== undefined && Date.now() - queueCache.at < QUEUE_CACHE_MS) {
    return queueCache.rows;
  }
  const queues: Queue[] = getQueues(redisUrl, nodeEnv);
  const rows = await Promise.all(queues.map((queue) => queueSnapshot(queue, log)));
  queueCache = { at: Date.now(), rows };
  return rows;
}

export const observabilityRouter = os.router({
  snapshot: os.snapshot.handler(async ({ input, context }) => {
    const now = new Date();
    const since = new Date(now.getTime() - input.query.windowMinutes * 60_000);
    const [
      runs,
      queues,
      providerRows,
      providerStats,
      slo,
      openViolations,
      pendingApprovals,
      recentOpsAlerts,
    ] = await Promise.all([
      repo.observability.runWindowStats(context.db, since),
      queueSnapshots(context.config.REDIS_URL, context.config.NODE_ENV, context.log),
      repo.modelProviders.listModelProviders(context.db),
      repo.observability.providerWindowStats(context.db, since),
      repo.governance.getSloSettings(context.db),
      repo.security.countViolationCasesByStatus(context.db, 'open'),
      repo.security.countPolicyApprovalsByStatus(context.db, 'pending'),
      repo.notifications.countNotificationsByKindSince(context.db, 'ops_alert', since),
    ]);
    const statsByProvider = new Map(providerStats.map((row) => [row.providerId, row]));
    const providers = providerRows.map((row) => {
      const stats = statsByProvider.get(row.id);
      const requests = stats?.requests ?? 0;
      const errors = stats?.errors ?? 0;
      return {
        providerId: row.id,
        name: row.name,
        enabled: row.enabled,
        priority: row.priority,
        requests,
        errors,
        errorRate: requests > 0 ? errors / requests : 0,
        costUsd: stats?.costUsd ?? 0,
        lastError: row.lastError,
        lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      };
    });
    const successRate = runs.finished > 0 ? runs.succeeded / runs.finished : 0;
    const queueWaits = queues.flatMap((row) =>
      row.oldestWaitingMs === null ? [] : [row.oldestWaitingMs],
    );
    let sloStatuses: SloStatus[] = [];
    if (slo.enabled) {
      const sloSince = new Date(now.getTime() - slo.windowMinutes * 60_000);
      const [sloRuns, sloProviderStats] =
        slo.windowMinutes === input.query.windowMinutes
          ? [runs, providerStats]
          : await Promise.all([
              repo.observability.runWindowStats(context.db, sloSince),
              repo.observability.providerWindowStats(context.db, sloSince),
            ]);
      sloStatuses = evaluateSloStatuses({
        settings: slo,
        finishedRuns: sloRuns.finished,
        successRate: sloRuns.finished > 0 ? sloRuns.succeeded / sloRuns.finished : 0,
        p95LatencyMs: sloRuns.p95LatencyMs,
        latencySamples: sloRuns.latencySamples,
        queueOldestWaitMs: queueWaits.length === 0 ? null : Math.max(...queueWaits),
        queueSamples: queueWaits.length,
        providerRequests: sloProviderStats.reduce((total, row) => total + row.requests, 0),
        providerErrors: sloProviderStats.reduce((total, row) => total + row.errors, 0),
      });
    }
    return {
      window: { minutes: input.query.windowMinutes, since: since.toISOString() },
      sloWindowMinutes: slo.windowMinutes,
      sloEnabled: slo.enabled,
      generatedAt: now.toISOString(),
      runs: {
        ...runs,
        successRate,
        errorRate: runs.finished > 0 ? (runs.failed + runs.timeout) / runs.finished : 0,
      },
      queues,
      providers,
      slo: sloStatuses,
      alerts: { openViolations, pendingApprovals, recentOpsAlerts },
    };
  }),
  slo: {
    get: os.slo.get.handler(({ context }) => repo.governance.getSloSettings(context.db)),
    update: os.slo.update.handler(async ({ input, context }) => {
      const row = await repo.governance.updateSloSettings(
        context.db,
        input.body,
        requireUser(context).businessId,
      );
      await audit(context, 'slo.updated', 'platform', input.body);
      return row;
    }),
  },
});
