import { client as sql } from './database.js';

export interface FeedbackRun {
  id: string;
  status: string;
  conversation_id: string;
}

export interface FeedbackMessage {
  id: string;
  text: string | null;
}

export interface RunFeedbackRow {
  id: string;
  run_id: string;
  message_id: string | null;
  output_path: string | null;
  output_sha256: string | null;
  decision: 'accepted' | 'rejected';
  rating: number | null;
  comment: string;
  reason: string;
  eval_case_id: string | null;
  created_by: string;
  created_at: string;
}

export interface FeedbackEvalCase {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
}

export interface FeedbackEvalRun {
  id: string;
  status: string;
  total: number;
  passed: number;
}

export interface FeedbackEvalResult {
  passed: boolean;
  output: string;
  run_id: string | null;
}

export async function latestRun(agentId: string): Promise<FeedbackRun | null> {
  const rows = await sql<FeedbackRun[]>`
    select id, status, conversation_id
    from agent_runs
    where agent_id = ${agentId}
    order by created_at desc, id desc
    limit 1`;
  return rows[0] ?? null;
}

export async function runById(runId: string): Promise<FeedbackRun | null> {
  const rows = await sql<FeedbackRun[]>`
    select id, status, conversation_id
    from agent_runs
    where id = ${runId}
    limit 1`;
  return rows[0] ?? null;
}

export async function runMessages(runId: string): Promise<FeedbackMessage[]> {
  return sql<FeedbackMessage[]>`
    select id,
      case
        when jsonb_typeof(content) = 'array' then (
          select string_agg(part->>'text', E'\n')
          from jsonb_array_elements(content) part
          where part->>'type' = 'text'
        )
        else content->>'text'
      end as text
    from messages
    where run_id = ${runId} and role = 'assistant'
    order by created_at asc, id asc`;
}

export async function listFeedback(runId: string): Promise<RunFeedbackRow[]> {
  return sql<RunFeedbackRow[]>`
    select id, run_id, message_id, output_path, output_sha256, decision, rating,
           comment, reason, eval_case_id, created_by, created_at
    from run_feedback
    where run_id = ${runId}
    order by created_at asc, id asc`;
}

export async function evalCaseForFeedback(feedbackId: string): Promise<FeedbackEvalCase | null> {
  const rows = await sql<FeedbackEvalCase[]>`
    select c.id, c.name, c.prompt, c.expectation
    from run_feedback f
    join eval_cases c on c.id = f.eval_case_id
    where f.id = ${feedbackId}
    limit 1`;
  return rows[0] ?? null;
}

export async function countEvalCases(agentId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from eval_cases where agent_id = ${agentId}`;
  return Number(rows[0]?.count ?? 0);
}

export async function latestEvalRun(agentId: string): Promise<FeedbackEvalRun | null> {
  const rows = await sql<FeedbackEvalRun[]>`
    select id, status, total, passed
    from eval_runs
    where agent_id = ${agentId}
    order by created_at desc, id desc
    limit 1`;
  return rows[0] ?? null;
}

export async function evalResults(evalRunId: string): Promise<FeedbackEvalResult[]> {
  return sql<FeedbackEvalResult[]>`
    select passed, output, run_id
    from eval_results
    where eval_run_id = ${evalRunId}
    order by created_at asc, id asc`;
}

export async function cleanup(targets: { agentIds?: readonly string[] }): Promise<void> {
  const agentIds = targets.agentIds ?? [];
  if (agentIds.length === 0) return;
  const agents = sql.array([...agentIds], 'TEXT');
  const budgetPrefixes = agentIds.map((id) => `budget:${id}:%`);
  await sql.begin(async (tx) => {
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
         or target in (select id from agent_runs where agent_id = any(${agents}::text[]))
         or target in (
           select id from run_feedback
           where run_id in (select id from agent_runs where agent_id = any(${agents}::text[]))
         )
         or target in (select id from eval_cases where agent_id = any(${agents}::text[]))
         or target in (select id from eval_runs where agent_id = any(${agents}::text[]))`;
    await tx`delete from run_feedback
      where run_id in (select id from agent_runs where agent_id = any(${agents}::text[]))`;
    await tx`delete from eval_results
      where eval_run_id in (select id from eval_runs where agent_id = any(${agents}::text[]))`;
    await tx`delete from eval_runs where agent_id = any(${agents}::text[])`;
    await tx`delete from eval_cases where agent_id = any(${agents}::text[])`;
    await tx`delete from agents where id = any(${agents}::text[])`;
  });
}
