import { randomUUID } from 'node:crypto';
import { agentRuns, agents, conversations, newId } from '../../../packages/db/src/index.js';
import { RUN_CANCEL_PAYLOAD, runCancelKey } from '../../../packages/shared/src/run-stream.js';
import { db as database, redis, client as sql } from './database.js';

interface Fixture {
  agentId: string;
  conversationId: string;
  runId: string;
}

export async function seedRun(status: 'queued' | 'running' | 'succeeded'): Promise<Fixture> {
  const client = database;
  const suffix = randomUUID().slice(0, 8);
  const fixture: Fixture = {
    agentId: newId('agent'),
    conversationId: newId('conversation'),
    runId: newId('run'),
  };
  await client.insert(agents).values({
    id: fixture.agentId,
    slug: `e2e-run-cancel-${suffix}`,
    name: `E2E 取消运行 ${suffix}`,
    model: 'test-model',
    createdBy: 'bootstrap-admin',
    ownerBusinessId: 'bootstrap-admin',
  });
  await client.insert(conversations).values({
    id: fixture.conversationId,
    agentId: fixture.agentId,
    title: 'E2E 取消运行',
    createdBy: 'bootstrap-admin',
  });
  await client.insert(agentRuns).values({
    id: fixture.runId,
    conversationId: fixture.conversationId,
    agentId: fixture.agentId,
    status,
    subjectKind: 'user',
    initiatedBy: 'bootstrap-admin',
    ...(status === 'running' ? { startedAt: new Date() } : {}),
    ...(status === 'succeeded' ? { startedAt: new Date(), endedAt: new Date() } : {}),
  });
  return fixture;
}

export async function runStatus(runId: string): Promise<string | undefined> {
  const rows = await sql<{ status: string }[]>`select status from agent_runs where id = ${runId}`;
  return rows[0]?.status;
}

export async function cancelRequested(runId: string): Promise<boolean> {
  return (await redis().get(runCancelKey(runId))) === RUN_CANCEL_PAYLOAD;
}

export async function cleanup(created: Fixture[]): Promise<void> {
  if (!created.length) return;
  const targets = created.flatMap((f) => [f.agentId, f.conversationId, f.runId]);
  await sql`delete from audit_log where target = any(${sql.array(targets, 'TEXT')})`;
  await redis().send(
    'DEL',
    created.map((f) => runCancelKey(f.runId)),
  );
  await sql`delete from agents where id = any(${sql.array(
    created.map((f) => f.agentId),
    'TEXT',
  )})`;
}
