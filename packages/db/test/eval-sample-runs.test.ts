import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { AccessFilter } from '@agentport/shared';
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
const otherBusinessId = 'eval-sample-user-b';
const agentId = 'eval-sample-agent';
const otherAgentId = 'eval-sample-other';
const eligible = ['sample-run-a', 'sample-run-b', 'sample-run-c', 'sample-run-long'];
const longPrompt = `   ${'x'.repeat(20_050)}`;
const ownData: AccessFilter = { businessId, scopes: ['own_data'] };
const platform: AccessFilter = { businessId, scopes: ['platform'] };

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
              ('sample-conv-user-b', $1, '他人会话', $2),
              ('sample-conv-long', $1, '长输入会话', $2),
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
      ['sample-run-long', 'sample-conv-long'],
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
      `insert into agent_runs (id, conversation_id, agent_id, status, trigger, subject_kind, ended_at, initiated_by)
       values ('sample-run-user-b', 'sample-conv-user-b', $1, 'succeeded', 'chat', 'user', now(), $2)`,
      [agentId, otherBusinessId],
    );
    await client.unsafe(
      `insert into agent_runs (id, conversation_id, agent_id, status, trigger, subject_kind, ended_at, definition_snapshot, initiated_by)
       values ('sample-run-draft', 'sample-conv-a', $1, 'succeeded', 'chat', 'user', now(), '{}'::jsonb, $2)`,
      [agentId, businessId],
    );
    await client.unsafe(
      `insert into messages (id, conversation_id, role, content, run_id, created_at)
       values ('sample-msg-a2', 'sample-conv-a', 'user', '{"text":"第二条"}'::jsonb, 'sample-run-a', now() + interval '1 second'),
              ('sample-msg-a1', 'sample-conv-a', 'user', '{"text":"第一条"}'::jsonb, 'sample-run-a', now()),
              ('sample-msg-a0', 'sample-conv-a', 'assistant', '{"text":"回答"}'::jsonb, 'sample-run-a', now() - interval '1 second'),
              ('sample-msg-b', 'sample-conv-b', 'user', '{"text":"B 的输入"}'::jsonb, 'sample-run-b', now()),
              ('sample-msg-c', 'sample-conv-c', 'user', '{"text":"C 的输入"}'::jsonb, 'sample-run-c', now()),
              ('sample-msg-eval', 'sample-conv-a', 'user', '{"text":"评估运行输入"}'::jsonb, 'sample-run-eval', now()),
              ('sample-msg-running', 'sample-conv-a', 'user', '{"text":"运行中输入"}'::jsonb, 'sample-run-running', now()),
              ('sample-msg-no-end', 'sample-conv-a', 'user', '{"text":"无结束时间输入"}'::jsonb, 'sample-run-no-end', now()),
              ('sample-msg-channel', 'sample-conv-a', 'user', '{"text":"频道运行输入"}'::jsonb, 'sample-run-channel', now()),
              ('sample-msg-schedule', 'sample-conv-a', 'user', '{"text":"定时运行输入"}'::jsonb, 'sample-run-schedule', now()),
              ('sample-msg-source-linked', 'sample-conv-a', 'user', '{"text":"已转用例输入"}'::jsonb, 'sample-run-source-linked', now()),
              ('sample-msg-feedback-linked', 'sample-conv-a', 'user', '{"text":"已转反馈输入"}'::jsonb, 'sample-run-feedback-linked', now()),
              ('sample-msg-other', 'sample-conv-other', 'user', '{"text":"其他专家输入"}'::jsonb, 'sample-run-other', now()),
              ('sample-msg-user-b', 'sample-conv-user-b', 'user', '{"text":"他人输入"}'::jsonb, 'sample-run-user-b', now()),
              ('sample-msg-draft', 'sample-conv-a', 'user', '{"text":"试跑输入"}'::jsonb, 'sample-run-draft', now())`,
    );
    await client.unsafe(
      `insert into messages (id, conversation_id, role, content, run_id)
       values ('sample-msg-long', 'sample-conv-long', 'user', $1::jsonb, 'sample-run-long')`,
      [JSON.stringify({ text: longPrompt })],
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
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 10, access: ownData });
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

  it('scopes candidates by runs.read access', async () => {
    const own = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50, access: ownData });
    const ownIds = own.map((row) => row.runId);
    expect(ownIds).toContain('sample-run-a');
    expect(ownIds).not.toContain('sample-run-user-b');

    const all = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50, access: platform });
    expect(all.map((row) => row.runId)).toContain('sample-run-user-b');

    const none = await evalRepo.sampleProductionRuns(db, {
      agentId,
      limit: 50,
      access: { businessId, scopes: ['authorized_resources'] },
    });
    expect(none).toEqual([]);
  });

  it('excludes eval runs, non-succeeded runs, channel and schedule runs, and other agents', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50, access: ownData });
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

  it('excludes runs with a draft definition snapshot', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50, access: ownData });
    expect(rows.map((row) => row.runId)).not.toContain('sample-run-draft');
  });

  it('excludes runs already linked through eval_cases.source_run_id or run_feedback', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50, access: ownData });
    const ids = rows.map((row) => row.runId);
    expect(ids).not.toContain('sample-run-source-linked');
    expect(ids).not.toContain('sample-run-feedback-linked');
  });

  it('applies the requested limit', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 2, access: ownData });
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(eligible).toContain(row.runId);
  });

  it('keeps the raw prefix of a long prompt with leading whitespace', async () => {
    const rows = await evalRepo.sampleProductionRuns(db, { agentId, limit: 50, access: ownData });
    const long = rows.find((row) => row.runId === 'sample-run-long');
    expect(long?.prompt).toBe(longPrompt.slice(0, 20_000));
  });
});
