import { repo } from '@agentport/db';
import type { PublicRunQuestion, RunQuestion } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestRunCancel } from '../src/queue/producer.js';
import {
  cleanup,
  createAgent,
  expectProblem,
  infraReady,
  inject,
  loginCookie,
  seedRun,
  startApp,
  unique,
} from './helpers.js';

const ready = await infraReady;
const QUESTION = '你希望用什么语言？';

const questionSet = [
  {
    question: QUESTION,
    header: '语言',
    options: [
      { label: 'TypeScript', description: '类型安全' },
      { label: 'Python', description: '生态丰富' },
    ],
    multiSelect: false,
  },
];

describe.skipIf(!ready)('run question routes', () => {
  let app: FastifyInstance;
  let cookie: string;
  const agentSlugs: string[] = [];
  const runIds: string[] = [];

  beforeAll(async () => {
    app = await startApp();
    cookie = await loginCookie(app);
  });

  afterAll(async () => {
    await cleanup(app, { agentSlugs, runIds });
    await app.close();
  });

  const auth = () => ({ cookie });

  async function run(status: 'running' | 'succeeded' = 'running') {
    const agent = (
      await createAgent(app, cookie, { slug: unique('question-agent'), track: agentSlugs })
    ).json<{ id: string }>();
    const seeded = await seedRun(app, agent.id);
    runIds.push(seeded.runId);
    if (status !== 'running') {
      await repo.chat.updateRun(app.db, seeded.runId, { status });
    }
    return seeded.runId;
  }

  async function ask(runId: string, requestId = 'req-1') {
    return repo.questions.createQuestion(app.db, {
      runId,
      requestId,
      toolUseId: 'tool-1',
      questions: questionSet,
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  }

  const list = (runId: string) =>
    inject(app, {
      method: 'GET',
      url: `/api/runs/${runId}/questions`,
      headers: auth(),
    });

  const respond = (runId: string, requestId: string, payload: unknown) =>
    inject(app, {
      method: 'POST',
      url: `/api/runs/${runId}/questions/${requestId}/response`,
      headers: auth(),
      payload,
    });

  it('keeps the tool step question snapshot in the terminal run detail response', async () => {
    const agent = (
      await createAgent(app, cookie, { slug: unique('question-agent'), track: agentSlugs })
    ).json<{ id: string }>();
    const seeded = await seedRun(app, agent.id);
    runIds.push(seeded.runId);
    await repo.chat.updateRun(app.db, seeded.runId, { status: 'succeeded' });

    const now = new Date();
    const snapshot: PublicRunQuestion = {
      requestId: 'req-detail',
      runId: seeded.runId,
      toolUseId: 'tool-detail',
      questions: [
        {
          question: QUESTION,
          header: '语言',
          multiSelect: false,
          options: [
            { value: '0', label: 'TypeScript', description: '类型安全' },
            { value: '1', label: 'Python', description: '生态丰富' },
          ],
        },
      ],
      status: 'answered',
      answers: { '0': 'TypeScript' },
      createdAt: now.toISOString(),
      resolvedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      closeReason: null,
    };

    await repo.chat.appendMessage(app.db, {
      id: unique('msg'),
      conversationId: seeded.conversationId,
      role: 'tool',
      runId: seeded.runId,
      content: {
        type: 'tool_use',
        name: 'AskUserQuestion',
        id: 'tool-detail',
        input: { questions: [] },
        question: snapshot,
      },
    });

    const res = await inject(app, {
      method: 'GET',
      url: `/api/runs/${seeded.runId}`,
      headers: auth(),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().steps).toMatchObject([
      { kind: 'tool', toolUseId: 'tool-detail', question: snapshot },
    ]);
  });

  it('requires login for both endpoints', async () => {
    const runId = await run();
    expectProblem(
      await inject(app, { method: 'GET', url: `/api/runs/${runId}/questions` }),
      'UNAUTHORIZED',
    );
    expectProblem(
      await inject(app, {
        method: 'POST',
        url: `/api/runs/${runId}/questions/req-1/response`,
        payload: { decline: true },
      }),
      'UNAUTHORIZED',
    );
  });

  it('lists questions for a run and rejects unknown runs', async () => {
    const runId = await run();
    await ask(runId);

    const res = await list(runId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<{ items: RunQuestion[] }>().items).toMatchObject([
      { requestId: 'req-1', runId, status: 'pending', answers: null },
    ]);

    expectProblem(await list(unique('missing-run')), 'RUN_NOT_FOUND');
  });

  it('records an answer, is idempotent for the same answer, and rejects a different one', async () => {
    const runId = await run();
    await ask(runId);

    const first = await respond(runId, 'req-1', { answers: { '0': 'TypeScript' } });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json<RunQuestion>()).toMatchObject({
      status: 'answered',
      answers: { '0': 'TypeScript' },
    });

    const repeated = await respond(runId, 'req-1', { answers: { '0': 'TypeScript' } });
    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json<RunQuestion>()).toEqual(first.json<RunQuestion>());

    expectProblem(await respond(runId, 'req-1', { answers: { '0': 'Python' } }), 'CONFLICT');

    const audit = await app.pool.query<{ action: string }>(
      'select action from audit_log where target = $1 order by created_at desc limit 1',
      [runId],
    );
    expect(audit.rows[0]?.action).toBe('agent.run.question.responded');
  });

  it('projects secrets and restores selected original labels using stable indices', async () => {
    const runId = await run();
    const secret = 'sk-test-secret-1234567890123456';
    const originalText = `选择 ${secret}？`;
    await repo.questions.createQuestion(app.db, {
      runId,
      requestId: 'secret',
      toolUseId: 'tool-secret',
      questions: [
        {
          ...questionSet[0],
          question: originalText,
          options: [
            { label: secret, description: `TOKEN=${secret}` },
            { label: 'Other', description: '' },
          ],
        },
      ],
      expiresAt: new Date(Date.now() + 60_000),
    });
    const pending = await list(runId);
    expect(pending.statusCode).toBe(200);
    expect(pending.body).not.toContain(secret);
    expect(pending.json().items[0].questions[0].options[0]).toMatchObject({ value: '0' });
    const answered = await respond(runId, 'secret', { answers: {}, choices: { '0': ['0'] } });
    expect(answered.statusCode, answered.body).toBe(200);
    expect(answered.body).not.toContain(secret);
    expect(answered.json()).toMatchObject({ status: 'answered', answers: { '0': 'sk-t***' } });
    const stored = (await repo.questions.listQuestions(app.db, runId))[0];
    expect(stored).toMatchObject({ answers: { [originalText]: secret } });
    expect((await list(runId)).json().items[0]).toEqual(answered.json());
    const repeated = await respond(runId, 'secret', { answers: {}, choices: { '0': ['0'] } });
    expect(repeated.statusCode, repeated.body).toBe(200);
  });

  it('records an explicit decline', async () => {
    const runId = await run();
    await ask(runId);

    const res = await respond(runId, 'req-1', { decline: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json<RunQuestion>()).toMatchObject({ status: 'declined', answers: null });
  });

  it('validates the response body once at the entry', async () => {
    const runId = await run();
    await ask(runId);

    for (const payload of [
      { answers: {}, decline: true },
      { answers: { '0': '   ' } },
      { answers: { '0': 'x'.repeat(4_000) } },
      { questions: questionSet },
    ]) {
      expectProblem(await respond(runId, 'req-1', payload), 'INVALID_INPUT');
    }
  });

  it('returns 404 for an unknown request id', async () => {
    const runId = await run();
    expectProblem(await respond(runId, 'missing', { decline: true }), 'NOT_FOUND');
  });

  it('rejects answers once the run has ended', async () => {
    const endedRun = await run('succeeded');
    await ask(endedRun);
    expectProblem(await respond(endedRun, 'req-1', { decline: true }), 'CONFLICT');
  });

  it('rejects answers after cancel has been requested', async () => {
    const runId = await run();
    await ask(runId);
    await requestRunCancel(runId);

    expectProblem(await respond(runId, 'req-1', { decline: true }), 'CONFLICT');
  });
});
