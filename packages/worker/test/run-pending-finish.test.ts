import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createDb, newId, repo, schema } from '@agentport/db';
import { type AgentRunJob, RUNS_QUEUE, runCancelKey, runStreamKey } from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestAccount,
  expectProblem,
  inject,
  loginCookie,
  startApp,
} from '../../api/test/helpers.js';
import { agentOwnership, TEST_BUSINESS_ID, userSubject } from './fixtures/access.js';

interface SupervisorChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
}

/** cleanup 的形状由 SessionSandboxes 决定：缺这个方法时本文件无法通过编译。 */
interface SessionManager {
  cleanup(conversationId: string, sandboxId: string, expectedRunId: string): Promise<void>;
  close(): Promise<void>;
}

const mocks = vi.hoisted(() => ({
  publishRun: vi.fn(async () => undefined),
  processors: new Map<string, (job: unknown) => Promise<void>>(),
  dbHandles: [] as Array<{ pool: { end(): Promise<void> } }>,
  managers: [] as SessionManager[],
  destroyFailures: 0,
  destroyed: [] as string[],
  child: null as SupervisorChild | null,
  onStarted: null as (() => void) | null,
  startedRuns: [] as string[],
  cancelFrames: 0,
}));

vi.mock('@agentport/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/db')>();
  return {
    ...actual,
    createDb: (...args: Parameters<typeof actual.createDb>) => {
      const handle = actual.createDb(...args);
      mocks.dbHandles.push(handle);
      return handle;
    },
  };
});

vi.mock('../src/run-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run-access.js')>();
  return { ...actual, checkUserAgentAccess: async () => null };
});

// 进程级守卫会把测试里任何未处理异常变成 process.exit；这里只验证 run 流程。
vi.mock('@agentport/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/core')>();
  return { ...actual, installProcessGuards: () => undefined };
});

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  class Worker {
    constructor(name: string, processor: (job: unknown) => Promise<void>) {
      mocks.processors.set(name, processor);
    }
    on(): this {
      return this;
    }
    async close(): Promise<void> {}
  }
  return { ...actual, Worker };
});

