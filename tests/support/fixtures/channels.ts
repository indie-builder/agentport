import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

interface Created {
  channels: string[];
  agents: string[];
  accounts: string[];
  servers: string[];
}

export async function cleanup(created: Created): Promise<void> {
  if (
    created.channels.length === 0 &&
    created.agents.length === 0 &&
    created.accounts.length === 0 &&
    created.servers.length === 0
  ) {
    return;
  }

  const targets = [...created.channels, ...created.agents, ...created.servers];
  if (targets.length > 0) {
    await sql`delete from audit_log where target = any(${sql.array(targets, 'TEXT')}::text[])`;
  }
  if (created.servers.length > 0) {
    await sql`delete from servers where id = any(${sql.array(created.servers, 'TEXT')}::text[])`;
  }
  if (created.channels.length > 0) {
    await sql`delete from channels where id = any(${sql.array(created.channels, 'TEXT')}::text[])`;
  }
  if (created.agents.length > 0) {
    await sql`delete from agents where id = any(${sql.array(created.agents, 'TEXT')}::text[])`;
  }
  if (created.accounts.length > 0) {
    await sql`delete from "user" where business_id = any(${sql.array(created.accounts, 'TEXT')}::text[])`;
  }
}

export async function latestRunStatus(channelId: string): Promise<string | undefined> {
  const rows = await sql<
    { status: string }[]
  >`select status from agent_runs where channel_id = ${channelId} order by created_at desc, id desc limit 1`;
  return rows[0]?.status;
}

export async function pendingApproval(channelId: string, agentId: string, serverName: string) {
  const [channel] = await sql<
    { created_by: string }[]
  >`select created_by from channels where id = ${channelId}`;
  if (!channel) throw new Error('频道缺少创建者');
  const conversationId = newId('conversation');
  const runId = newId('run');
  const serverId = newId('server');
  const approvalId = newId('approval');
  await sql.begin(async (tx) => {
    await tx`insert into conversations (id, agent_id, channel_id, created_by) values (${conversationId}, ${agentId}, ${channelId}, ${channel.created_by})`;
    await tx`insert into agent_runs (id, conversation_id, agent_id, channel_id, status, trigger, subject_kind, initiated_by, started_at) values (${runId}, ${conversationId}, ${agentId}, ${channelId}, 'running', 'channel', 'user', ${channel.created_by}, now())`;
    await tx`insert into servers (id, name, kind, config) values (${serverId}, ${serverName}, 'http', '{}'::jsonb)`;
    await tx`insert into approval_requests (id, run_id, channel_id, server_id, tool_name) values (${approvalId}, ${runId}, ${channelId}, ${serverId}, 'e2e_tool')`;
  });
  return { serverId, approvalId };
}

export async function bindingCount(channelId: string, agentId: string) {
  return sql<
    { count: string }[]
  >`select count(*)::text as count from channel_agent_bindings where channel_id = ${channelId} and agent_id = ${agentId}`;
}

export async function runCount(channelId: string) {
  return sql<
    { count: string }[]
  >`select count(*)::text as count from agent_runs where channel_id = ${channelId}`;
}

export async function runs(channelId: string) {
  return sql<
    { conversation_id: string; status: string }[]
  >`select conversation_id, status from agent_runs where channel_id = ${channelId} order by created_at asc`;
}

export async function laneCount(channelId: string, agentId: string) {
  return sql<
    { count: string }[]
  >`select count(*)::text as count from conversations where channel_id = ${channelId} and agent_id = ${agentId}`;
}

export async function approval(approvalId: string) {
  return sql<
    { approved_at: Date | null }[]
  >`select approved_at from approval_requests where id = ${approvalId}`;
}
