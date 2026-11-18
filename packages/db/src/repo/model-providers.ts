import { and, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import {
  agentRuns,
  conversations,
  messages,
  modelProviders,
  policyApprovals,
  providerRequestLogs,
} from '../schema.js';

export type ModelProviderRow = typeof modelProviders.$inferSelect;
type ProviderRequestLogRow = typeof providerRequestLogs.$inferSelect;

export interface ProviderUsage {
  requests: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ModelProviderWrite {
  name: string;
  protocol: ModelProviderRow['protocol'];
  baseUrl: string;
  credentialEncrypted: string;
  models: string[];
  priority: number;
  enabled: boolean;
  monthlyBudgetUsd: number | null;
  alertRatio: number;
}

export interface ProviderRequestRecord {
  providerId: string;
  runId?: string | null;
  model?: string | null;
  statusCode?: number | null;
  errorKind?: ProviderRequestLogRow['errorKind'];
  durationMs: number;
  logOnly?: boolean;
  upstreamRequestId?: string | null;
  failoverFromProviderId?: string | null;
  error?: string | null;
}

const emptyUsage: ProviderUsage = { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };

function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function providerAttribution() {
  return sql<
    string | null
  >`coalesce(${agentRuns.servedProviderId}, case when ${agentRuns.status} = 'succeeded' or ${agentRuns.providerFailovers} > 0 then null else ${agentRuns.providerId} end)`;
}

export function providerUsageByPeriod(db: DbHandle, start: Date, end: Date) {
  const successes = db
    .select({
      providerId: providerRequestLogs.providerId,
      requests: sql<number>`count(*)`.as('requests'),
      totalRequests: sql`sum(count(*)) over ()`.as('total_requests'),
    })
    .from(providerRequestLogs)
    .where(
      and(
        eq(providerRequestLogs.runId, agentRuns.id),
        gte(providerRequestLogs.statusCode, 200),
        lt(providerRequestLogs.statusCode, 300),
        isNull(providerRequestLogs.errorKind),
      ),
    )
    .groupBy(providerRequestLogs.providerId)
    .as('successes');
  const providerId = sql<string>`coalesce(${successes.providerId}, ${providerAttribution()})`;
  const requests = sql`coalesce(${successes.requests}, 1)`;
  const totalRequests = sql`coalesce(${successes.totalRequests}, 1)`;
  return db
    .select({
      providerId: providerId.as('provider_id'),
      requests: sql<number>`sum(${requests})`.mapWith(Number).as('requests'),
      costUsd:
        sql<number>`coalesce(sum(${agentRuns.costUsd} * ${requests} / ${totalRequests}), 0)::float`.as(
          'cost_usd',
        ),
      inputTokens:
        sql<number>`coalesce(sum(${agentRuns.inputTokens} * ${requests} / ${totalRequests}), 0)::float`.as(
          'input_tokens',
        ),
      outputTokens:
        sql<number>`coalesce(sum(${agentRuns.outputTokens} * ${requests} / ${totalRequests}), 0)::float`.as(
          'output_tokens',
        ),
    })
    .from(agentRuns)
    .leftJoinLateral(successes, sql`true`)
    .where(
      and(
        gte(agentRuns.startedAt, start),
        lt(agentRuns.startedAt, end),
        sql`${providerId} is not null`,
      ),
    )
    .groupBy(providerId);
}

export async function listModelProviders(db: DbHandle) {
  const now = new Date();
  const [rows, usageRows] = await Promise.all([
    db.select().from(modelProviders).orderBy(modelProviders.priority, modelProviders.id),
    providerUsageByPeriod(db, monthStart(now), now),
  ]);
  const usageByProvider = new Map(usageRows.map(({ providerId, ...usage }) => [providerId, usage]));
  return rows.map((row) => ({ ...row, usage: usageByProvider.get(row.id) ?? emptyUsage }));
}

export async function listHistoricalProviderDestinations(
  db: DbHandle,
  conversationId: string,
  runId: string,
) {
  return db.execute<{ destination: string | null }>(sql`
    with recursive history as (
      select id, parent_id, branch_of_message_id, provider_destination, null::timestamptz as cutoff
      from ${conversations} where id = ${conversationId}
      union all
      select parent.id, parent.parent_id, parent.branch_of_message_id, parent.provider_destination,
        least(history.cutoff, branch.created_at)
      from history
      join ${conversations} parent on parent.id = history.parent_id
      join ${messages} branch on branch.id = history.branch_of_message_id
    )
    select ${policyApprovals.destination} as destination
    from history
    join ${agentRuns} on ${agentRuns.conversationId} = history.id
    join ${policyApprovals} on ${policyApprovals.runId} = ${agentRuns.id}
    where ${agentRuns.id} <> ${runId}
      and ${policyApprovals.status} = 'approved'
      and ${policyApprovals.consumedAt} is not null
      and (history.cutoff is null or ${agentRuns.createdAt} <= history.cutoff)
    union
    select null from history
    where provider_destination is null and branch_of_message_id is not null and history.parent_id is not null and not exists (
      select 1 from ${messages} branch
      where branch.id = history.branch_of_message_id and branch.conversation_id = history.parent_id
    )
    limit 2
  `);
}

export async function getModelProvider(db: DbHandle, id: string) {
  const [row] = await db.select().from(modelProviders).where(eq(modelProviders.id, id)).limit(1);
  return row ?? null;
}

export async function createModelProvider(db: Database, input: ModelProviderWrite) {
  const [row] = await db
    .insert(modelProviders)
    .values({
      id: newId('modelProvider'),
      name: input.name,
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      credentialEncrypted: input.credentialEncrypted,
      models: input.models,
      priority: input.priority,
      enabled: input.enabled,
      monthlyBudgetUsd: input.monthlyBudgetUsd === null ? null : String(input.monthlyBudgetUsd),
      alertRatio: String(input.alertRatio),
    })
    .returning();
  if (!row) throw new Error('model provider insert returned no row');
  return row;
}

export async function updateModelProvider(
  db: Database,
  id: string,
  patch: Partial<ModelProviderWrite>,
) {
  const [row] = await db
    .update(modelProviders)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.protocol === undefined ? {} : { protocol: patch.protocol }),
      ...(patch.baseUrl === undefined ? {} : { baseUrl: patch.baseUrl }),
      ...(patch.credentialEncrypted === undefined
        ? {}
        : { credentialEncrypted: patch.credentialEncrypted }),
      ...(patch.models === undefined ? {} : { models: patch.models }),
      ...(patch.priority === undefined ? {} : { priority: patch.priority }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.monthlyBudgetUsd === undefined
        ? {}
        : {
            monthlyBudgetUsd:
              patch.monthlyBudgetUsd === null ? null : String(patch.monthlyBudgetUsd),
          }),
      ...(patch.alertRatio === undefined ? {} : { alertRatio: String(patch.alertRatio) }),
      updatedAt: new Date(),
    })
    .where(eq(modelProviders.id, id))
    .returning();
  return row ?? null;
}

