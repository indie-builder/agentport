import { count, gte, sql } from 'drizzle-orm';
import type { DbHandle } from '../client.js';
import { agentRuns, providerRequestLogs } from '../schema.js';
import { providerUsageByPeriod } from './model-providers.js';

export interface RunWindowStats {
  total: number;
  finished: number;
  succeeded: number;
  failed: number;
  timeout: number;
  cancelled: number;
  running: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  latencySamples: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderWindowStats {
  providerId: string;
  requests: number;
  errors: number;
  costUsd: number;
}

export async function runWindowStats(db: DbHandle, since: Date): Promise<RunWindowStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      finished: sql<number>`count(*) filter (where ${agentRuns.status} in ('succeeded','failed','timeout'))::int`,
      succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')::int`,
      failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')::int`,
      timeout: sql<number>`count(*) filter (where ${agentRuns.status} = 'timeout')::int`,
      cancelled: sql<number>`count(*) filter (where ${agentRuns.status} = 'cancelled')::int`,
      running: sql<number>`count(*) filter (where ${agentRuns.status} = 'running')::int`,
      p50LatencyMs: sql<
        number | null
      >`percentile_cont(0.5) within group (order by ${agentRuns.latencyMs}) filter (where ${agentRuns.status} in ('succeeded','failed','timeout'))`,
      p95LatencyMs: sql<
        number | null
      >`percentile_cont(0.95) within group (order by ${agentRuns.latencyMs}) filter (where ${agentRuns.status} in ('succeeded','failed','timeout'))`,
      p99LatencyMs: sql<
        number | null
      >`percentile_cont(0.99) within group (order by ${agentRuns.latencyMs}) filter (where ${agentRuns.status} in ('succeeded','failed','timeout'))`,
      latencySamples: sql<number>`count(${agentRuns.latencyMs}) filter (where ${agentRuns.status} in ('succeeded','failed','timeout'))::int`,
      costUsd: sql<number>`coalesce(sum(${agentRuns.costUsd}), 0)::float`,
      inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::float`,
      outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::float`,
    })
    .from(agentRuns)
    .where(sql`coalesce(${agentRuns.startedAt}, ${agentRuns.createdAt}) >= ${since}`);
  return (
    row ?? {
      total: 0,
      finished: 0,
      succeeded: 0,
      failed: 0,
      timeout: 0,
      cancelled: 0,
      running: 0,
      p50LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
      latencySamples: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
  );
}

export async function providerWindowStats(
  db: DbHandle,
  since: Date,
): Promise<ProviderWindowStats[]> {
  const [logRows, usageRows] = await Promise.all([
    db
      .select({
        providerId: providerRequestLogs.providerId,
        requests: count(),
        errors: sql<number>`count(*) filter (where ${providerRequestLogs.statusCode} >= 400 or ${providerRequestLogs.errorKind} is not null)::int`,
      })
      .from(providerRequestLogs)
      .where(gte(providerRequestLogs.createdAt, since))
      .groupBy(providerRequestLogs.providerId),
    providerUsageByPeriod(db, since, new Date()),
  ]);
  const logsByProvider = new Map(logRows.map((row) => [row.providerId, row]));
  const usageByProvider = new Map(
    usageRows.map(({ providerId, costUsd }) => [providerId, costUsd]),
  );
  return [...new Set([...logsByProvider.keys(), ...usageByProvider.keys()])].map((providerId) => {
    const logs = logsByProvider.get(providerId);
    return {
      providerId,
      requests: logs?.requests ?? 0,
      errors: logs?.errors ?? 0,
      costUsd: usageByProvider.get(providerId) ?? 0,
    };
  });
}
