import { QUESTION_LIMITS } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { newId } from '../src/id.js';
import * as chat from '../src/repo/chat.js';
import * as questions from '../src/repo/questions.js';
import { agents, schema } from '../src/schema.js';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? '',
  max: 4,
  statement_timeout: 15_000,
  connectionTimeoutMillis: 5_000,
});
const db = drizzle(pool, { schema });
const ready = await pool.query('select 1').then(
  () => true,
  () => false,
);

const agentIds: string[] = [];
const businessId = 'questions-owner';

const questionSet = (text = '你希望用什么语言？') => [
  {
    question: text,
    header: '选择',
    options: [
      { label: 'TypeScript', description: '类型安全' },
      { label: 'Python', description: '生态丰富' },
    ],
    multiSelect: false,
  },
];

async function seedRun(status: 'queued' | 'running' | 'succeeded' = 'running'): Promise<string> {
  const agentId = newId('agent');
  agentIds.push(agentId);
  await db.insert(agents).values({
    id: agentId,
    slug: `question-${agentId.slice(4)}`,
    name: 'question',
    model: 'test',
    createdBy: businessId,
    ownerBusinessId: businessId,
  });
  const conversation = await chat.createConversation(db, {
    id: newId('conversation'),
    agentId,
    title: 'question',
    subject: { kind: 'user', businessId },
  });
  const run = await chat.createRun(db, {
    id: newId('run'),
    conversationId: conversation.id,
    agentId,
    subject: { kind: 'user', businessId },
  });
  await chat.updateRun(db, run.id, { status });
  return run.id;
}

const future = () => new Date(Date.now() + 10 * 60_000);

async function create(runId: string, requestId = 'req-1') {
  return questions.createQuestion(db, {
    runId,
    requestId,
    toolUseId: 'tool-1',
    questions: questionSet(),
    expiresAt: future(),
  });
}