export async function deleteModelProvider(
  db: Database,
  id: string,
): Promise<'deleted' | 'not_found' | 'in_use'> {
  return db.transaction(async (tx) => {
    const [provider] = await tx
      .select({ id: modelProviders.id })
      .from(modelProviders)
      .where(eq(modelProviders.id, id))
      .for('update');
    if (!provider) return 'not_found';

    const destinationPrefix = `provider:${id}:`;
    const [reference] = await tx.execute(sql`
      select 1
      where exists (select 1 from ${providerRequestLogs} where ${providerRequestLogs.providerId} = ${id})
        or exists (select 1 from ${agentRuns} where ${agentRuns.providerId} = ${id} or ${agentRuns.servedProviderId} = ${id})
        or exists (select 1 from ${policyApprovals} where starts_with(${policyApprovals.destination}, ${destinationPrefix}))
        or exists (select 1 from ${conversations} where starts_with(${conversations.providerDestination}, ${destinationPrefix}))
    `);
    if (reference) return 'in_use';

    await tx.delete(modelProviders).where(eq(modelProviders.id, id));
    return 'deleted';
  });
}

export async function listEnabledModelProviders(db: DbHandle) {
  return db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.enabled, true))
    .orderBy(modelProviders.priority, modelProviders.id);
}

