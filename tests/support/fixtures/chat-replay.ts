import { createRequire } from 'node:module';
import { RedisClient } from 'bun';
import { newId } from '../../../packages/db/src/index.js';
import { RUNS_QUEUE, runCancelKey, runStreamKey } from '../../../packages/shared/src/run-stream.js';
import { redis, client as sql } from './database.js';

interface Fixture {
  agentId: string;
  conversationId: string;
}
const FIXTURE_TRIM_MAXLEN = 1000;

export async function seedFixture(
  slug: string,
  text: { historyUser: string; historyAnswer: string },
): Promise<Fixture> {
  const fixture = { agentId: newId('agent'), conversationId: newId('conversation') };

  await sql`insert into agents (id, slug, name, model, created_by, owner_business_id) values (${fixture.agentId}, ${slug}, ${'E2E 截断回放'}, 'test-model', 'bootstrap-admin', 'bootstrap-admin')`;
  await sql`insert into conversations (id, agent_id, title, created_by) values (${fixture.conversationId}, ${fixture.agentId}, ${'E2E 截断回放'}, 'bootstrap-admin')`;
  await sql`insert into messages (id, conversation_id, role, content, created_at) values
       (${newId('message')}, ${fixture.conversationId}, 'user', ${JSON.stringify({ type: 'text', text: text.historyUser })}, now() - interval '2 minutes'),
       (${newId('message')}, ${fixture.conversationId}, 'assistant', ${JSON.stringify({ type: 'text', text: text.historyAnswer })}, now() - interval '1 minute')`;
  return fixture;
}

const requireFromApi = createRequire(
  new URL('../../../packages/api/package.json', import.meta.url),
);
const { createBunRedisClient, Queue } = requireFromApi('bullmq');

async function removeJob(runId: string, required: boolean): Promise<void> {
  const url = process.env.E2E_REDIS_URL;
  if (!url) throw new Error('E2E_REDIS_URL must identify the isolated E2E Redis');
  const connection = createBunRedisClient(new RedisClient(url));
  const queue = new Queue(RUNS_QUEUE, { connection });
  try {
    const job = await queue.getJob(runId);
    if (!job && required)
      throw new Error(`BullMQ job ${runId} is missing; worker must stay paused`);
    await job?.remove();
  } finally {
    await queue.close();
    await connection.quit();
  }
}

export async function removeOwnJob(runId: string): Promise<void> {
  await removeJob(runId, true);
}

export async function seedStream(runId: string): Promise<void> {
  const client = redis();
  const key = runStreamKey(runId);
  const total = 1_500;
  for (let start = 0; start < total; start += 500) {
    await Promise.all(
      Array.from({ length: Math.min(500, total - start) }, (_, offset) =>
        client.send('XADD', [
          key,
          'MAXLEN',
          '~',
          String(FIXTURE_TRIM_MAXLEN),
          '*',
          'payload',
          JSON.stringify({ type: 'text_delta', text: `p${start + offset} ` }),
        ]),
      ),
    );
  }
  for (let index = 0; index < 3; index += 1) {
    await client.send('XADD', [
      key,
      'MAXLEN',
      '~',
      String(FIXTURE_TRIM_MAXLEN),
      '*',
      'payload',
      JSON.stringify({ type: 'text_delta', text: 'partial-tail ' }),
    ]);
  }
  await client.expire(key, 3600);
}

export async function finishRun(runId: string, saved: string): Promise<void> {
  await sql`insert into messages (id, conversation_id, role, content, run_id)
     select ${newId('message')}, conversation_id, 'assistant', ${JSON.stringify({ type: 'text', text: saved })}, id from agent_runs where id = ${runId}`;
  const rows = await sql`update agent_runs set status = 'succeeded', ended_at = now(), turns = 1
     where id = ${runId} and status = 'queued' returning id`;
  if (rows.length === 0) {
    throw new Error(
      'run was no longer queued; a worker claimed the job while E2E_WORKER_PAUSED was set',
    );
  }
  await redis().send('XADD', [
    runStreamKey(runId),
    'MAXLEN',
    '~',
    String(FIXTURE_TRIM_MAXLEN),
    '*',
    'payload',
    JSON.stringify({ type: 'run_finished', status: 'succeeded', turns: 1 }),
  ]);
  await redis().expire(runStreamKey(runId), 3600);
}

export async function seedPartialStream(runId: string, text: string): Promise<void> {
  const client = redis();
  await client.send('XADD', [
    runStreamKey(runId),
    'MAXLEN',
    '~',
    String(FIXTURE_TRIM_MAXLEN),
    '*',
    'payload',
    JSON.stringify({ type: 'text_delta', text }),
  ]);
  await client.expire(runStreamKey(runId), 3600);
}

export async function markRunning(runId: string): Promise<void> {
  const rows = await sql`update agent_runs set status = 'running', started_at = now()
     where id = ${runId} and status = 'queued' returning id`;
  if (rows.length === 0) throw new Error(`run ${runId} was not queued before the stream opened`);
}

export async function finishWithoutEvent(runId: string, saved: string): Promise<void> {
  await sql`insert into messages (id, conversation_id, role, content, run_id)
     select ${newId('message')}, conversation_id, 'assistant', ${JSON.stringify({ type: 'text', text: saved })}, id from agent_runs where id = ${runId}`;
  const rows = await sql`update agent_runs
        set status = 'succeeded', ended_at = now(), turns = 2, cost_usd = 0.0123,
            latency_ms = 1234, input_tokens = 100, output_tokens = 20
      where id = ${runId} and status = 'running' returning id`;
  if (rows.length === 0) {
    throw new Error('run was no longer running; a worker claimed the job while E2E_WORKER_PAUSED');
  }
}

export async function cleanup(fixture: Fixture, runId?: string): Promise<void> {
  if (runId) {
    await removeJob(runId, false);
    await redis().send('DEL', [runStreamKey(runId), runCancelKey(runId)]);
  }

  const targets = [fixture.agentId, fixture.conversationId, ...(runId ? [runId] : [])];
  await sql`delete from audit_log where target = any(${sql.array(targets, 'TEXT')}::text[])`;
  await sql`delete from agents where id = ${fixture.agentId}`;
}

export async function streamLength(runId: string) {
  return redis().send('XLEN', [runStreamKey(runId)]);
}
export async function runStatus(runId: string) {
  const rows = await sql<{ status: string }[]>`select status from agent_runs where id = ${runId}`;
  return rows[0]?.status;
}
export async function deleteRun(runId: string): Promise<void> {
  await sql`delete from agent_runs where id = ${runId}`;
}
export async function runCount(runId: string) {
  const rows = await sql<
    { count: number }[]
  >`select count(*)::int as count from agent_runs where id = ${runId}`;
  return rows[0]?.count;
}
export async function userText(runId: string) {
  const rows = await sql<
    { text: string | null }[]
  >`select content->>'text' as text from messages where run_id = ${runId} and role = 'user'`;
  return rows[0]?.text;
}
export async function markTruncated(runId: string): Promise<void> {
  await redis().send('XADD', [
    runStreamKey(runId),
    '*',
    'payload',
    JSON.stringify({ type: 'replay_truncated', reason: 'retention' }),
  ]);
}

export async function latestRun(agentId: string, conversationId: string) {
  const rows = await sql<
    { id: string }[]
  >`select id from agent_runs where agent_id = ${agentId} and conversation_id = ${conversationId} order by created_at desc limit 1`;
  return rows[0]?.id ?? null;
}
