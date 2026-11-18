import { client as sql } from './database.js';

export interface RunProviderState {
  status: string;
  providerId: string | null;
  servedProviderId: string | null;
  providerFailovers: number;
}

export async function getRunProviderState(runId: string): Promise<RunProviderState | null> {
  const rows = await sql<RunProviderState[]>`
    select status,
           provider_id as "providerId",
           served_provider_id as "servedProviderId",
           provider_failovers as "providerFailovers"
    from agent_runs
    where id = ${runId}
    limit 1`;
  return rows[0] ?? null;
}

export async function setRunCost(runId: string, costUsd: number): Promise<void> {
  await sql`update agent_runs set cost_usd = ${costUsd} where id = ${runId}`;
}

export interface ProviderRequestLog {
  providerId: string;
  statusCode: number | null;
  errorKind: string | null;
  failoverFromProviderId: string | null;
}

export async function listProviderRequestLogs(runId: string): Promise<ProviderRequestLog[]> {
  return sql<ProviderRequestLog[]>`
    select provider_id as "providerId",
           status_code as "statusCode",
           error_kind as "errorKind",
           failover_from_provider_id as "failoverFromProviderId"
    from provider_request_logs
    where run_id = ${runId}
    order by created_at asc, id asc`;
}