export async function markRunServedProvider(db: DbHandle, runId: string, providerId: string) {
  await db.update(agentRuns).set({ servedProviderId: providerId }).where(eq(agentRuns.id, runId));
}

export async function recordProviderRequest(db: Database, input: ProviderRequestRecord) {
  const { statusCode, errorKind, runId } = input;
  const succeeded =
    errorKind == null && statusCode != null && statusCode >= 200 && statusCode < 300;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(providerRequestLogs).values({
      id: newId('modelProviderRequest'),
      providerId: input.providerId,
      runId: input.logOnly ? null : (runId ?? null),
      model: input.model ?? null,
      statusCode: statusCode ?? null,
      errorKind: errorKind ?? null,
      durationMs: input.durationMs,
      upstreamRequestId: input.upstreamRequestId ?? null,
      failoverFromProviderId: input.failoverFromProviderId ?? null,
    });
    if (input.logOnly) return;
    await tx
      .update(modelProviders)
      .set(
        succeeded
          ? { lastSuccessAt: now, lastError: null, lastErrorAt: null }
          : {
              lastError:
                input.error ??
                input.errorKind ??
                (input.statusCode === null || input.statusCode === undefined
                  ? '模型请求失败'
                  : `HTTP ${input.statusCode}`),
              lastErrorAt: now,
            },
      )
      .where(eq(modelProviders.id, input.providerId));
    if (succeeded && runId != null && input.failoverFromProviderId != null) {
      await tx
        .update(agentRuns)
        .set({ providerFailovers: sql`${agentRuns.providerFailovers} + 1` })
        .where(eq(agentRuns.id, runId));
    }
  });
}

export async function selectProviderForModel(
  db: DbHandle,
  model: string | null,
  options: { allowExhausted?: boolean } = {},
): Promise<string | null> {
  if (model === null) return null;
  const now = new Date();
  const usage = providerUsageByPeriod(db, monthStart(now), now).as('provider_usage');
  const [row] = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .leftJoin(usage, eq(modelProviders.id, usage.providerId))
    .where(
      and(
        eq(modelProviders.enabled, true),
        sql`${modelProviders.models} @> ${JSON.stringify([model])}::jsonb`,
        options.allowExhausted
          ? undefined
          : or(
              isNull(modelProviders.monthlyBudgetUsd),
              sql`coalesce(${usage.costUsd}, 0) < ${modelProviders.monthlyBudgetUsd}`,
            ),
      ),
    )
    .orderBy(modelProviders.priority, modelProviders.id)
    .limit(1);
  return row?.id ?? null;
}

export async function pruneProviderRequestLogs(db: Database, before: Date): Promise<number> {
  const rows = await db
    .delete(providerRequestLogs)
    .where(
      and(
        lt(providerRequestLogs.createdAt, before),
        or(
          isNull(providerRequestLogs.runId),
          sql`not exists (select 1 from ${agentRuns} where ${agentRuns.id} = ${providerRequestLogs.runId})`,
          sql`exists (
            select 1 from ${agentRuns}
            where ${agentRuns.id} = ${providerRequestLogs.runId}
              and ${agentRuns.status} in ('succeeded', 'failed', 'cancelled', 'timeout')
              and coalesce(${agentRuns.endedAt}, ${agentRuns.startedAt}) < ${before}
          )`,
        ),
        sql`not exists (
          select 1 from ${agentRuns}
          where ${agentRuns.id} = ${providerRequestLogs.runId}
            and ${agentRuns.startedAt} >= date_trunc('month', now(), 'UTC')
            and (${agentRuns.providerId} is not null or ${agentRuns.servedProviderId} is not null)
        )`,
      ),
    )
    .returning({ id: providerRequestLogs.id });
  return rows.length;
}

export async function providerUsageForModel(
  db: DbHandle,
  providerId: string,
  monthStartAt: Date,
): Promise<ProviderUsage> {
  const usage = providerUsageByPeriod(db, monthStartAt, new Date()).as('provider_usage');
  const [row] = await db
    .select({
      requests: usage.requests,
      costUsd: usage.costUsd,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    .from(usage)
    .where(eq(usage.providerId, providerId));
  return row ?? emptyUsage;
}
