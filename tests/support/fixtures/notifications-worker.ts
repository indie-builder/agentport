import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

export interface WorkerRun {
  id: string;
  status: string;
  error: string | null;
  error_kind: string | null;
  sandbox_id: string | null;
  cost_usd: string | null;
}

export interface WorkerNotification {
  id: string;
  business_id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  source_id: string;
}

export interface WorkerApproval {
  id: string;
  run_id: string;
  server_id: string;
  tool_name: string;
  approved_at: string | null;
  denied_at: string | null;
}

export interface WorkerToolResult {
  name: string | null;
  content: unknown;
}

export async function latestRun(agentId: string): Promise<WorkerRun | null> {
  const rows = await sql<WorkerRun[]>`
    select id, status, error, error_kind, sandbox_id, cost_usd
    from agent_runs
    where agent_id = ${agentId}
    order by created_at desc, id desc
    limit 1`;
  return rows[0] ?? null;
}

export async function runState(runId: string): Promise<WorkerRun | null> {
  const rows = await sql<WorkerRun[]>`
    select id, status, error, error_kind, sandbox_id, cost_usd
    from agent_runs
    where id = ${runId}
    limit 1`;
  return rows[0] ?? null;
}

export async function seedSpentRun(
  agentId: string,
  businessId: string,
  costUsd: string,
): Promise<{ conversationId: string; runId: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const conversationId = newId('conversation');
  const runId = newId('run');
  const now = new Date();
  await sql.begin(async (tx) => {
    await tx`insert into conversations (id, agent_id, title, created_by)
      values (${conversationId}, ${agentId}, ${`E2E 预算历史 ${suffix}`}, ${businessId})`;
    await tx`insert into agent_runs
        (id, conversation_id, agent_id, status, trigger, subject_kind, initiated_by, started_at, ended_at, cost_usd)
      values (${runId}, ${conversationId}, ${agentId}, 'succeeded', 'chat', 'user', ${businessId}, ${now}, ${now}, ${costUsd})`;
  });
  return { conversationId, runId };
}

export async function notification(
  sourceId: string,
  businessId: string,
): Promise<WorkerNotification | null> {
  const rows = await sql<WorkerNotification[]>`
    select id, business_id, kind, title, body, link, source_id
    from notifications
    where source_id = ${sourceId} and business_id = ${businessId}
    limit 1`;
  return rows[0] ?? null;
}

export async function latestApproval(agentId: string): Promise<WorkerApproval | null> {
  const rows = await sql<WorkerApproval[]>`
    select a.id, a.run_id, a.server_id, a.tool_name, a.approved_at, a.denied_at
    from approval_requests a
    join agent_runs r on r.id = a.run_id
    where r.agent_id = ${agentId}
    order by a.created_at desc, a.id desc
    limit 1`;
  return rows[0] ?? null;
}

export async function toolResults(runId: string): Promise<WorkerToolResult[]> {
  return sql<WorkerToolResult[]>`
    select content->>'name' as name, content->'content' as content
    from messages
    where run_id = ${runId} and role = 'tool' and content->>'type' = 'tool_result'
    order by created_at asc`;
}

export async function cleanup(targets: {
  agentIds?: readonly string[];
  serverIds?: readonly string[];
}): Promise<void> {
  const agentIds = targets.agentIds ?? [];
  const serverIds = targets.serverIds ?? [];
  if (agentIds.length === 0 && serverIds.length === 0) return;
  const budgetPrefixes = agentIds.map((id) => `budget:${id}:%`);
  const agents = sql.array([...agentIds], 'TEXT');
  await sql.begin(async (tx) => {
    if (agentIds.length > 0) {
      await tx`delete from notifications
        where source_id in (
          select 'run-failed:' || id from agent_runs where agent_id = any(${agents}::text[])
        )
        or source_id like any(${sql.array(budgetPrefixes, 'TEXT')}::text[])
        or exists (
          select 1 from agent_runs
          where agent_runs.agent_id = any(${agents}::text[])
            and notifications.source_id like 'approval:' || agent_runs.id || ':%'
        )`;
      await tx`delete from audit_log
        where target = any(${agents}::text[])
           or target in (select id from agent_runs where agent_id = any(${agents}::text[]))`;
    }
    if (serverIds.length > 0) {
      await tx`delete from servers where id = any(${sql.array([...serverIds], 'TEXT')}::text[])`;
    }
    if (agentIds.length > 0) {
      await tx`delete from agents where id = any(${agents}::text[])`;
    }
  });
}
