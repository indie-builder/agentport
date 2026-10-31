import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { createDb, newId, repo, schema } from '@agentport/db';
import { RUNS_QUEUE } from '@agentport/shared';
import { Queue, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type IsolatedRedis, startRedisContainer, stopRedisContainer } from './global-setup.js';
import { createIsolatedDatabase } from './isolated-db.js';

const { closeEvalRunQueue } = await import('../src/eval-runner.js');
const { handleEvalJobFailed, runEvalJob } = await import('../src/eval-job.js');
const { EVAL_LOST_ERROR, reconcileOrphanedEvalRuns } = await import('../src/reconcile.js');

type Child = ChildProcess & { stderr: NonNullable<ChildProcess['stderr']> };
type CaseInput = { name: string; prompt: string; expectation: string };

/**
 * 真实进程退出 / BullMQ 重投 / 失败收口：
 * - 每次运行独享 Redis 容器与独立 PG，避免同轮其它套件消费共享 agent-runs。
 * - 子进程只装配生产 handler（runEvalJob），只替换模型边界。
 * - 覆盖：SIGKILL 后 stalled 重投、超出 maxStalledCount 的 deferred failure、
 *   failEvalRun 自身 SQL 失败后由 1 小时 reconcile 释放 running 唯一占用。
 */

const isolated = await createIsolatedDatabase('worker_eval_redelivery');
const redisContainer: IsolatedRedis | null = await startRedisContainer();
const ready = isolated !== null && redisContainer !== null;
if (!ready) {
  await Promise.allSettled([
    isolated?.close() ?? Promise.resolve(),
    stopRedisContainer(redisContainer),
  ]);
}

const redisUrl = redisContainer?.url ?? '';
const logs: string[] = [];
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: (...args: unknown[]) => {
    logs.push(inspect(args, { depth: 6 }));
  },
  debug: () => undefined,
} as unknown as Logger;

