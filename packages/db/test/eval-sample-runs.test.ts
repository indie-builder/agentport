import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createDb } from '../src/client.js';
import * as evalRepo from '../src/repo/eval.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('请通过 bun run test 注入隔离的 DATABASE_URL');
const { db, client } = createDb(url);
const ready = await client.unsafe('select 1').then(
  () => true,
  () => false,
);

const businessId = 'eval-sample-owner';
const agentId = 'eval-sample-agent';
const otherAgentId = 'eval-sample-other';
const eligible = ['sample-run-a', 'sample-run-b', 'sample-run-c'];

describe.skipIf(!ready)('sampleProductionRuns', () => {
  beforeAll(async () => {
    await client.unsafe(
      `insert into agents (id, slug, name, model, created_by, owner_business_id)
       values ($1, $1, 'sample agent', 'test', $3, $3), ($2, $2, 'other agent', 'test', $3, $3)`,
      [agentId, otherAgentId, businessId],
    );
    await client.unsafe(
      `insert into channels (id, name, created_by) values ('sample-channel', 'sample channel', $1)`,
      [businessId],
    );
    await client.unsafe(
      `insert into conversations (id, agent_id, title, created_by)
       values ('sample-conv-a', $1, '季度复盘', $2),
              ('sample-conv-b', $1, '', $2),
              ('sample-conv-c', $1, '其他会话', $2),
              ('sample-conv-other', $3, '', $2)`,
      [agentId, businessId, otherAgentId],
    );
    const run = (id: string, conversationId: string, values: string) =>
      client.unsafe(
        `insert into agent_runs
           (id, conversation_id, agent_id, status, trigger, subject_kind, ended_at, eval_run_id, channel_id, initiated_by)
         values ($1, $2, $3, ${values}, $4)`,
        [id, conversationId, agentId, businessId],
      );
    for (const [id, conversationId] of [
      ['sample-run-a', 'sample-conv-a'],
      ['sample-run-b', 'sample-conv-b'],
      ['sample-run-c', 'sample-conv-c'],
    ] as const) {
      await run(id, conversationId, `'succeeded', 'chat', 'user', now(), null, null`);
    }
    await run(
      'sample-run-eval',
      'sample-conv-a',
      `'succeeded', 'chat', 'user', now(), 'eval-run-1', null`,
    );
    await run(
      'sample-run-running',
      'sample-conv-a',
      `'running', 'chat', 'user', now(), null, null`,
    );
    await run(
      'sample-run-no-end',
      'sample-conv-a',
      `'succeeded', 'chat', 'user', null, null, null`,
    );
    await run(
      'sample-run-channel',
      'sample-conv-a',
      `'succeeded', 'chat', 'user', now(), null, 'sample-channel'`,
    );
    await run(
      'sample-run-schedule',
      'sample-conv-a',
      `'succeeded', 'schedule', 'user', now(), null, null`,
    );
    await run(
      'sample-run-source-linked',
      'sample-conv-a',
      `'succeeded', 'chat', 'user', now(), null, null`,
    );
    await run(
      'sample-run-feedback-linked',
      'sample-conv-a',
      `'succeeded', 'chat', 'user', now(), null, null`,
    );
    await client.unsafe(
      `insert into agent_runs (id, conversation_id, agent_id, status, trigger, subject_kind, ended_at, initiated_by)
       values ('sample-run-other', 'sample-conv-other', $1, 'succeeded', 'chat', 'user', now(), $2)`,
      [otherAgentId, businessId],
    );
    await client.unsafe(
      `insert into messages (id, conversation_id, role, content, run_id, created_at)
       values ('sample-msg-a2', 'sample-conv-a', 'user', '{"text":"第二条"}'::jsonb, 'sample-run-a', now() + interval '1 second'),
              ('sample-msg-a1', 'sample-conv-a', 'user', '{"text":"第一条"}'::jsonb, 'sample-run-a', now()),
              ('sample-msg-a0', 'sample-conv-a', 'assistant', '{"text":"回答"}'::jsonb, 'sample-run-a', now() - interval '1 second'),
              ('sample-msg-b', 'sample-conv-b', 'user', '{"text":"B 的输入"}'::jsonb, 'sample-run-b', now()),
              ('sample-msg-c', 'sample-conv-c', 'user', '{"text":"C 的输入"}'::jsonb, 'sample-run-c', now())`,
    );
    await client.unsafe(
      `insert into eval_cases (id, agent_id, name, prompt, expectation, created_by, source_run_id)
       values ('sample-case-linked', $1, '已转用例', 'p', 'e', $2, 'sample-run-source-linked')`,
      [agentId, businessId],
    );
    await client.unsafe(
      `insert into run_feedback (id, conversation_id, run_id, decision, created_by, eval_case_id)
       values ('sample-feedback', 'sample-conv-a', 'sample-run-feedback-linked', 'rejected', $1, 'sample-case-linked')`,
      [businessId],
    );
  });

  afterAll(async () => {
    await client.unsafe('delete from agents where id in ($1, $2)', [agentId, otherAgentId]);
    await client.close();
  });

  it('returns only recent succeeded chat runs with a first user prompt', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 10 });
    expect(rows.map((row) => row.runId).sort()).toEqual([...eligible].sort());
    const runA = rows.find((row) => row.runId === 'sample-run-a');
    expect(runA).toMatchObject({
      conversationId: 'sample-conv-a',
      title: '季度复盘',
      prompt: '第一条',
    });
    const runB = rows.find((row) => row.runId === 'sample-run-b');
    expect(runB?.title).toBe('运行 le-run-b');
    expect(runB?.prompt).toBe('B 的输入');
  });

  it('excludes eval runs, non-succeeded runs, channel and schedule runs, and other agents', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50 });
    const ids = rows.map((row) => row.runId);
    for (const excluded of [
      'sample-run-eval',
      'sample-run-running',
      'sample-run-no-end',
      'sample-run-channel',
      'sample-run-schedule',
      'sample-run-other',
    ]) {
      expect(ids).not.toContain(excluded);
    }
  });

  it('excludes runs already linked through eval_cases.source_run_id or run_feedback', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50 });
    const ids = rows.map((row) => row.runId);
    expect(ids).not.toContain('sample-run-source-linked');
    expect(ids).not.toContain('sample-run-feedback-linked');
  });

  it('applies the requested limit', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 2 });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(eligible).toContain(row.runId);
  });
});
