import { randomUUID } from 'node:crypto';
import { newId } from '../../../packages/db/src/index.js';
import { client as sql } from './database.js';

interface Fixture {
  agentId: string;
  conversationId: string;
}

interface RunSeed {
  status: 'succeeded' | 'failed';
  startedAt: Date;
  input: number;
  output: number;
  error: string | null;
}

export async function seed(): Promise<Fixture> {
  const suffix = randomUUID().slice(0, 8);
  const agentId = newId('agent');
  const conversationId = newId('conversation');
  const newest = Date.now() - 2 * 3_600_000;

  await sql`insert into agents (id, slug, name, model, created_by, owner_business_id) values (${agentId}, ${`e2e-overview-${suffix}`}, ${`E2E 概览 ${suffix}`}, 'test-model', 'bootstrap-admin', 'bootstrap-admin')`;
  await sql`insert into conversations (id, agent_id, title, created_by) values (${conversationId}, ${agentId}, ${'E2E 概览'}, 'bootstrap-admin')`;

  const runs: RunSeed[] = [
    ...Array.from(
      { length: 21 },
      (_, index): RunSeed => ({
        status: 'succeeded',
        startedAt: new Date(newest - index * 60_000),
        input: 10,
        output: 5,
        error: null,
      }),
    ),
    ...Array.from(
      { length: 4 },
      (_, index): RunSeed => ({
        status: 'failed',
        startedAt: new Date(newest - (3 + index) * 3_600_000),
        input: 3,
        output: 2,
        error: 'overview fixture failure',
      }),
    ),
    {
      status: 'failed',
      startedAt: new Date(newest - 8 * 86_400_000),
      input: 100,
      output: 0,
      error: 'overview fixture out of window',
    },
  ];

  for (const run of runs) {
    await sql`insert into agent_runs
         (id, conversation_id, agent_id, status, started_at, ended_at, latency_ms, cost_usd,
          input_tokens, output_tokens, error, subject_kind, initiated_by)
       values (${newId('run')}, ${conversationId}, ${agentId}, ${run.status}, ${run.startedAt.toISOString()}, ${run.startedAt.toISOString()}, 100, 0.01, ${run.input}, ${run.output}, ${run.error}, 'user', 'bootstrap-admin')`;
  }

  const fixture: Fixture = { agentId, conversationId };
  return fixture;
}

export async function cleanup(created: Fixture[]): Promise<void> {
  if (!created.length) return;
  const targets = created.flatMap((f) => [f.agentId, f.conversationId]);
  await sql`delete from audit_log where target = any(${sql.array(targets, 'TEXT')})`;
  await sql`delete from agents where id = any(${sql.array(
    created.map((f) => f.agentId),
    'TEXT',
  )})`;
}