describe.skipIf(!ready)('eval failure lifecycle on a live queue', () => {
  const dbHandle = createDb(isolated?.url ?? '');
  const { db } = dbHandle;
  let child: Child | null = null;
  let closers: Array<() => Promise<void>> = [];

  async function flushExclusiveRedis(): Promise<void> {
    const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    try {
      await redis.flushdb();
    } finally {
      await redis.quit();
    }
  }

  beforeEach(async () => {
    logs.length = 0;
    await flushExclusiveRedis();
  });

  afterEach(async () => {
    child?.kill('SIGKILL');
    child = null;
    await Promise.allSettled(closers.map((close) => close()));
    closers = [];
    await closeEvalRunQueue();
    // 独享容器：只清空本轮资源，不影响共享 backendSetup。
    await flushExclusiveRedis();
  });

  afterAll(async () => {
    await dbHandle.pool.end();
    await isolated?.close();
    await stopRedisContainer(redisContainer);
  });

  async function seed(
    cases: CaseInput[],
  ): Promise<{ agentId: string; evalRunId: string; businessId: string }> {
    // 每个用例独立账户：同一隔离库里重复使用 business_id 会撞 auth user 唯一约束。
    const seedBusinessId = `eval-redelivery-${randomUUID().slice(0, 12)}`;
    const authId = `auth_redelivery_${randomUUID().slice(0, 8)}`;
    const roleId = `role_redelivery_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.authUsers).values({
      id: authId,
      name: 'eval-redelivery',
      email: `eval-redelivery-${randomUUID().slice(0, 8)}@example.test`,
      businessId: seedBusinessId,
    });
    await db
      .insert(schema.roles)
      .values({ id: roleId, name: `redelivery-${randomUUID().slice(0, 8)}` });
    await db.insert(schema.userRoles).values({ businessId: seedBusinessId, roleId });
    await db.insert(schema.rolePermissions).values([
      { roleId, permissionId: 'agents.use', scope: 'owned_agents' },
      { roleId, permissionId: 'eval.execute', scope: 'owned_agents' },
      { roleId, permissionId: 'eval.read', scope: 'owned_agents' },
    ]);

    const agentId = newId('agent');
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `eval-redelivery-${randomUUID().slice(0, 8)}`,
      name: 'eval-redelivery',
      model: 'test',
      createdBy: seedBusinessId,
      ownerBusinessId: seedBusinessId,
    });
    const snapshot = cases.map((testCase) => ({
      id: newId('evalCase'),
      ...testCase,
    }));
    await db
      .insert(schema.evalCases)
      .values(snapshot.map((testCase) => ({ ...testCase, agentId, createdBy: seedBusinessId })));
    const evalRunId = newId('evalRun');
    await db.insert(schema.evalRuns).values({
      id: evalRunId,
      agentId,
      status: 'running',
      total: snapshot.length,
      caseSnapshot: snapshot,
      createdBy: seedBusinessId,
    });
    return { agentId, evalRunId, businessId: seedBusinessId };
  }

  async function runState(evalRunId: string) {
    return repo.evalRepo.getRunDetail(db, evalRunId);
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(100);
    }
    throw new Error('condition not met before timeout');
  }

  function startChild(evalRunId: string, queueName: string): Child {
    const fixture = fileURLToPath(new URL('./fixtures/eval-worker-process.ts', import.meta.url));
    const cwd = fileURLToPath(new URL('../', import.meta.url));
    return spawn(process.execPath, ['--import', 'tsx', fixture], {
      cwd,
      env: {
        ...process.env,
        DATABASE_URL: isolated?.url ?? '',
        REDIS_URL: redisUrl,
        EVAL_RUN_ID: evalRunId,
        EVAL_QUEUE_NAME: queueName,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    }) as Child;
  }

  function waitForReady(proc: Child, stderr: () => string) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`eval child not ready: ${stderr()}`)),
        30_000,
      );
      proc.on('message', (message) => {
        if ((message as { type?: string } | null)?.type !== 'ready') return;
        clearTimeout(timer);
        resolve();
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`eval child exited before ready (${code}): ${stderr()}`));
      });
    });
  }

  async function startClaimedChild(queueName: string, evalRunId: string): Promise<void> {
    let stderr = '';
    child = startChild(evalRunId, queueName);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    await waitForReady(child, () => stderr);
    // 第一次投递已经 claim 并完成第一个用例，第二个用例停在模型执行边界。
    const before = await runState(evalRunId);
    expect(before?.evalRun).toMatchObject({ status: 'running', passed: 1 });
    expect(before?.results).toHaveLength(1);
    expect(before?.results[0]?.passed).toBe(true);
    child.kill('SIGKILL');
    await once(child, 'exit');
  }

  async function runIdsFor(agentId: string): Promise<string[]> {
    return (
      await db
        .select({ id: schema.agentRuns.id })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.agentId, agentId))
    )
      .map((run) => run.id)
      .sort();
  }

  it('settles the claimed batch as failed after SIGKILL and stalled redelivery', async () => {
    const { agentId, evalRunId, businessId } = await seed([
      { name: 'first', prompt: 'first', expectation: 'first-ok' },
      { name: 'second', prompt: 'second', expectation: 'second-ok' },
    ]);
    const queueName = `eval-redelivery-${randomUUID()}`;
    const evalQueue = new Queue(queueName, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
    });
    closers.push(() => evalQueue.close());
    await evalQueue.add(
      'eval-run',
      { evalRunId },
      { jobId: evalRunId, removeOnComplete: 100, removeOnFail: 200 },
    );

    await startClaimedChild(queueName, evalRunId);
    const runIdsBefore = await runIdsFor(agentId);

    // 替代消费者：与生产相同的 handler seam，只保留真实 stalled 重投。
    const failed = new Promise<void>((resolve) => {
      const replacement = new Worker(
        queueName,
        (job) => runEvalJob({ db, logger, redisUrl, job }),
        {
          connection: { url: redisUrl, maxRetriesPerRequest: null },
          concurrency: 1,
          lockDuration: 1_000,
          stalledInterval: 500,
        },
      );
      closers.push(() => replacement.close());
      replacement.on('error', () => undefined);
      replacement.on('failed', () => resolve());
    });

    await Promise.all([
      failed,
      waitFor(async () => (await runState(evalRunId))?.evalRun.status === 'failed', 30_000),
    ]);

    const after = await runState(evalRunId);
    expect(after?.evalRun).toMatchObject({ status: 'failed', passed: 1 });
    expect(after?.evalRun.finishedAt).not.toBeNull();
    expect(after?.evalRun.error).toContain('interrupted');
    // 已完成的结果原样保留，未完成用例不合成结果。
    expect(after?.results).toHaveLength(1);
    expect(after?.results[0]).toMatchObject({ passed: true, output: 'first-ok' });

    // 重投没有创建新的 case 子 run。
    expect(await runIdsFor(agentId)).toEqual(runIdsBefore);

    // 批次已失败，同一个 agent 可以再次发起评估。
    const next = await repo.evalRepo.createEvalRun(db, {
      id: newId('evalRun'),
      agentId,
      total: 1,
      createdBy: businessId,
    });
    expect(next.status).toBe('running');
  }, 60_000);

  it('fails a job that exceeds maxStalledCount before the processor runs', async () => {
    const { agentId, evalRunId, businessId } = await seed([
      { name: 'first', prompt: 'first', expectation: 'first-ok' },
      { name: 'second', prompt: 'second', expectation: 'second-ok' },
    ]);
    const queueName = `eval-stalled-${randomUUID()}`;
    const evalQueue = new Queue(queueName, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
    });
    closers.push(() => evalQueue.close());
    await evalQueue.add(
      'eval-run',
      { evalRunId },
      { jobId: evalRunId, removeOnComplete: 100, removeOnFail: 200 },
    );

    await startClaimedChild(queueName, evalRunId);
    const runIdsBefore = await runIdsFor(agentId);

    // maxStalledCount=0 只存在于测试 worker：第一次真实 stalled 扫描就写 deferredFailure，
    // 后续投递在进入 processor 前由 BullMQ 自己失败。
    let processorCalls = 0;
    let failedError: unknown;
    const failed = new Promise<void>((resolve) => {
      const replacement = new Worker(
        queueName,
        (job) => {
          processorCalls += 1;
          return runEvalJob({ db, logger, redisUrl, job });
        },
        {
          connection: { url: redisUrl, maxRetriesPerRequest: null },
          concurrency: 1,
          lockDuration: 1_000,
          stalledInterval: 250,
          maxStalledCount: 0,
        },
      );
      closers.push(() => replacement.close());
      replacement.on('error', () => undefined);
      replacement.on('failed', (job, err) => {
        failedError = err;
        // 与生产 index.ts 相同的 failed 事件兜底；.catch 保证不留 unhandled rejection。
        handleEvalJobFailed({ db, logger, job, error: err })
          .catch(() => undefined)
          .finally(resolve);
      });
    });

    await Promise.all([
      failed,
      waitFor(async () => (await runState(evalRunId))?.evalRun.status === 'failed', 30_000),
    ]);

    expect(processorCalls, 'deferred failure must not call the processor').toBe(0);
    expect((failedError as Error).message).toContain('stalled');
    const after = await runState(evalRunId);
    expect(after?.evalRun).toMatchObject({ status: 'failed', passed: 1 });
    expect(after?.evalRun.finishedAt).not.toBeNull();
    expect(after?.evalRun.error).toBe('job stalled more than allowable limit');
    expect(after?.results).toHaveLength(1);
    expect(after?.results[0]).toMatchObject({ passed: true, output: 'first-ok' });
    expect(await runIdsFor(agentId)).toEqual(runIdsBefore);

    const next = await repo.evalRepo.createEvalRun(db, {
      id: newId('evalRun'),
      agentId,
      total: 1,
      createdBy: businessId,
    });
    expect(next.status).toBe('running');
  }, 60_000);

  it('keeps the running slot until the 1h reconcile releases it when settlement SQL fails', async () => {
    const { agentId, evalRunId, businessId } = await seed([
      { name: 'only', prompt: 'only', expectation: 'only-ok' },
    ]);
    // 模型边界：只替换子 run 的执行结果，不替换 eval 的 claim/finish/fail。
    const runWorker = new Worker(
      RUNS_QUEUE,
      async (job) => {
        await db
          .update(schema.agentRuns)
          .set({ status: 'succeeded', startedAt: new Date(), endedAt: new Date() })
          .where(eq(schema.agentRuns.id, job.data.runId));
        await db.insert(schema.messages).values({
          id: newId('message'),
          conversationId: job.data.conversationId,
          role: 'assistant',
          content: { type: 'text', text: 'only-ok' },
          runId: job.data.runId,
        });
      },
      { connection: { url: redisUrl, maxRetriesPerRequest: null } },
    );
    closers.push(() => runWorker.close());

    const finishSecret = `sk-live-eval-finish-${randomUUID()}`;
    const settleSecret = `sk-live-eval-settle-${randomUUID()}`;
    const functionName = `eval_settle_fault_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await dbHandle.pool.query(`
      create or replace function ${functionName}() returns trigger language plpgsql as $fn$
      begin
        if new.id = '${evalRunId}' then
          if new.status = 'succeeded' then
            raise exception 'forced finish failure %', '${finishSecret}';
          elsif new.status = 'failed' then
            raise exception 'forced settlement failure %', '${settleSecret}';
          end if;
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

    const queueName = `eval-settle-${randomUUID()}`;
    const evalQueue = new Queue(queueName, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
    });
    closers.push(() => evalQueue.close());
    await evalQueue.add(
      'eval-run',
      { evalRunId },
      { jobId: evalRunId, removeOnComplete: 100, removeOnFail: 200 },
    );

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const settleErrors: unknown[] = [];
    let failedError: unknown;
    try {
      const failed = new Promise<void>((resolve) => {
        const evalWorker = new Worker(
          queueName,
          (job) => runEvalJob({ db, logger, redisUrl, job }),
          { connection: { url: redisUrl, maxRetriesPerRequest: null }, concurrency: 1 },
        );
        closers.push(() => evalWorker.close());
        evalWorker.on('error', () => undefined);
        evalWorker.on('failed', (job, err) => {
          failedError = err;
          handleEvalJobFailed({ db, logger, job, error: err })
            .catch((settlementError: unknown) => settleErrors.push(settlementError))
            .finally(resolve);
        });
      });
      await failed;
      // 让 failed 回调里的 rejection 有机会进入 unhandledRejection。
      await delay(200);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await dbHandle.pool.query(`drop trigger if exists ${functionName} on eval_runs`);
      await dbHandle.pool.query(`drop function if exists ${functionName}()`);
    }

    expect(unhandled).toEqual([]);
    // processor 仍抛原始 DB 错误，不被固定公开文案或收口错误替换；secret 在 cause 链里。
    expect((failedError as Error).message).toContain('Failed query');
    expect(inspect(failedError, { depth: 8 })).toContain(finishSecret);
    // failed 事件再次收口也撞上同一触发器：settleFailure 自己吞掉并只记受控日志。
    expect(settleErrors).toEqual([]);
    expect(logs.join('\n')).toContain('eval run failure settlement failed');
    expect(logs.join('\n')).not.toContain(finishSecret);
    expect(logs.join('\n')).not.toContain(settleSecret);
    expect(logs.join('\n')).not.toMatch(/Failed query|params:/);

    const stuck = await runState(evalRunId);
    expect(stuck?.evalRun).toMatchObject({ status: 'running', passed: 1 });
    expect(stuck?.evalRun.finishedAt).toBeNull();
    expect(stuck?.results).toHaveLength(1);

    // 原 1 小时 queue-probe 对账：不降阈值，只用测试数据把行放到阈值之前。
    await db
      .update(schema.evalRuns)
      .set({ createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
      .where(eq(schema.evalRuns.id, evalRunId));
    expect(await reconcileOrphanedEvalRuns(db, logger, evalQueue)).toBe(1);

    const released = await runState(evalRunId);
    expect(released?.evalRun).toMatchObject({
      status: 'failed',
      passed: 1,
      error: EVAL_LOST_ERROR,
    });
    expect(released?.evalRun.finishedAt).not.toBeNull();
    expect(released?.results).toHaveLength(1);

    const next = await repo.evalRepo.createEvalRun(db, {
      id: newId('evalRun'),
      agentId,
      total: 1,
      createdBy: businessId,
    });
    expect(next.status).toBe('running');
  }, 60_000);
});
