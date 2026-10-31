import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
}));

const { executeEvalRun } = await import('../src/eval-runner.js');

const isolated = await createIsolatedDatabase('worker_eval_write');
const dbHandle = createDb(isolated?.url ?? '');
const { db } = dbHandle;

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

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

describe.skipIf(isolated === null)('eval result persistence against a real database', () => {
  beforeAll(async () => {
    // 定向故障：只有 name=fault 的结果插入失败，其他用例仍走真实 repo 事务。
    await dbHandle.pool.query(`
      create or replace function eval_result_write_fault() returns trigger language plpgsql as $fn$
      begin
        if new.case_snapshot->>'name' = 'fault' then
          raise exception 'forced eval result write failure';
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
    expect(detail?.evalRun.error).toContain('eval_results');
    expect(detail?.results).toHaveLength(1);
    expect(detail?.results[0]).toMatchObject({ name: 'ok', passed: true });
    // 写失败后不再执行第三条。
    expect(mocks.queueAdd).toHaveBeenCalledTimes(2);
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
});