describe.skipIf(!ready)('run questions repo', () => {
  afterAll(async () => {
    for (const agentId of agentIds) await db.delete(agents).where(eq(agents.id, agentId));
    await pool.end();
  });

  it('creates and lists pending questions in creation order', async () => {
    const runId = await seedRun();
    const first = await create(runId, 'req-1');
    const second = await create(runId, 'req-2');

    expect(first).toMatchObject({
      requestId: 'req-1',
      runId,
      status: 'pending',
      answers: null,
      resolvedAt: null,
      closeReason: null,
    });
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const list = await questions.listQuestions(db, runId);
    expect(list.map((item) => item.requestId)).toEqual(['req-1', 'req-2']);
    expect(second.requestId).toBe('req-2');
  });

  it('returns the existing row when the same runner request is created twice', async () => {
    const runId = await seedRun();
    const first = await create(runId);
    const again = await create(runId);
    expect(again.createdAt).toBe(first.createdAt);
    expect(await questions.listQuestions(db, runId)).toHaveLength(1);
  });

  it('persists answers and treats the same answer as idempotent', async () => {
    const runId = await seedRun();
    await create(runId);

    const answered = await questions.respondToQuestion(db, runId, 'req-1', {
      answers: { '0': 'TypeScript' },
    });
    expect(answered).toMatchObject({
      status: 'answered',
      answers: { '你希望用什么语言？': 'TypeScript' },
    });
    expect(answered?.resolvedAt).not.toBeNull();

    const repeated = await questions.respondToQuestion(db, runId, 'req-1', {
      answers: { '0': 'TypeScript' },
    });
    expect(repeated).toEqual(answered);

    await expect(
      questions.respondToQuestion(db, runId, 'req-1', {
        answers: { '0': 'Python' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps choices and additional text to original SDK question keys and labels', async () => {
    const runId = await seedRun();
    const question = { ...questionSet()[0], multiSelect: true };
    await questions.createQuestion(db, {
      runId,
      requestId: 'multi',
      toolUseId: 'tool-multi',
      questions: [question],
      expiresAt: future(),
    });
    const response = { answers: { '0': ' original free text ' }, choices: { '0': ['1', '0'] } };
    const result = await questions.respondToQuestion(db, runId, 'multi', response);
    expect(result?.answers).toEqual({
      [question.question]: 'Python, TypeScript,  original free text ',
    });
    expect(await questions.respondToQuestion(db, runId, 'multi', response)).toEqual(result);
  });

  it('rejects a combined choice and free text that exceeds the SDK answer limit', async () => {
    const runId = await seedRun();
    await questions.createQuestion(db, {
      runId,
      requestId: 'long',
      toolUseId: 'tool-long',
      questions: [{ ...questionSet()[0], multiSelect: true }],
      expiresAt: future(),
    });
    await expect(
      questions.respondToQuestion(db, runId, 'long', {
        answers: { '0': 'x'.repeat(2_000) },
        choices: { '0': ['0'] },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects four mapped answers that overflow the SDK payload without marking them answered', async () => {
    const runId = await seedRun();
    const longQuestions = Array.from({ length: QUESTION_LIMITS.questions }, (_, index) => ({
      question: `q${index}`.padEnd(200, 'k'),
      header: `h${index}`,
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      multiSelect: true,
    }));
    await questions.createQuestion(db, {
      runId,
      requestId: 'four-long',
      toolUseId: 'tool-four',
      questions: longQuestions,
      expiresAt: future(),
    });
    const freeText = 'x'.repeat(1_900);
    const response = {
      answers: Object.fromEntries(longQuestions.map((_, index) => [String(index), freeText])),
      choices: Object.fromEntries(longQuestions.map((_, index) => [String(index), ['0']])),
    };
    const mapped = Object.fromEntries(
      longQuestions.map((item) => [item.question, `A, ${freeText}`]),
    );
    // 逐题 1,903 字符合法，但原问题键映射后整体载荷超过 SDK stdin 上限。
    expect(JSON.stringify(mapped).length).toBeGreaterThan(QUESTION_LIMITS.responseBytes);

    await expect(
      questions.respondToQuestion(db, runId, 'four-long', response),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await questions.listQuestions(db, runId)).toMatchObject([
      { requestId: 'four-long', status: 'pending', answers: null },
    ]);
  });

  it('accepts four mapped answers that stay under the SDK payload limit', async () => {
    const runId = await seedRun();
    const longQuestions = Array.from({ length: QUESTION_LIMITS.questions }, (_, index) => ({
      question: `q${index}`.padEnd(200, 'k'),
      header: `h${index}`,
      options: [
        { label: 'A', description: '' },
        { label: 'B', description: '' },
      ],
      multiSelect: true,
    }));
    await questions.createQuestion(db, {
      runId,
      requestId: 'four-ok',
      toolUseId: 'tool-four',
      questions: longQuestions,
      expiresAt: future(),
    });
    const freeText = 'x'.repeat(500);
    const mapped = Object.fromEntries(
      longQuestions.map((item) => [item.question, `A, ${freeText}`]),
    );
    expect(JSON.stringify(mapped).length).toBeLessThanOrEqual(QUESTION_LIMITS.responseBytes);

    const answered = await questions.respondToQuestion(db, runId, 'four-ok', {
      answers: Object.fromEntries(longQuestions.map((_, index) => [String(index), freeText])),
      choices: Object.fromEntries(longQuestions.map((_, index) => [String(index), ['0']])),
    });
    expect(answered).toMatchObject({ status: 'answered' });
    expect(Object.keys(answered?.answers ?? {})).toHaveLength(QUESTION_LIMITS.questions);
  });

  it('rejects unknown, repeated or multiple single-select option identities', async () => {
    const runId = await seedRun();
    await create(runId);
    for (const response of [
      { answers: {}, choices: { '0': ['4'] } },
      { answers: {}, choices: { '0': ['0', '0'] } },
      { answers: {}, choices: { '0': ['0', '1'] } },
      { answers: { '0': 'text' }, choices: { '0': ['0'] } },
      { answers: {}, choices: { '1': ['0'] } },
      { answers: {} },
    ]) {
      await expect(questions.respondToQuestion(db, runId, 'req-1', response)).rejects.toMatchObject(
        { code: 'CONFLICT' },
      );
    }
  });

  it('persists an explicit decline and refuses answers afterwards', async () => {
    const runId = await seedRun();
    await create(runId);

    const declined = await questions.respondToQuestion(db, runId, 'req-1', { decline: true });
    expect(declined).toMatchObject({ status: 'declined', answers: null });
    expect(await questions.respondToQuestion(db, runId, 'req-1', { decline: true })).toEqual(
      declined,
    );
    await expect(
      questions.respondToQuestion(db, runId, 'req-1', {
        answers: { '0': 'Python' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects answers while the run is not running', async () => {
    const runId = await seedRun('succeeded');
    await create(runId);
    await expect(
      questions.respondToQuestion(db, runId, 'req-1', {
        answers: { '0': 'Python' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns null for an unknown run or request id', async () => {
    const runId = await seedRun();
    expect(
      await questions.respondToQuestion(db, newId('run'), 'req-1', { decline: true }),
    ).toBeNull();
    expect(await questions.respondToQuestion(db, runId, 'missing', { decline: true })).toBeNull();
  });

  it('requires the exact question keys and non-blank values', async () => {
    const runId = await seedRun();
    await create(runId);
    for (const answers of [
      { unknown: 'TypeScript' },
      { '你希望用什么语言？': '   ' },
      { '你希望用什么语言？': 'TypeScript', extra: 'Python' },
    ]) {
      await expect(
        questions.respondToQuestion(db, runId, 'req-1', { answers }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    }
  });

  it('refuses to answer an expired question', async () => {
    const runId = await seedRun();
    await questions.createQuestion(db, {
      runId,
      requestId: 'expired',
      toolUseId: 'tool-1',
      questions: questionSet(),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      questions.respondToQuestion(db, runId, 'expired', { decline: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('closes only pending questions and records the reason', async () => {
    const runId = await seedRun();
    await create(runId, 'req-1');
    await create(runId, 'req-2');
    await questions.respondToQuestion(db, runId, 'req-1', { decline: true });

    const closed = await questions.closeQuestions(db, runId, 'run_finished');
    expect(closed.map((item) => item.requestId)).toEqual(['req-2']);
    expect(closed[0]).toMatchObject({ status: 'closed', closeReason: 'run_finished' });
    expect(closed[0]?.resolvedAt).not.toBeNull();

    const all = await questions.listQuestions(db, runId);
    expect(all[0]).toMatchObject({ requestId: 'req-1', status: 'declined' });
    await expect(
      questions.respondToQuestion(db, runId, 'req-2', { decline: true }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('does not overwrite a close queued ahead of an overlapping answer', async () => {
    const runId = await seedRun();
    await create(runId);
    const blocker = await pool.connect();
    const waiting = async () => {
      const result = await pool.query<{ count: string }>(
        `select count(*) from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
           and query like '%run_questions%'`,
      );
      return Number(result.rows[0]?.count);
    };
    let operations: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('select id from run_questions where run_id = $1 for update', [runId]);
      const closing = questions.closeQuestions(db, runId, 'cancelled');
      await expect.poll(waiting).toBe(1);
      const answering = questions.respondToQuestion(db, runId, 'req-1', { decline: true });
      operations = Promise.allSettled([closing, answering]);
      await expect.poll(waiting).toBe(2);
      await blocker.query('commit');
      const result = await operations;
      expect(result[0]).toMatchObject({ status: 'fulfilled', value: [{ status: 'closed' }] });
      expect(result[1]).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
      expect(await questions.listQuestions(db, runId)).toMatchObject([
        { status: 'closed', answers: null, closeReason: 'cancelled' },
      ]);
    } finally {
      await blocker.query('rollback');
      blocker.release();
      await operations;
    }
  });

  it('closes a single question when a request id is given', async () => {
    const runId = await seedRun();
    await create(runId, 'req-1');
    await create(runId, 'req-2');

    const closed = await questions.closeQuestions(db, runId, 'cancelled', 'req-2');
    expect(closed.map((item) => item.requestId)).toEqual(['req-2']);
    expect(await questions.listQuestions(db, runId)).toMatchObject([
      { requestId: 'req-1', status: 'pending' },
      { requestId: 'req-2', status: 'closed', closeReason: 'cancelled' },
    ]);
  });
});
