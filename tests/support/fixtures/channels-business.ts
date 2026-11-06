import { client as sql } from './database.js';

export async function laneUserMessages(runId: string): Promise<string[]> {
  const rows = await sql<
    { content: string }[]
  >`select content->>'text' as content from messages where run_id = ${runId} and role = 'user' order by created_at asc`;
  return rows.map((row) => row.content);
}

export async function latestRunForTrigger(
  triggerMessageId: string,
): Promise<{ id: string; status: string; agent_id: string; conversation_id: string } | undefined> {
  const rows = await sql<
    {
      id: string;
      status: string;
      agent_id: string;
      conversation_id: string;
    }[]
  >`select id, status, agent_id, conversation_id
       from agent_runs
      where channel_trigger_message_id = ${triggerMessageId}
      order by created_at desc
      limit 1`;
  return rows[0];
}

export async function messageByBody(channelId: string, body: string) {
  const rows = await sql<
    {
      id: string;
      seq: number;
      kind: string;
      agent_id: string | null;
      run_id: string | null;
      body: string;
    }[]
  >`select id, seq, kind, agent_id, run_id, body
       from channel_messages
      where channel_id = ${channelId} and body = ${body}
      order by seq desc
      limit 1`;
  return rows[0];
}

export async function agentMessagesForRun(channelId: string, runId: string) {
  return sql<
    { id: string; seq: number; agent_id: string | null; body: string }[]
  >`select id, seq, agent_id, body
       from channel_messages
      where channel_id = ${channelId} and run_id = ${runId} and kind = 'agent'
      order by seq asc`;
}

export async function enabledAgents(agentIds: string[]) {
  return sql<AgentRef[]>`select id, name, model from agents
      where enabled
        and id = any(${sql.array(agentIds, 'TEXT')}::text[])`;
}

export async function members(channelId: string) {
  return sql<
    { business_id: string; role: string }[]
  >`select business_id, role from channel_members where channel_id = ${channelId} order by role`;
}

export async function bindings(channelId: string) {
  return sql<
    { agent_id: string; status: string }[]
  >`select agent_id, status from channel_agent_bindings where channel_id = ${channelId} order by agent_id`;
}

export async function runCount(channelId: string) {
  return sql<
    { count: string }[]
  >`select count(*)::text as count from agent_runs where channel_id = ${channelId}`;
}

export async function triggerRunCount(messageId: string) {
  return sql<
    { count: string }[]
  >`select count(*)::text as count from agent_runs where channel_trigger_message_id = ${messageId}`;
}

export async function runConversation(runId: string) {
  return sql<
    { conversation_id: string }[]
  >`select conversation_id from agent_runs where id = ${runId}`;
}

export async function runs(channelId: string) {
  return sql<
    { id: string; status: string; agent_id: string }[]
  >`select id, status, agent_id from agent_runs where channel_id = ${channelId} order by created_at asc`;
}

export async function messageCounts(channelId: string) {
  return sql<
    { kind: string; count: string }[]
  >`select kind, count(*)::text as count from channel_messages where channel_id = ${channelId} group by kind order by kind`;
}

interface AgentRef {
  id: string;
  name: string;
  model: string;
}
