import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';

const isolated = await createIsolatedDatabase(
  'api_eval_from_run',
  process.env.DATABASE_URL ?? '',
);
if (isolated) process.env.DATABASE_URL = isolated.url;

const helpers = await import('./helpers.js');
const { ADMIN_BUSINESS_ID, expectProblem, request, loginCookie, startApp, unique } = helpers;

import type { TestApp } from './helpers.js';

const ready = await helpers.infraReady;
if (!ready && isolated) await isolated.close();

interface EvalCase {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
}

describe.skipIf(!(ready && isolated))('eval case from run', () => {
  let app: TestApp;
  let cookie: string;

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      await isolated?.close();
    }
  });

  async function seedAgent(): Promise<string> {
    const id = unique('from-run-agent');
    await app.client.unsafe(
      'insert into agents (id, slug, name, model, created_by, owner_business_id) values ($1, $1, $2, $3, $4, $4)',
      [id, `Agent ${id}`, 'm', ADMIN_BUSINESS_ID],
    );
    return id;
  }

  async function seedRun(options: {
    agentId: string;
    title?: string;
    messages: Array<{ role: string; content: unknown }>;
  }): Promise<string> {
    const id = unique('from-run');
    const conversationId = unique('from-run-conv');
    await app.client.unsafe(
      'insert into conversations (id, agent_id, created_by, title) values ($1, $2, $3, $4)',
      [conversationId, options.agentId, ADMIN_BUSINESS_ID, options.title ?? '季度报告总结'],
    );
    await app.client.unsafe(
      `insert into agent_runs (id, conversation_id, agent_id, status, trigger, subject_kind, initiated_by)
       values ($1, $2, $3, 'succeeded', 'chat', 'user', $4)`,
      [id, conversationId, options.agentId, ADMIN_BUSINESS_ID],
    );
    for (const [index, message] of options.messages.entries()) {
      await app.client.unsafe(
        `insert into messages (id, conversation_id, role, content, run_id, created_at)
         values ($1, $2, $3, $4::jsonb, $5, now() + ($6 || ' seconds')::interval)`,
        [unique('from-run-msg'), conversationId, message.role, JSON.stringify(message.content), id, index],
      );
    }
    return id;
  }

  const fromRun = (payload: unknown, withCookie = true) =>
    request(app, {
      method: 'POST',
      url: '/api/eval/cases/from-run',
      headers: withCookie ? { cookie } : {},
      payload,
    });

  it('creates a case from the first user and last assistant messages', async () => {
    const agentId = await seedAgent();
    const runId = await seedRun({
      agentId,
      messages: [
        { role: 'user', content: { text: '请总结报告' } },
        { role: 'assistant', content: { type: 'text', text: '总结如下。' } },
      ],
    });

    const res = await fromRun({ runId });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<EvalCase>();
    expect(body.agentId).toBe(agentId);
    expect(body.prompt).toContain('请总结报告');
    expect(body.expectation).toContain('总结如下。');
    expect(body.name).toBe('季度报告总结');

    const stored = await app.client.unsafe<{ n: number }[]>(
      'select count(*)::int as n from eval_cases where id = $1 and agent_id = $2',
      [body.id, agentId],
    );
    expect(stored[0]?.n).toBe(1);
  });

  it('requires authentication', async () => {
    expectProblem(await fromRun({ runId: unique('from-run') }, false), 'UNAUTHORIZED');
  });

  it('rejects a run without user input', async () => {
    const agentId = await seedAgent();
    const runId = await seedRun({
      agentId,
      messages: [{ role: 'assistant', content: { type: 'text', text: '只有回复。' } }],
    });

    expectProblem(await fromRun({ runId }), 'INVALID_INPUT');
  });
});