// provider 是外部边界：用 fake 容器注入 destroy 失败与取消无 ACK；SessionSandboxes 保持真实。
vi.mock('../src/sandbox/docker.js', () => ({
  DockerSandboxProvider: class {
    async ensureImage(): Promise<void> {}
    async destroyAll(): Promise<void> {}
    async create(options: { name?: string }) {
      const child = new (class extends EventEmitter {
        readonly stdin = new PassThrough();
        readonly stdout = new PassThrough();
        readonly stderr = new PassThrough();
      })();
      mocks.child = child;
      let buffer = '';
      child.stdin.on('data', (chunk: Buffer) => {
        buffer += String(chunk);
        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const frame = JSON.parse(line) as { type: string; runId?: string };
          if (frame.type === 'start' && frame.runId !== undefined) {
            mocks.startedRuns.push(frame.runId);
            child.stdout.write(`${JSON.stringify({ type: 'started', runId: frame.runId })}\n`);
            // 先交付一轮完整消息与读数，再等取消：终态尚未交接。
            setTimeout(() => {
              child.stdout.write(
                `${JSON.stringify({
                  type: 'event',
                  runId: frame.runId,
                  event: {
                    type: 'assistant_text',
                    text: 'pending reply',
                    blockIndex: 0,
                    sdkUuid: 'msg-pending',
                  },
                })}\n`,
              );
              child.stdout.write(
                `${JSON.stringify({
                  type: 'event',
                  runId: frame.runId,
                  event: {
                    type: 'run_finished',
                    status: 'cancelled',
                    costUsd: 0.25,
                    turns: 2,
                    sessionId: 'sdk-pending',
                    inputTokens: 5,
                    outputTokens: 7,
                  },
                })}\n`,
              );
              mocks.onStarted?.();
            }, 10);
          }
          if (frame.type === 'cancel') mocks.cancelFrames += 1;
          newline = buffer.indexOf('\n');
        }
      });
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`), 0);
      return { id: options.name ?? 'fake-sandbox', child };
    }
    async destroy(sandbox: { id: string }): Promise<void> {
      mocks.destroyed.push(sandbox.id);
      if (mocks.destroyFailures > 0) {
        mocks.destroyFailures -= 1;
        throw new Error('docker rm -f failed');
      }
    }
    async destroyById(id: string): Promise<void> {
      mocks.destroyed.push(id);
      if (mocks.destroyFailures > 0) {
        mocks.destroyFailures -= 1;
        throw new Error('docker rm -f failed');
      }
    }
  },
  resolveLocalImageId: async () => `sha256:${'a'.repeat(64)}`,
}));

// 记录 index 创建的 manager，reconcile 通过真实的 SessionSandboxes.cleanup 收口。
vi.mock('../src/sandbox/sessions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/sessions.js')>();
  class RecordingSessionSandboxes extends actual.SessionSandboxes {
    constructor(options: ConstructorParameters<typeof actual.SessionSandboxes>[0]) {
      super(options);
      mocks.managers.push(this);
    }
  }
  return { ...actual, SessionSandboxes: RecordingSessionSandboxes };
});

vi.mock('../src/runtime-environments/resolve.js', () => ({
  createRuntimeEnvironmentResolver: () => async () => ({
    environmentId: 'rte_pending',
    environmentName: 'pending environment',
    versionId: 'rtv_pending',
    imageId: `sha256:${'b'.repeat(64)}`,
  }),
}));

vi.mock('../src/runtime-environments/default.js', () => ({
  ensureDefaultEnvironment: async () => undefined,
  startDefaultEnvironmentRetry: () => async () => undefined,
}));

vi.mock('../src/runtime-environments/build.js', () => ({
  startRuntimeEnvironmentBuildWorker: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/runtime-environments/reconcile.js', () => ({
  startRuntimeEnvironmentBuildReconciler: () => () => undefined,
}));

// index 不自己起后台 reconiler；下面的用例手动跑同一实现。
vi.mock('../src/reconcile.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reconcile.js')>();
  return { ...actual, startReconciler: () => () => undefined };
});

vi.mock('../src/knowledge/queue.js', () => ({
  startKnowledgeWorker: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/knowledge/reconcile.js', () => ({
  startKnowledgeReconciler: () => () => undefined,
}));

vi.mock('../src/knowledge/scheduler.js', () => ({
  startKnowledgeScheduler: () => ({ sync: async () => undefined, close: async () => undefined }),
}));

vi.mock('../src/scheduler.js', () => ({
  startScheduleScheduler: () => ({ sync: async () => undefined, close: async () => undefined }),
}));

vi.mock('../src/maintenance.js', () => ({
  startMaintenanceWorker: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/sandbox-probe.js', () => ({
  registerSandboxProbe: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/native-plugins.js', () => ({
  registerNativePlugins: async () => ({ close: async () => undefined }),
}));

vi.mock('../src/eval-runner.js', () => ({
  executeEvalRun: async () => undefined,
  closeEvalRunQueue: async () => undefined,
}));

vi.mock('../src/model-proxy.js', () => ({
  startModelProxy: async () => null,
}));

const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
const { reconcileOrphanedRuns } = await import('../src/reconcile.js');

const redisUrl = process.env.REDIS_URL ?? '';
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => logger,
} as unknown as Logger;

const cleanupIds: { agents: string[]; conversations: string[]; runs: string[] } = {
  agents: [],
  conversations: [],
  runs: [],
};

// 与 worker 共用同一轮隔离库；数据全部按本次生成的 id 创建并在 afterAll 回收。
let app: FastifyInstance;
let cookie = '';

const putMemory = (agentId: string, content = 'note') =>
  inject(app, {
    method: 'PUT',
    url: `/api/agents/${agentId}/memory/MEMORY.md`,
    headers: { cookie },
    payload: { content },
  });

const patchAgent = (agentId: string, payload: Record<string, unknown>) =>
  inject(app, {
    method: 'PATCH',
    url: `/api/agents/${agentId}`,
    headers: { cookie },
    payload,
  });

async function createFixture(label: string) {
  const agentId = newId('agent');
  const childId = newId('agent');
  const conversationId = newId('conversation');
  const runId = newId('run');
  cleanupIds.agents.push(agentId, childId);
  cleanupIds.conversations.push(conversationId);
  cleanupIds.runs.push(runId);
  await db.insert(schema.agents).values([
    {
      id: agentId,
      slug: `pending-${agentId.slice(4)}`,
      name: label,
      model: 'test',
      ...agentOwnership,
    },
    {
      id: childId,
      slug: `pending-child-${childId.slice(4)}`,
      name: `${label} child`,
      model: 'test',
      ...agentOwnership,
    },
  ]);
  // 运行占用 = 发起专家 + enabled 直接子级；用真实 API 建立这条关系。
  const bound = await patchAgent(agentId, { subAgentIds: [childId] });
  expect(bound.statusCode, bound.body).toBe(200);
  await repo.chat.createConversation(db, {
    id: conversationId,
    agentId,
    title: label,
    subject: userSubject,
  });
  await repo.chat.createRun(db, { id: runId, conversationId, agentId, subject: userSubject });
  await repo.chat.appendMessage(db, {
    id: newId('message'),
    conversationId,
    role: 'user',
    content: { type: 'text', text: 'ask' },
    runId,
    senderBusinessId: TEST_BUSINESS_ID,
  });
  return {
    runId,
    agentId,
    childId,
    job: {
      data: { runId, agentId, conversationId, prompt: 'ask' },
      attemptsMade: 0,
      opts: { attempts: 3 },
    },
  };
}

async function requestCancel(runId: string): Promise<void> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    await redis.set(runCancelKey(runId), '1', 'EX', 60);
    await redis.publish(runCancelKey(runId), '1');
  } finally {
    redis.disconnect();
  }
}

async function readStream(runId: string): Promise<Array<{ type?: string }>> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    const entries = (await redis.xrange(runStreamKey(runId), '-', '+')) as Array<
      [string, string[]]
    >;
    return entries.map(([, fields]) => JSON.parse(fields[1] ?? '{}'));
  } finally {
    redis.disconnect();
  }
}

async function runRow(runId: string) {
  const [row] = await db
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.id, runId))
    .limit(1);
  return row;
}

describe('unconfirmed stop handoff', () => {
  let workdir = '';

  beforeAll(async () => {
    // macOS 的 tmpdir 是符号链接；记忆目录会逐层拒绝符号链接路径。
    workdir = await mkdtemp(join(await realpath(tmpdir()), 'worker-pending-finish-'));
    process.env.WORKSPACES_DIR = workdir;
    process.env.HOST_WORKSPACES_DIR = workdir;
    const sigterm = new Set(process.listeners('SIGTERM'));
    const sigint = new Set(process.listeners('SIGINT'));
    await import('../src/index.js');
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigterm.has(listener)) process.off('SIGTERM', listener);
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!sigint.has(listener)) process.off('SIGINT', listener);
    }
    app = await startApp({ WORKSPACES_DIR: workdir });
    cookie = await loginCookie(app);
    // 排队 run 启动前按 DB 复核账户与 agents.use；用真实账户 API 建立测试主体。
    await createTestAccount(app, cookie, {
      businessId: TEST_BUSINESS_ID,
      systemKeys: ['user'],
    });
  });

  afterAll(async () => {
    for (const manager of mocks.managers) {
      mocks.destroyFailures = 0;
      await manager.close().catch(() => undefined);
    }
    for (const id of cleanupIds.runs) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.target, id));
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, id));
    }
    for (const id of cleanupIds.conversations) {
      await db.delete(schema.conversations).where(eq(schema.conversations.id, id));
    }
    for (const id of cleanupIds.agents) {
      await db.delete(schema.auditLog).where(eq(schema.auditLog.target, id));
      await db.delete(schema.agents).where(eq(schema.agents.id, id));
    }
    await db.delete(schema.userRoles).where(eq(schema.userRoles.businessId, TEST_BUSINESS_ID));
    await db.delete(schema.authUsers).where(eq(schema.authUsers.businessId, TEST_BUSINESS_ID));
    if (app) await app.close();
    await rm(workdir, { recursive: true, force: true });
    // app.close 与 helper 的临时探测也会结束各自 pool；这里只兜底收尾剩余连接。
    for (const handle of mocks.dbHandles) await handle.pool.end().catch(() => undefined);
  });

  it('keeps the run and its memory occupancy until reconcile confirms cleanup', async () => {
    // processor 的 release 失败一次，reconcile 第一次 cleanup 再失败一次，第二次成功。
    mocks.destroyFailures = 2;
    const fixture = await createFixture('pending');

    const started = new Promise<void>((resolve) => {
      mocks.onStarted = resolve;
    });
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    const processing = processor?.(fixture.job);
    await started;
    await requestCancel(fixture.runId);
    // 不抛错 = BullMQ 正常完成；业务终态已交接给 DB，尚未发布。
    await expect(processing).resolves.toBeUndefined();
    expect(mocks.cancelFrames).toBe(1);
    expect(mocks.destroyed).toHaveLength(1);

    const pending = await runRow(fixture.runId);
    expect(pending).toMatchObject({
      status: 'running',
      endedAt: null,
      sandboxId: expect.any(String),
      errorKind: 'cancelled',
      sessionId: 'sdk-pending',
    });
    expect(pending?.pendingFinish).toMatchObject({
      type: 'run_finished',
      status: 'cancelled',
      costUsd: 0.25,
      turns: 2,
      failureKind: 'cancelled',
    });
    expect(pending?.pendingFinish?.messageIds).toHaveLength(1);

    // 生产者不发布终态：run_finished 只能由 reconcile 补发一次。
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (await readStream(fixture.runId)).filter((event) => event.type === 'run_finished'),
    ).toHaveLength(0);

    // 业务占用仍在：memory 准入看的就是 running。
    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.target, fixture.runId));
    expect(audits.map((row) => row.action)).not.toContain('agent.run.finished');

    // 与真实 API 联动：pending 的 running 行仍占住「发起专家 + enabled 子级」。
    expectProblem(await putMemory(fixture.childId), 'CONFLICT');
    expectProblem(await patchAgent(fixture.childId, { enabled: false }), 'CONFLICT');
    expectProblem(await patchAgent(fixture.agentId, { subAgentIds: [] }), 'CONFLICT');
    // 普通字段不改变活动集合，运行中仍可保存。
    expect((await patchAgent(fixture.agentId, { timeoutMs: 120_000 })).statusCode).toBe(200);

    const manager = mocks.managers[0];
    expect(manager).toBeDefined();
    const cleanup = (input: { runId: string; conversationId: string; sandboxId: string }) =>
      manager?.cleanup(input.conversationId, input.sandboxId, input.runId) ??
      Promise.reject(new Error('no manager'));
    const queue = new Queue<AgentRunJob>(`pending-${randomUUID()}`, {
      connection: { url: redisUrl, maxRetriesPerRequest: null },
    });

    try {
      // 第一次 cleanup 失败：保持 running，不发布终态。
      mocks.destroyFailures = 1;
      expect(
        await reconcileOrphanedRuns(db, logger, 10_000, queue, async (input) =>
          cleanup({
            runId: input.runId,
            conversationId: input.conversationId,
            sandboxId: input.sandboxId,
          }),
        ),
      ).toBe(0);
      const stillRunning = await runRow(fixture.runId);
      expect(stillRunning).toMatchObject({ status: 'running', endedAt: null });
      expect(stillRunning?.pendingFinish).toEqual(pending?.pendingFinish);
      expect(
        (await readStream(fixture.runId)).filter((e) => e.type === 'run_finished'),
      ).toHaveLength(0);

      // cleanup 失败时终态仍未落库，真实 API 继续拒绝。
      expectProblem(await putMemory(fixture.childId), 'CONFLICT');
      expectProblem(await patchAgent(fixture.childId, { enabled: false }), 'CONFLICT');
      expectProblem(await patchAgent(fixture.agentId, { subAgentIds: [] }), 'CONFLICT');

      // 第二次 cleanup 成功：原事件只发布一次，状态与读数按交接时的值收敛。
      expect(
        await reconcileOrphanedRuns(db, logger, 10_000, queue, async (input) =>
          cleanup({
            runId: input.runId,
            conversationId: input.conversationId,
            sandboxId: input.sandboxId,
          }),
        ),
      ).toBe(1);
      const settled = await runRow(fixture.runId);
      expect(settled).toMatchObject({
        status: 'cancelled',
        endedAt: expect.any(Date),
        pendingFinish: null,
        costUsd: '0.2500',
        turns: 2,
        inputTokens: 5,
        outputTokens: 7,
      });
      expect(mocks.destroyed.at(-1)).toBe(pending?.sandboxId);

      const finished = (await readStream(fixture.runId)).filter(
        (event) => event.type === 'run_finished',
      );
      expect(finished).toHaveLength(1);
      expect(finished[0]).toEqual(pending?.pendingFinish);

      const reconciled = await db
        .select({ action: schema.auditLog.action, status: schema.auditLog.status })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.target, fixture.runId));
      expect(reconciled.filter((row) => row.action === 'agent.run.reconciled')).toEqual([
        { action: 'agent.run.reconciled', status: 'error' },
      ]);

      // 终态落库后活动集合释放：保存、启停、解绑恢复可用。
      const saved = await putMemory(fixture.childId, 'settled memory');
      expect(saved.statusCode, saved.body).toBe(200);
      const stored = await inject(app, {
        method: 'GET',
        url: `/api/agents/${fixture.childId}/memory/MEMORY.md`,
        headers: { cookie },
      });
      expect(stored.statusCode, stored.body).toBe(200);
      expect(stored.json()).toMatchObject({ content: 'settled memory' });
      expect((await patchAgent(fixture.childId, { enabled: false })).statusCode).toBe(200);
      expect((await patchAgent(fixture.agentId, { subAgentIds: [] })).statusCode).toBe(200);
    } finally {
      await queue.close();
    }
  }, 20_000);
});
