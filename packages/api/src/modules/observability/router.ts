import { observabilityContract } from '@agentport/contract/observability';
import { repo } from '@agentport/db';
import { evaluateSloStatuses, type QueueSnapshot, type SloStatus } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import {
  getDataDomainBuildQueue,
  getDataDomainEnrichmentQueue,
  getEvalQueue,
  getKnowledgeQueue,
  getMonitoringQueues,
  getQueue,
  getRuntimeEnvironmentBuildQueue,
} from '../../queue/producer.js';
import { getScheduleQueue } from '../ops/schedule-sync.js';

const JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;
const QUEUE_CACHE_MS = 5000;

interface QueueLike {
  name: string;
  getJobCounts: (...states: (typeof JOB_STATES)[number][]) => Promise<Record<string, number>>;
  getWaiting: (start: number, end: number) => Promise<{ timestamp: number }[]>;
}

let queueCache: { at: number; rows: QueueSnapshot[] } | undefined;

const os = implement(observabilityContract).$context<RequestContext>();

async function audit(context: RequestContext, action: string, target: string, input?: unknown) {
  await repo.audit.writeAudit(context.db, context.log, {
    actor: actorOf(context),
    action: `observability.${action}`,
    target,
    input,
    status: 'ok',
    requestId: context.requestId,
  });
}

async function queueSnapshot(queue: QueueLike): Promise<QueueSnapshot> {
  try {
    const [counts, waiting] = await Promise.all([
      queue.getJobCounts(...JOB_STATES),
      queue.getWaiting(0, 0).catch(() => []),
    ]);
    return {
      name: queue.name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
      oldestWaitingMs:
        waiting[0] === undefined ? null : Math.max(0, Date.now() - waiting[0].timestamp),
    };
  } catch {
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

async function queueSnapshots(redisUrl: string): Promise<QueueSnapshot[]> {
  if (queueCache !== undefined && Date.now() - queueCache.at < QUEUE_CACHE_MS) {
    return queueCache.rows;
  }
  const queues: QueueLike[] = [
    getQueue(),
    getEvalQueue(),
    getKnowledgeQueue(),
    getRuntimeEnvironmentBuildQueue(),
    getDataDomainBuildQueue(),
    getDataDomainEnrichmentQueue(),
    ...getMonitoringQueues(),
    getScheduleQueue(redisUrl),
  ];
  const rows = await Promise.all(queues.map(queueSnapshot));
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
      queueSnapshots(context.config.REDIS_URL),
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
