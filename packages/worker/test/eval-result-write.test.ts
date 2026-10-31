import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { inspect } from 'node:util';
import { createDb, newId, repo, schema } from '@agentport/db';
import { eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIsolatedDatabase } from './isolated-db.js';

/**
 * 结果持久化跑批的真实数据库契约：只用随机隔离库证明 repo 事务与批次收口，
 * 队列仍用 mock（不在本套件启动真实 worker / 模型）。
 */
const mocks = vi.hoisted(() => ({
  queueAdd: vi.fn(),
  waitUntilReady: vi.fn(async () => undefined),
  waitUntilFinished: vi.fn(async () => undefined),
  checkAccess: vi.fn(async () => ({
    denial: null,
    grants: [{ permissionId: 'eval.read' as const, scope: 'owned_agents' as const }],
  })),
}));

vi.mock('../src/run-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run-access.js')>();
  return { ...actual, loadUserAgentAccess: mocks.checkAccess };
});

vi.mock('bullmq', () => ({
  Queue: class {
    add = mocks.queueAdd;
    close = vi.fn(async () => undefined);
  },
  QueueEvents: class {
    on = vi.fn();
    close = vi.fn(async () => undefined);
    waitUntilReady = mocks.waitUntilReady;
  },
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

const { executeEvalRun, EVAL_FAILURE_PUBLIC_MESSAGE } = await import('../src/eval-runner.js');
const { handleEvalJobFailed, runEvalJob } = await import('../src/eval-job.js');
const { UnrecoverableError } = await import('bullmq');

const isolated = await createIsolatedDatabase('worker_eval_write');
const dbHandle = createDb(isolated?.url ?? '');
const { db } = dbHandle;

const logs: string[] = [];
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: (...args: unknown[]) => {
    logs.push(inspect(args, { depth: 6 }));
  },
  debug: () => undefined,
} as unknown as Logger;

const RESULT_SECRET = `sk-live-eval-result-${randomUUID()}`;
const FINISH_SECRET = `sk-live-eval-finish-${randomUUID()}`;

type CaseInput = { name: string; prompt: string; expectation: string };
const evalBusinessId = 'eval-write-owner';

async function seed(cases: CaseInput[]) {
  const agentId = newId('agent');
  await db.insert(schema.agents).values({
    id: agentId,
    slug: `eval-write-${randomUUID().slice(0, 8)}`,
    name: 'eval-write',
    model: 'test',
    createdBy: evalBusinessId,
    ownerBusinessId: evalBusinessId,
  });
  const snapshot = cases.map((testCase) => ({ id: newId('evalCase'), ...testCase }));
  await db
    .insert(schema.evalCases)
    .values(snapshot.map((testCase) => ({ ...testCase, agentId, createdBy: evalBusinessId })));
  const evalRunId = newId('evalRun');
  await db.insert(schema.evalRuns).values({
    id: evalRunId,
    agentId,
    status: 'running',
    total: snapshot.length,
    caseSnapshot: snapshot,
    createdBy: evalBusinessId,
  });
  return { agentId, evalRunId, snapshot };
}

/** mock 队列的消费者：把子 run 收敛为 succeeded，并写入一条可判定的 assistant 消息。 */
async function completeRun(data: { runId: string; conversationId: string; prompt: string }) {
  await db
    .update(schema.agentRuns)
    .set({ status: 'succeeded', endedAt: new Date() })
    .where(eq(schema.agentRuns.id, data.runId));
  await db.insert(schema.messages).values({
    id: newId('message'),
    conversationId: data.conversationId,
    role: 'assistant',
    content: { type: 'text', text: `reply:${data.prompt}` },
  });
}

/** 数据库异常原文含 SQL 与参数；公开输出不得出现这些片段或注入的 secret。 */
function expectNoSqlLeak(text: string, secret: string): void {
  expect(text).not.toContain(secret);
  expect(text).not.toMatch(/Failed query/i);
  expect(text).not.toMatch(/params:/i);
  expect(text).not.toContain('messages');
}

describe.skipIf(isolated === null)('eval result persistence against a real database', () => {
  beforeAll(async () => {
    // 定向故障：只有 name=fault 的结果插入失败，其他用例仍走真实 repo 事务。
    await dbHandle.pool.query(`
      create or replace function eval_result_write_fault() returns trigger language plpgsql as $fn$
      begin
        if new.case_snapshot->>'name' = 'fault' then
          raise exception 'forced eval result write failure %', '${RESULT_SECRET}';
        end if;
        return new;
      end;
      $fn$
    `);
    await dbHandle.pool.query(`
      create trigger eval_result_write_fault
      before insert on eval_results
      for each row execute function eval_result_write_fault()
    `);
  });

  beforeEach(() => {
    logs.length = 0;
    mocks.queueAdd.mockReset();
    mocks.waitUntilFinished.mockReset().mockResolvedValue(undefined);
    mocks.queueAdd.mockImplementation(async (_name, data) => {
      await completeRun(data);
      return { waitUntilFinished: mocks.waitUntilFinished };
    });
  });

  afterAll(async () => {
    await dbHandle.pool.end();
    await isolated?.close();
  });

  it('persists snapshot results through the real repo and succeeds the batch', async () => {
    const { evalRunId, snapshot } = await seed([
      { name: 'alpha', prompt: 'prompt-alpha', expectation: 'reply:prompt-alpha' },
      { name: 'beta', prompt: 'prompt-beta', expectation: 'reply:prompt-beta' },
    ]);

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'succeeded', passed: 2, error: null });
    expect(
      detail?.results.map((result) => ({
        caseId: result.caseId,
        passed: result.passed,
        output: result.output,
      })),
    ).toEqual(
      snapshot.map((testCase) => ({
        caseId: testCase.id,
        passed: true,
        output: `reply:${testCase.prompt}`,
      })),
    );
    const runIds = detail?.results.map((result) => result.runId) ?? [];
    expect(runIds).toHaveLength(2);
    expect(runIds.every((runId) => runId !== null)).toBe(true);
    const runs = await db
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(inArray(schema.agentRuns.id, runIds));
    expect(runs).toHaveLength(2);
  });

  it('fails the batch on a real result insert failure without inflating passed', async () => {
    const { evalRunId } = await seed([
      { name: 'ok', prompt: 'prompt-ok', expectation: 'reply:prompt-ok' },
      { name: 'fault', prompt: 'prompt-fault', expectation: 'reply:prompt-fault' },
      { name: 'after', prompt: 'prompt-after', expectation: 'reply:prompt-after' },
    ]);

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun.status).toBe('failed');
    // 只有第一条真正落库，passed 不能把失败的那条算进去。
    expect(detail?.evalRun.passed).toBe(1);
    // 数据库错误原文（含 SQL 与参数）不能进入 eval_runs.error 或 worker 日志。
    expect(detail?.evalRun.error).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);
    expect(detail?.evalRun.error).not.toContain(RESULT_SECRET);
    expect(detail?.evalRun.error).not.toMatch(/Failed query|params:|eval_results/);
    expect(logs.join('\n')).not.toContain(RESULT_SECRET);
    expect(logs.join('\n')).not.toMatch(/Failed query|params:/);
    expect(detail?.results).toHaveLength(1);
    expect(detail?.results[0]).toMatchObject({ name: 'ok', passed: true });
    // 写失败后不再执行第三条。
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
  });

  it('redacts a case-level messages insert failure from the persisted result output', async () => {
    const secret = `sk-live-eval-message-${randomUUID()}`;
    const prompt = `prompt-message-${secret}`;
    const { evalRunId } = await seed([
      { name: 'message-fault', prompt, expectation: 'reply:never' },
    ]);
    const functionName = `eval_message_fault_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await dbHandle.pool.query(`
      create or replace function ${functionName}() returns trigger language plpgsql as $fn$
      begin
        if new.content->>'text' = '${prompt}' then
          raise exception 'forced message insert failure';
        end if;
        return new;
      end;
      $fn$
    `);
    await dbHandle.pool.query(`
      create trigger ${functionName}
      before insert on messages
      for each row execute function ${functionName}()
    `);
    try {
      await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });
    } finally {
      await dbHandle.pool.query(`drop trigger if exists ${functionName} on messages`);
      await dbHandle.pool.query(`drop function if exists ${functionName}()`);
    }

    // 用例在准入写入时失败，没走到队列。
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'failed', passed: 0, error: null });
    expect(detail?.results).toHaveLength(1);
    const output = detail?.results[0]?.output ?? '';
    // 数据库异常原文（SQL、参数与注入 secret）不能成为公开的用例输出。
    expect(output).toBe(EVAL_FAILURE_PUBLIC_MESSAGE);
    expectNoSqlLeak(output, secret);
  });

  it('keeps an ordinary case failure readable instead of the public database message', async () => {
    const { evalRunId } = await seed([
      { name: 'domain', prompt: 'prompt-domain', expectation: 'reply:prompt-domain' },
    ]);
    mocks.queueAdd.mockRejectedValueOnce(new Error('run queue unavailable'));

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'failed', passed: 0, error: null });
    expect(detail?.results[0]?.output).toBe('run queue unavailable');
  });

  it('waits for a delegated child memory lock before admitting the eval case run', async () => {
    const { agentId, evalRunId } = await seed([
      { name: 'locked', prompt: 'prompt-locked', expectation: 'reply:prompt-locked' },
    ]);
    const childId = newId('agent');
    await db.insert(schema.agents).values({
      id: childId,
      slug: `eval-child-${randomUUID().slice(0, 8)}`,
      name: 'eval-child',
      model: 'test',
      parentId: agentId,
      createdBy: evalBusinessId,
      ownerBusinessId: evalBusinessId,
    });

    const client = await dbHandle.pool.connect();
    let settled = false;
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`agent:${childId}`]);
      const pending = executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId }).then(
        () => {
          settled = true;
        },
      );
      await delay(200);
      expect(settled, 'eval admission did not wait for the child memory lock').toBe(false);
      await client.query('commit');
      await pending;
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }

    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun.status).toBe('succeeded');
  });

  it('propagates a final finish failure and settles the batch without zeroing passed', async () => {
    const { evalRunId } = await seed([
      { name: 'alpha', prompt: 'prompt-alpha', expectation: 'reply:prompt-alpha' },
    ]);
    const functionName = 'eval_finish_fault';
    await dbHandle.pool.query(`
      create or replace function ${functionName}() returns trigger language plpgsql as $fn$
      begin
        if new.id = '${evalRunId}' and new.status = 'succeeded' then
          raise exception 'forced finish failure %', '${FINISH_SECRET}';
        end if;
        return new;
      end;
      $fn$
    `);
    await dbHandle.pool.query(`
      create trigger ${functionName}
      before update on eval_runs
      for each row execute function ${functionName}()
    `);
    try {
      // 原始错误仍抛给 BullMQ，不能被收口吞掉；secret 在 PG cause 链里。
      let thrown: unknown;
      await expect(
        runEvalJob({ db, logger, redisUrl: 'redis://unused', job: { data: { evalRunId } } }).catch(
          (error: unknown) => {
            thrown = error;
            throw error;
          },
        ),
      ).rejects.toThrow('Failed query');
      expect(inspect(thrown, { depth: 8 })).toContain(FINISH_SECRET);
    } finally {
      await dbHandle.pool.query(`drop trigger if exists ${functionName} on eval_runs`);
      await dbHandle.pool.query(`drop function if exists ${functionName}()`);
    }

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({
      status: 'failed',
      passed: 1,
      error: EVAL_FAILURE_PUBLIC_MESSAGE,
    });
    expect(detail?.evalRun.error).not.toMatch(/Failed query|params:/);
    expect(detail?.evalRun.error).not.toContain(FINISH_SECRET);
    expect(detail?.evalRun.finishedAt).not.toBeNull();
    expect(logs.join('\n')).not.toContain(FINISH_SECRET);
    expect(detail?.results).toHaveLength(1);
  });

  it('refuses an already claimed redelivery and keeps the persisted results', async () => {
    const { evalRunId, snapshot } = await seed([
      { name: 'alpha', prompt: 'prompt-alpha', expectation: 'reply:prompt-alpha' },
      { name: 'beta', prompt: 'prompt-beta', expectation: 'reply:prompt-beta' },
    ]);
    await repo.evalRepo.addResult(
      db,
      {
        id: newId('evalResult'),
        evalRunId,
        caseId: snapshot[0]?.id ?? '',
        caseSnapshot: snapshot[0],
        runId: null,
        passed: true,
        output: 'reply:prompt-alpha',
      },
      { recordProgress: true },
    );
    await db
      .update(schema.evalRuns)
      .set({ claimedAt: new Date() })
      .where(eq(schema.evalRuns.id, evalRunId));
    mocks.queueAdd.mockClear();

    await expect(
      runEvalJob({ db, logger, redisUrl: 'redis://unused', job: { data: { evalRunId } } }),
    ).rejects.toThrow('execution was interrupted');

    // 不重跑：没有新的 case 子 run，已落库的结果与 passed 原样保留。
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'failed', passed: 1 });
    expect(detail?.evalRun.error).toContain('execution was interrupted');
    expect(detail?.evalRun.finishedAt).not.toBeNull();
    expect(detail?.results).toHaveLength(1);
    expect(detail?.results[0]).toMatchObject({ passed: true, output: 'reply:prompt-alpha' });
  });

  it('settles a batch that never reached the processor from the failed event', async () => {
    const { evalRunId } = await seed([
      { name: 'alpha', prompt: 'prompt-alpha', expectation: 'reply:prompt-alpha' },
    ]);

    await handleEvalJobFailed({
      db,
      logger,
      job: { data: { evalRunId } },
      error: new UnrecoverableError('job stalled more than allowable limit'),
    });

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({
      status: 'failed',
      error: 'job stalled more than allowable limit',
    });
    expect(detail?.evalRun.finishedAt).not.toBeNull();
  });

  it('keeps the first terminal state and rejects late results', async () => {
    const { evalRunId, snapshot } = await seed([
      { name: 'alpha', prompt: 'prompt-alpha', expectation: 'reply:prompt-alpha' },
      { name: 'beta', prompt: 'prompt-beta', expectation: 'reply:prompt-beta' },
    ]);
    await repo.evalRepo.addResult(
      db,
      {
        id: newId('evalResult'),
        evalRunId,
        caseId: snapshot[0]?.id ?? '',
        caseSnapshot: snapshot[0],
        runId: null,
        passed: true,
        output: 'reply:prompt-alpha',
      },
      { recordProgress: true },
    );
    expect(await repo.evalRepo.cancelEvalRun(db, evalRunId)).toBe(true);

    await handleEvalJobFailed({
      db,
      logger,
      job: { data: { evalRunId } },
      error: new Error('late failure'),
    });
    // 迟到的用例结果不能推进 passed，也不能再写入结果行。
    await repo.evalRepo.addResult(
      db,
      {
        id: newId('evalResult'),
        evalRunId,
        caseId: snapshot[1]?.id ?? '',
        caseSnapshot: snapshot[1],
        runId: null,
        passed: true,
        output: 'reply:prompt-beta',
      },
      { recordProgress: true },
    );

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'cancelled', error: null, passed: 1 });
    expect(detail?.results).toHaveLength(1);
    expect(await repo.evalRepo.failEvalRun(db, evalRunId, 'late failure')).toBe(false);
    expect(await repo.evalRepo.cancelEvalRun(db, evalRunId)).toBe(false);
  });
});
