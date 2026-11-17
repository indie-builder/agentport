import { randomUUID } from 'node:crypto';
import { hashMcpToken } from '../../../packages/core/src/index.js';
import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

export interface ApprovalProducerSeed {
  serverName: string;
  toolName: string;
  initiatedBy: string;
  channelId?: string;
  trigger: 'chat' | 'channel';
}

export interface ApprovalProducer {
  serverId: string;
  agentId: string;
  conversationId: string;
  runId: string;
  runToken: string;
  toolName: string;
}

export interface ProducerApproval {
  id: string;
  channel_id: string | null;
  tool_name: string;
  run_id: string;
}

export interface ProducerNotification {
  id: string;
  business_id: string;
  kind: string;
  title: string;
  body: string;
  link: string;
  source_id: string;
}

export async function seed(input: ApprovalProducerSeed): Promise<ApprovalProducer> {
  const suffix = randomUUID().slice(0, 8);
  const serverId = newId('server');
  const toolId = newId('tool');
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const runId = newId('run');
  const runToken = randomUUID().replaceAll('-', '');

  await sql.begin(async (tx) => {
    await tx`insert into servers (id, name, kind, config)
      values (${serverId}, ${input.serverName}, 'generated', ${JSON.stringify({ baseUrl: 'http://127.0.0.1:9/' })}::jsonb)`;
    await tx`insert into api_tools (id, server_id, name, method, path_template, input_schema, params_in, approval_mode)
      values (${toolId}, ${serverId}, ${input.toolName}, 'GET', '/users/{id}', '{"type":"object","properties":{"id":{"type":"integer"}}}'::jsonb, 'query', 'ask')`;
    await tx`insert into agents (id, slug, name, model, created_by, owner_business_id)
      values (${agentId}, ${`e2e-notification-producer-${suffix}`}, ${`E2E 通知生产者 ${suffix}`}, 'test-model', ${input.initiatedBy}, ${input.initiatedBy})`;
    await tx`insert into agent_servers (agent_id, server_id) values (${agentId}, ${serverId})`;
    await tx`insert into conversations (id, agent_id, channel_id, created_by)
      values (${conversationId}, ${agentId}, ${input.channelId ?? null}, ${input.initiatedBy})`;
    await tx`insert into agent_runs
        (id, conversation_id, agent_id, channel_id, status, trigger, subject_kind, initiated_by, started_at, mcp_token_hash, mcp_token_expires_at)
      values (${runId}, ${conversationId}, ${agentId}, ${input.channelId ?? null}, 'running', ${input.trigger}, 'user', ${input.initiatedBy}, now(), ${hashMcpToken(runToken)}, ${new Date(Date.now() + 5 * 60_000)})`;
  });

  return { serverId, agentId, conversationId, runId, runToken, toolName: input.toolName };
}

export async function approvalState(
  runId: string,
  businessIds: readonly string[],
): Promise<{ approval: ProducerApproval | null; notifications: ProducerNotification[] }> {
  const [approval] = await sql<ProducerApproval[]>`
    select id, channel_id, tool_name, run_id from approval_requests
    where run_id = ${runId}
    order by created_at desc, id desc
    limit 1`;
  if (businessIds.length === 0) return { approval: approval ?? null, notifications: [] };
  const notifications = await sql<ProducerNotification[]>`
    select id, business_id, kind, title, body, link, source_id
    from notifications
    where business_id = any(${sql.array([...businessIds], 'TEXT')}::text[])
      and kind = 'approval'
      and (
        source_id like ${`approval:${runId}:%`}
        or source_id in (select 'channel-approval:' || id from approval_requests where run_id = ${runId})
      )
    order by business_id`;
  return { approval: approval ?? null, notifications };
}

export async function cleanup(targets: {
  serverIds?: readonly string[];
  agentIds?: readonly string[];
  runIds?: readonly string[];
  businessIds?: readonly string[];
}): Promise<void> {
  const serverIds = targets.serverIds ?? [];
  const agentIds = targets.agentIds ?? [];
  const runIds = targets.runIds ?? [];
  const businessIds = targets.businessIds ?? [];
  await sql.begin(async (tx) => {
    if (businessIds.length > 0 && runIds.length > 0) {
      const prefixes = runIds.map((runId) => `approval:${runId}:%`);
      await tx`delete from notifications
        where business_id = any(${sql.array([...businessIds], 'TEXT')}::text[])
          and kind = 'approval'
          and (
            source_id like any(${sql.array(prefixes, 'TEXT')}::text[])
            or source_id in (select 'channel-approval:' || id from approval_requests where run_id = any(${sql.array([...runIds], 'TEXT')}::text[]))
          )`;
    }
    if (serverIds.length > 0) {
      await tx`delete from servers where id = any(${sql.array([...serverIds], 'TEXT')}::text[])`;
    }
    if (agentIds.length > 0) {
      await tx`delete from agents where id = any(${sql.array([...agentIds], 'TEXT')}::text[])`;
    }
  });
}
