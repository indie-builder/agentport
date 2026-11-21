import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createIsolatedDatabase } from '../../worker/test/isolated-db.js';

const isolated = await createIsolatedDatabase(
  'api_eval_sample_candidates',
  process.env.DATABASE_URL ?? '',
);
if (isolated) process.env.DATABASE_URL = isolated.url;

const helpers = await import('./helpers.js');
const { createAgent, createTestAccount, loginCookie, request, startApp, unique } = helpers;

import type { TestApp } from './helpers.js';

const ready = await helpers.infraReady;
if (!ready && isolated) await isolated.close();

interface Candidate {
  runId: string;
}

describe.skipIf(!(ready && isolated))('eval sample candidates access', () => {
  let app: TestApp;
  let adminCookie: string;

  beforeAll(async () => {
    app = await startApp();
    adminCookie = await loginCookie(app);
  });

  afterAll(async () => {
    try {
      if (app) await app.close();
    } finally {
      await isolated?.close();
    }
  });

  async function seedRun(agentId: string, initiatedBy: string, text: string): Promise<string> {
    const conversationId = unique('sample-conv');
    const runId = unique('sample-run');
    await app.client.unsafe(
      'insert into conversations (id, agent_id, created_by, title) values ($1, $2, $3, $4)',
      [conversationId, agentId, initiatedBy, text],
    );
    await app.client.unsafe(
      `insert into agent_runs
         (id, conversation_id, agent_id, status, trigger, subject_kind, initiated_by, ended_at)
       values ($1, $2, $3, 'succeeded', 'chat', 'user', $4, now())`,
      [runId, conversationId, agentId, initiatedBy],
    );
    await app.client.unsafe(
      `insert into messages (id, conversation_id, role, content, run_id)
       values ($1, $2, 'user', $3::jsonb, $4)`,
      [unique('sample-msg'), conversationId, JSON.stringify({ text }), runId],
    );
    return runId;
  }

  const sample = (agentId: string, cookie: string) =>
    request(app, {
      method: 'GET',
      url: `/api/eval/cases/sample-candidates?agentId=${encodeURIComponent(agentId)}&limit=10`,
      headers: { cookie },
    });

  it('only returns runs initiated by the caller under own_data', async () => {
    const owner = await createTestAccount(app, adminCookie, { systemKeys: ['owner'] });
    const other = await createTestAccount(app, adminCookie, { systemKeys: ['user'] });
    const agentId = (await createAgent(app, owner.cookie)).json<{ id: string }>().id;
    const ownRun = await seedRun(agentId, owner.businessId, '本人输入');
    const otherRun = await seedRun(agentId, other.businessId, '他人输入');

    const res = await sample(agentId, owner.cookie);
    expect(res.statusCode, res.body).toBe(200);
    const ownIds = res.json<Candidate[]>().map((row) => row.runId);
    expect(ownIds).toContain(ownRun);
    expect(ownIds).not.toContain(otherRun);

    const adminRes = await sample(agentId, adminCookie);
    expect(adminRes.statusCode, adminRes.body).toBe(200);
    const adminIds = adminRes.json<Candidate[]>().map((row) => row.runId);
    expect(adminIds).toContain(ownRun);
    expect(adminIds).toContain(otherRun);
  });
});
