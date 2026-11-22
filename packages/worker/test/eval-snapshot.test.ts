import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { createDb, newId, repo, schema } from '@agentport/db';
import type { EvalCaseSnapshot } from '@agentport/db/schema';
import { and, asc, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { createIsolatedDatabase } from './isolated-db.js';

const mocks = {
  queueAdd: mock(),
  waitUntilReady: mock(async () => undefined),
  waitUntilFinished: mock(async () => undefined),
};

mock.module('bullmq', () => ({
  createBunRedisClient: () => ({ quit: async () => undefined }),
  Queue: class {
    add = mocks.queueAdd;
    close = mock(async () => undefined);
  },
  QueueEvents: class {
    on = mock();
    close = mock(async () => undefined);
    waitUntilReady = mocks.waitUntilReady;
  },
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

const { EVAL_FAILURE_PUBLIC_MESSAGE, executeEvalRun } = await import('../src/eval-runner.js');
const { handleEvalJobFailed, runEvalJob } = await import('../src/eval-job.js');
const { UnrecoverableError } = await import('bullmq');

const isolated = await createIsolatedDatabase('worker_eval_snapshot');
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

type CaseSeed = {
  id?: string;
  name: string;
  prompt: string;
  expectation: string;
  judgeMode?: 'contains' | 'llm';
  expectedTools?: string[];
  forbiddenTools?: string[];
};

type RunJobPayload = {
  runId: string;
  conversationId: string;
  prompt: string;
};

function toSnapshot(cases: CaseSeed[]): EvalCaseSnapshot[] {
  return cases.map((testCase) => ({
    id: testCase.id ?? newId('evalCase'),
    name: testCase.name,
    prompt: testCase.prompt,
    expectation: testCase.expectation,
    judgeMode: testCase.judgeMode ?? 'contains',
    ...(testCase.expectedTools === undefined ? {} : { expectedTools: testCase.expectedTools }),
    ...(testCase.forbiddenTools === undefined ? {} : { forbiddenTools: testCase.forbiddenTools }),
  }));
}

async function seed(options: {
  snapshot?: CaseSeed[] | null;
  liveCases?: CaseSeed[];
  status?: 'running' | 'succeeded' | 'cancelled';
  claimedAt?: Date;
  finishedAt?: Date;
  timeoutMs?: number;
}) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const businessId = `eval-snap-${suffix}`;
  const roleId = newId('role');
  await db.insert(schema.authUsers).values({
    id: `auth_snap_${suffix}`,
    name: 'eval-snapshot',
    email: `eval-snap-${suffix}@example.test`,
    businessId,
  });
  await db.insert(schema.roles).values({ id: roleId, name: `eval-snap-${suffix}` });
  await db.insert(schema.userRoles).values({ businessId, roleId });
  await db.insert(schema.rolePermissions).values([
    { roleId, permissionId: 'agents.use', scope: 'owned_agents' },
    { roleId, permissionId: 'eval.execute', scope: 'owned_agents' },
    { roleId, permissionId: 'eval.read', scope: 'owned_agents' },
  ]);

  const agentId = newId('agent');
  await db.insert(schema.agents).values({
    id: agentId,
    slug: `eval-snap-${suffix}`,
    name: 'eval-snapshot',
    model: 'test',
    timeoutMs: options.timeoutMs ?? 5_000,
    createdBy: businessId,
    ownerBusinessId: businessId,
  });

  const snapshot =
    options.snapshot === undefined
      ? toSnapshot(options.liveCases ?? [])
      : options.snapshot === null
        ? null
        : toSnapshot(options.snapshot);
  const liveRows =
    options.liveCases !== undefined ? toSnapshot(options.liveCases) : (snapshot ?? []);
  if (liveRows.length > 0) {
    await db
      .insert(schema.evalCases)
      .values(liveRows.map((testCase) => ({ ...testCase, agentId, createdBy: businessId })));
  }

  const evalRunId = newId('evalRun');
  await db.insert(schema.evalRuns).values({
    id: evalRunId,
    agentId,
    status: options.status ?? 'running',
    total: snapshot ? snapshot.length : liveRows.length,
    caseSnapshot: snapshot,
    ...(options.claimedAt === undefined ? {} : { claimedAt: options.claimedAt }),
    ...(options.finishedAt === undefined ? {} : { finishedAt: options.finishedAt }),
    createdBy: businessId,
  });

  return { agentId, businessId, roleId, evalRunId, snapshot, liveRows };
}

async function completeRun(
  data: RunJobPayload,
  text: string,
  extraMessages: Array<{ role: 'tool'; content: unknown }> = [],
) {
  await db
    .update(schema.agentRuns)
    .set({ status: 'succeeded', startedAt: new Date(), endedAt: new Date() })
    .where(eq(schema.agentRuns.id, data.runId));
  await db.insert(schema.messages).values([
    {
      id: newId('message'),
      conversationId: data.conversationId,
      role: 'assistant',
      content: { type: 'text', text },
      runId: data.runId,
    },
    ...extraMessages.map((msg) => ({
      id: newId('message'),
      conversationId: data.conversationId,
      role: msg.role,
      content: msg.content,
      runId: data.runId,
    })),
  ]);
}

async function withTrigger(
  table: string,
  timing: string,
  bodySql: string,
  run: () => Promise<void>,
): Promise<void> {
  const fnName = `eval_snap_trig_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await dbHandle.client.unsafe(`
    create or replace function ${fnName}() returns trigger language plpgsql as $fn$
    begin
      ${bodySql}
      return new;
    end;
    $fn$
  `);
  await dbHandle.client.unsafe(`
    create trigger ${fnName}
    ${timing} on ${table}
    for each row execute function ${fnName}()
  `);
  try {
    await run();
  } finally {
    await dbHandle.client.unsafe(`drop trigger if exists ${fnName} on ${table}`);
    await dbHandle.client.unsafe(`drop function if exists ${fnName}()`);
  }
}

async function persistedResults(evalRunId: string) {
  return db
    .select()
    .from(schema.evalResults)
    .where(eq(schema.evalResults.evalRunId, evalRunId))
    .orderBy(asc(schema.evalResults.createdAt), asc(schema.evalResults.id));
}

async function childRuns(evalRunId: string) {
  return db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.evalRunId, evalRunId))
    .orderBy(asc(schema.agentRuns.createdAt), asc(schema.agentRuns.id));
}

describe.skipIf(isolated === null)('executeEvalRun case snapshot against real Postgres', () => {
  beforeEach(() => {
    logs.length = 0;
    mocks.queueAdd.mockReset();
    mocks.waitUntilReady.mockReset().mockResolvedValue(undefined);
    mocks.waitUntilFinished.mockReset().mockResolvedValue(undefined);
    mocks.queueAdd.mockImplementation(async (_name, data: RunJobPayload) => {
      await completeRun(data, `answer ${data.prompt.replace('prompt-', '')}-ok`);
      return { waitUntilFinished: mocks.waitUntilFinished };
    });
  });

  afterAll(async () => {
    await dbHandle.client.close();
    await isolated?.close();
  });

  it('runs and judges snapshot cases without reading the live case table', async () => {
    const sharedIdA = newId('evalCase');
    const sharedIdB = newId('evalCase');
    const { businessId, evalRunId, snapshot } = await seed({
      liveCases: [
        { id: sharedIdA, name: 'alpha-live', prompt: 'live-changed-a', expectation: 'never-a' },
        { id: sharedIdB, name: 'beta-live', prompt: 'live-changed-b', expectation: 'never-b' },
      ],
      snapshot: [
        { id: sharedIdA, name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
        { id: sharedIdB, name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
      ],
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd.mock.calls.map((call) => call[1].prompt)).toEqual([
      'prompt-alpha',
      'prompt-beta',
    ]);
    expect(mocks.waitUntilFinished).toHaveBeenCalledWith(expect.anything(), 5_000);

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'succeeded', passed: 2, error: null });

    const rows = await persistedResults(evalRunId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      evalRunId,
      caseId: sharedIdA,
      passed: true,
      caseSnapshot: snapshot?.[0],
    });
    expect(rows[1]).toMatchObject({
      evalRunId,
      caseId: sharedIdB,
      passed: true,
      caseSnapshot: snapshot?.[1],
    });

    const runs = await childRuns(evalRunId);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.subjectKind).toBe('user');
      expect(run.initiatedBy).toBe(businessId);
      expect(run.serviceId).toBeNull();
    }
  });

  it('fails a text-passing case when the trajectory used a forbidden tool', async () => {
    const { evalRunId, snapshot } = await seed({
      snapshot: [
        {
          name: 'alpha',
          prompt: 'prompt-alpha',
          expectation: 'alpha-ok',
          expectedTools: ['Read'],
          forbiddenTools: ['Bash'],
        },
      ],
    });
    mocks.queueAdd.mockImplementationOnce(async (_name, data: RunJobPayload) => {
      await completeRun(data, 'answer alpha-ok', [
        { role: 'tool', content: { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} } },
        { role: 'tool', content: { type: 'tool_result', toolUseId: 'tool-1', name: 'Read' } },
        { role: 'tool', content: { type: 'tool_use', id: 'tool-2', name: 'Bash', input: {} } },
      ]);
      return { waitUntilFinished: mocks.waitUntilFinished };
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'failed', passed: 0, error: null });
    const rows = await persistedResults(evalRunId);
    expect(rows[0]).toMatchObject({
      caseId: snapshot?.[0]?.id,
      passed: false,
      output: 'answer alpha-ok',
      judgeReason: '出现禁止工具: Bash',
      caseSnapshot: snapshot?.[0],
    });
  });

  it('records a snapshot case whose live row was deleted, without a live fetch', async () => {
    const { agentId, evalRunId, snapshot } = await seed({
      snapshot: [{ name: 'gone', prompt: 'prompt-gone', expectation: 'gone-ok' }],
      liveCases: [{ name: 'gone', prompt: 'prompt-gone', expectation: 'gone-ok' }],
    });
    await db.delete(schema.evalCases).where(eq(schema.evalCases.agentId, agentId));

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'succeeded', passed: 1, error: null });
    expect(detail?.results[0]).toMatchObject({
      caseId: null,
      name: 'gone',
      prompt: 'prompt-gone',
      expectation: 'gone-ok',
      passed: true,
    });
    const rows = await persistedResults(evalRunId);
    expect(rows[0]).toMatchObject({
      caseId: null,
      caseSnapshot: snapshot?.[0],
      passed: true,
    });
  });

  it('treats an empty snapshot as zero cases instead of re-reading them', async () => {
    const { evalRunId } = await seed({
      liveCases: [{ name: 'live', prompt: 'prompt-live', expectation: 'live-ok' }],
      snapshot: [],
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(await persistedResults(evalRunId)).toHaveLength(0);
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'succeeded',
      passed: 0,
      error: null,
    });
  });

  it('stops after the already-running case when cancelled between cases', async () => {
    const { evalRunId } = await seed({
      snapshot: [
        { name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
        { name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
      ],
    });

    await withTrigger(
      'eval_results',
      'after insert',
      `if new.eval_run_id = '${evalRunId}' then
         update eval_runs set status = 'cancelled', finished_at = now() where id = new.eval_run_id;
       end if;`,
      async () => {
        await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });
      },
    );

    expect(mocks.queueAdd).toHaveBeenCalledTimes(1);
    const detail = await repo.evalRepo.getRunDetail(db, evalRunId);
    expect(detail?.evalRun).toMatchObject({ status: 'cancelled', passed: 1 });
    expect(detail?.results).toHaveLength(1);
    expect(detail?.results[0]).toMatchObject({ name: 'alpha', passed: true });
  });

  it('discards the output of a case cancelled in flight', async () => {
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });
    mocks.waitUntilFinished.mockImplementationOnce(async () => {
      await db
        .update(schema.evalRuns)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(eq(schema.evalRuns.id, evalRunId));
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(await persistedResults(evalRunId)).toHaveLength(0);
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'cancelled',
      passed: 0,
      error: null,
    });
  });

  it('falls back to listAllCases only when the run has no snapshot', async () => {
    const { evalRunId, liveRows } = await seed({
      liveCases: [{ name: 'live', prompt: 'prompt-live', expectation: 'live-ok' }],
      snapshot: null,
    });
    await seed({
      liveCases: [{ name: 'other', prompt: 'prompt-other', expectation: 'other-ok' }],
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd.mock.calls.map((call) => call[1].prompt)).toEqual(['prompt-live']);
    const rows = await persistedResults(evalRunId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: liveRows[0]?.id,
      passed: true,
      caseSnapshot: liveRows[0],
    });
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'succeeded',
      passed: 1,
      error: null,
    });
  });

  it('records a judged-failure case and continues with the next case', async () => {
    const { evalRunId, snapshot } = await seed({
      snapshot: [
        { name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
        { name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
      ],
    });
    mocks.queueAdd
      .mockImplementationOnce(async (_name, data: RunJobPayload) => {
        await completeRun(data, 'wrong answer');
        return { waitUntilFinished: mocks.waitUntilFinished };
      })
      .mockImplementationOnce(async (_name, data: RunJobPayload) => {
        await completeRun(data, 'answer beta-ok');
        return { waitUntilFinished: mocks.waitUntilFinished };
      });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    const runs = await childRuns(evalRunId);
    const rows = await persistedResults(evalRunId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      caseId: snapshot?.[0]?.id,
      runId: runs[0]?.id,
      passed: false,
      output: 'wrong answer',
    });
    expect(rows[1]).toMatchObject({
      caseId: snapshot?.[1]?.id,
      runId: runs[1]?.id,
      passed: true,
    });
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'failed',
      passed: 1,
      error: null,
    });
  });

  it.each(['failed', 'cancelled', 'timeout'] as const)(
    'records the child run id when the run ends in %s',
    async (status) => {
      const { evalRunId, snapshot } = await seed({
        snapshot: [
          { name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
          { name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
        ],
      });
      mocks.queueAdd
        .mockImplementationOnce(async (_name, data: RunJobPayload) => {
          await db
            .update(schema.agentRuns)
            .set({ status, error: 'boom', endedAt: new Date() })
            .where(eq(schema.agentRuns.id, data.runId));
          return { waitUntilFinished: mocks.waitUntilFinished };
        })
        .mockImplementationOnce(async (_name, data: RunJobPayload) => {
          await completeRun(data, 'answer beta-ok');
          return { waitUntilFinished: mocks.waitUntilFinished };
        });

      await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

      const runs = await childRuns(evalRunId);
      const rows = await persistedResults(evalRunId);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        caseId: snapshot?.[0]?.id,
        runId: runs[0]?.id,
        passed: false,
        output: `run ended with ${status}: boom`,
      });
      expect(rows[1]).toMatchObject({
        caseId: snapshot?.[1]?.id,
        runId: runs[1]?.id,
        passed: true,
      });
      expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
        status: 'failed',
        passed: 1,
        error: null,
      });
    },
  );

  it('records the child run id when waiting for the queue fails', async () => {
    const { evalRunId, snapshot } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });
    mocks.queueAdd.mockImplementationOnce(async (_name, data: RunJobPayload) => {
      await db
        .update(schema.agentRuns)
        .set({ status: 'running', startedAt: new Date() })
        .where(eq(schema.agentRuns.id, data.runId));
      return { waitUntilFinished: mocks.waitUntilFinished };
    });
    mocks.waitUntilFinished.mockRejectedValueOnce(new Error('queue wait failed'));

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    const runs = await childRuns(evalRunId);
    const rows = await persistedResults(evalRunId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: snapshot?.[0]?.id,
      runId: runs[0]?.id,
      passed: false,
      output: 'queue wait failed',
    });
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'failed',
      passed: 0,
      error: null,
    });
  });

  it('keeps the run id null when the child run was never created', async () => {
    const { evalRunId, snapshot } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });

    await withTrigger(
      'agent_runs',
      'before insert',
      `if new.eval_run_id = '${evalRunId}' then
         raise exception 'forced agent_runs failure';
       end if;`,
      async () => {
        await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });
      },
    );

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(await childRuns(evalRunId)).toHaveLength(0);
    const rows = await persistedResults(evalRunId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      caseId: snapshot?.[0]?.id,
      runId: null,
      passed: false,
      output: EVAL_FAILURE_PUBLIC_MESSAGE,
    });
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'failed',
      passed: 0,
      error: null,
    });
  });

  it('fails the batch without counting a pass when the result write fails', async () => {
    const { evalRunId } = await seed({
      snapshot: [
        { name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' },
        { name: 'beta', prompt: 'prompt-beta', expectation: 'beta-ok' },
        { name: 'gamma', prompt: 'prompt-gamma', expectation: 'gamma-ok' },
      ],
    });

    await withTrigger(
      'eval_results',
      'before insert',
      `if new.eval_run_id = '${evalRunId}' and new.case_snapshot->>'name' = 'beta' then
         raise exception 'result write failed';
       end if;`,
      async () => {
        await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });
      },
    );

    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
    expect(await persistedResults(evalRunId)).toHaveLength(1);
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'failed',
      passed: 1,
      error: EVAL_FAILURE_PUBLIC_MESSAGE,
    });
  });

  it('skips a duplicate delivery of an already finished batch', async () => {
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
      status: 'cancelled',
      claimedAt: new Date(),
      finishedAt: new Date(),
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(await persistedResults(evalRunId)).toHaveLength(0);
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun.status).toBe('cancelled');
  });

  it('skips a redelivery of an already claimed batch so it is not rerun', async () => {
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
      status: 'running',
      claimedAt: new Date(),
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(await persistedResults(evalRunId)).toHaveLength(0);
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'running',
      finishedAt: null,
    });
  });

  it('does not touch a batch that was already terminal when the job arrived', async () => {
    const finishedAt = new Date('2026-01-01T00:00:00.000Z');
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
      status: 'succeeded',
      finishedAt,
    });

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    const evalRun = (await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun;
    expect(evalRun?.status).toBe('succeeded');
    expect(evalRun?.claimedAt).toBeNull();
    expect(evalRun?.finishedAt?.toISOString()).toBe(finishedAt.toISOString());
  });

  it('propagates a final finish failure instead of logging it away', async () => {
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });

    await withTrigger(
      'eval_runs',
      'before update',
      `if new.id = '${evalRunId}' and new.status = 'succeeded' then
         raise exception 'finish failed';
       end if;`,
      async () => {
        await expect(
          executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId }),
        ).rejects.toThrow('Failed query');
      },
    );
  });

  it('settles the batch through the production handler before rethrowing', async () => {
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });

    await withTrigger(
      'eval_runs',
      'before update',
      `if new.id = '${evalRunId}' and new.status = 'succeeded' then
         raise exception 'finish failed';
       end if;`,
      async () => {
        await expect(
          runEvalJob({ db, logger, redisUrl: 'redis://unused', job: { data: { evalRunId } } }),
        ).rejects.toThrow('Failed query');
      },
    );

    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'failed',
      passed: 1,
      error: EVAL_FAILURE_PUBLIC_MESSAGE,
    });
  });

  it('settles a batch from the failed event when the processor never ran', async () => {
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });

    await handleEvalJobFailed({
      db,
      logger,
      job: { data: { evalRunId } },
      error: new UnrecoverableError('job stalled more than allowable limit'),
    });

    const evalRun = (await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun;
    expect(evalRun).toMatchObject({
      status: 'failed',
      error: 'job stalled more than allowable limit',
    });
    expect(evalRun?.finishedAt).not.toBeNull();
  });

  it('ignores a failed event whose payload cannot name a batch', async () => {
    const { evalRunId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });

    await handleEvalJobFailed({ db, logger, job: { data: {} }, error: new Error('boom') });

    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'running',
      finishedAt: null,
    });
  });

  it('fails the batch without running cases when the executor lost access', async () => {
    const { evalRunId, roleId } = await seed({
      snapshot: [{ name: 'alpha', prompt: 'prompt-alpha', expectation: 'alpha-ok' }],
    });
    await db.delete(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));

    await executeEvalRun({ db, logger, redisUrl: 'redis://unused', evalRunId });

    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(await childRuns(evalRunId)).toHaveLength(0);
    expect((await repo.evalRepo.getRunDetail(db, evalRunId))?.evalRun).toMatchObject({
      status: 'failed',
      passed: 0,
      error: '当前账户没有该操作的专家权限，运行未启动',
    });
    const [audit] = await db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.target, evalRunId), eq(schema.auditLog.action, 'eval.denied')))
      .limit(1);
    expect(audit).toMatchObject({
      actor: 'worker',
      actorKind: 'service',
      action: 'eval.denied',
      target: evalRunId,
      status: 'denied',
    });
  });
});
