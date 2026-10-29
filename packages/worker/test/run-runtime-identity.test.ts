import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunFailure } from '@agentport/core';
import { createDb, newId, repo, schema } from '@agentport/db';
import { RUNS_QUEUE } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  run: vi.fn(),
  start: vi.fn(),
  release: vi.fn(),
  publishRun: vi.fn(async () => undefined),
  isRetryable: vi.fn(() => false),
  processors: new Map<string, (job: unknown) => Promise<void>>(),
  dbHandles: [] as Array<{ pool: { end(): Promise<void> } }>,
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

vi.mock('../src/sandbox/docker.js', () => ({
  DockerSandboxProvider: class {
    async destroyAll(): Promise<void> {}
    async ensureImage(): Promise<void> {}
  },
  resolveLocalImageId: async () => `sha256:${'a'.repeat(64)}`,
}));

vi.mock('../src/sandbox/sessions.js', () => ({
  SessionSandboxes: class {
    async close(): Promise<void> {}
  },
}));

vi.mock('../src/runner-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/runner-client.js')>();
  // 保留真实分类，避免测试自证一个恒假的 isRetryable。
  mocks.isRetryable.mockImplementation(actual.isRetryable);
  return {
    ...actual,
    configureRunnerClient: vi.fn(),
    closeRunnerClient: vi.fn(),
    acquireSessionSandbox: mocks.acquire,
    runInSandbox: mocks.run,
    publishRun: mocks.publishRun,
    isRetryable: mocks.isRetryable,
  };
});

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

vi.mock('../src/reconcile.js', () => ({
  startReconciler: () => () => undefined,
}));

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

const cleanupRuns: string[] = [];
const cleanupConversations: string[] = [];
const cleanupAgents: string[] = [];

async function createRunFixture(label: string) {
  const fixtureAgentId = newId('agent');
  const fixtureConversationId = newId('conversation');
  const fixtureRunId = newId('run');
  cleanupAgents.push(fixtureAgentId);
  cleanupConversations.push(fixtureConversationId);
  cleanupRuns.push(fixtureRunId);
  await db.insert(schema.agents).values({
    id: fixtureAgentId,
    slug: `retry-${fixtureAgentId.slice(4)}`,
    name: label,
    model: 'test',
  });
  await repo.chat.createConversation(db, {
    id: fixtureConversationId,
    agentId: fixtureAgentId,
    title: label,
  });
  await repo.chat.createRun(db, {
    id: fixtureRunId,
    conversationId: fixtureConversationId,
    agentId: fixtureAgentId,
  });
  await repo.chat.appendMessage(db, {
    id: newId('message'),
    conversationId: fixtureConversationId,
    role: 'user',
    content: { type: 'text', text: 'ask' },
    runId: fixtureRunId,
  });
  return {
    agentId: fixtureAgentId,
    conversationId: fixtureConversationId,
    runId: fixtureRunId,
    job: {
      data: {
        runId: fixtureRunId,
        agentId: fixtureAgentId,
        conversationId: fixtureConversationId,
        prompt: 'ask',
      },
    },
  };
}

function sandboxLease(sandboxId: string) {
  return {
    sandboxId,
    runtimeEnvironment: {
      environmentId: 'rte_retry',
      environmentName: 'retry environment',
      versionId: 'rtv_retry',
      imageId: `sha256:${'c'.repeat(64)}`,
    },
    start: mocks.start,
    release: mocks.release,
  };
}

describe('run runtime environment identity persistence', () => {
  let workdir = '';
  let agentId = '';
  let conversationId = '';
  let runId = '';
  let triggerName = '';
  let functionName = '';

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'worker-runtime-identity-'));
    process.env.WORKSPACES_DIR = workdir;
    process.env.HOST_WORKSPACES_DIR = workdir;
    const sigterm = new Set(process.listeners('SIGTERM'));
    const sigint = new Set(process.listeners('SIGINT'));
    await import('../src/index.js');
    // 测试进程不接管真实关停信号。
    for (const listener of process.listeners('SIGTERM')) {
      if (!sigterm.has(listener)) process.off('SIGTERM', listener);
    }
    for (const listener of process.listeners('SIGINT')) {
      if (!sigint.has(listener)) process.off('SIGINT', listener);
    }
  });

  beforeEach(() => {
    mocks.acquire.mockReset();
    mocks.run.mockReset();
    mocks.start.mockReset();
    mocks.release.mockReset();
    mocks.publishRun.mockReset();
    mocks.publishRun.mockImplementation(async () => undefined);
    mocks.release.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    if (triggerName !== '') {
      await dbHandle.pool.query(`drop trigger if exists "${triggerName}" on agent_runs`);
    }
    if (functionName !== '') {
      await dbHandle.pool.query(`drop function if exists "${functionName}"()`);
    }
    for (const id of cleanupRuns) {
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, id));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.target, id));
    }
    for (const id of cleanupConversations) {
      await db.delete(schema.conversations).where(eq(schema.conversations.id, id));
    }
    for (const id of cleanupAgents) {
      await db.delete(schema.agents).where(eq(schema.agents.id, id));
    }
    await rm(workdir, { recursive: true, force: true });
    for (const handle of mocks.dbHandles) await handle.pool.end();
  });

  it('does not start the run and releases the lease when identity persistence fails', async () => {
    mocks.release.mockResolvedValue(undefined);
    mocks.run.mockRejectedValue(new Error('sandbox must not start'));
    mocks.acquire.mockResolvedValue({
      sandboxId: 'sandbox-fault',
      runtimeEnvironment: {
        environmentId: 'rte_fault',
        environmentName: 'fault environment',
        versionId: 'rtv_fault',
        imageId: `sha256:${'b'.repeat(64)}`,
      },
      start: mocks.start,
      release: mocks.release,
    });

    agentId = newId('agent');
    conversationId = newId('conversation');
    runId = newId('run');
    cleanupAgents.push(agentId);
    cleanupConversations.push(conversationId);
    cleanupRuns.push(runId);
    await db.insert(schema.agents).values({
      id: agentId,
      slug: `identity-${agentId.slice(4)}`,
      name: 'identity',
      model: 'test',
    });
    await repo.chat.createConversation(db, { id: conversationId, agentId, title: 'identity' });
    await repo.chat.createRun(db, { id: runId, conversationId, agentId });
    await repo.chat.appendMessage(db, {
      id: newId('message'),
      conversationId,
      role: 'user',
      content: { type: 'text', text: 'ask' },
      runId,
    });

    // 真实故障注入：只让这次 run 的身份 UPDATE 失败，其余更新照常。
    const suffix = runId.replaceAll(/[^a-zA-Z0-9_]/g, '_');
    functionName = `fault_rt_identity_${suffix}`;
    triggerName = `fault_rt_identity_${suffix}`;
    await dbHandle.pool.query(`
      create function "${functionName}"() returns trigger language plpgsql as $$
      begin
        raise exception 'fault injection: runtime identity update failed';
      end $$;
    `);
    await dbHandle.pool.query(`
      create trigger "${triggerName}"
      before update of runtime_environment_id, runtime_environment_name,
        runtime_environment_version_id, runtime_environment_image_id
      on agent_runs
      for each row
      when (old.id = '${runId}')
      execute function "${functionName}"();
    `);

    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    await processor?.({
      data: { runId, agentId, conversationId, prompt: 'ask' },
      attemptsMade: 0,
      opts: { attempts: 1 },
    });

    expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith({ reuse: false });

    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, runId))
      .limit(1);
    expect(run).toMatchObject({
      status: 'failed',
      runtimeEnvironmentId: null,
      runtimeEnvironmentName: null,
      runtimeEnvironmentVersionId: null,
      runtimeEnvironmentImageId: null,
    });
    expect(run?.error).toContain('runtime_environment_id');
  });

  it('requeues a claimed run when run_started publish fails, then the retry executes', async () => {
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-publish'));
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-publish',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [],
      sessionId: 'sdk-publish-retry',
    });
    mocks.publishRun.mockRejectedValueOnce(new Error('redis unavailable'));

    const fixture = await createRunFixture('publish');
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    // 第一次投递：run_started 发布失败，原错误必须抛出，且认领要退回 queued。
    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('redis unavailable');
    let [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({ status: 'queued', startedAt: null });
    expect(mocks.run).not.toHaveBeenCalled();

    // 第二次投递：状态是 queued，能真正认领并跑完。
    await processor?.({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });
    [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({ status: 'succeeded', error: null });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('does not create an SDK session for a first empty conversation when the attempt will retry', async () => {
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-sdk-empty'));
    mocks.run.mockResolvedValue({
      status: 'failed',
      sandboxId: 'sandbox-sdk-empty',
      settlement: { state: 'unconfirmed', error: 'infra down' },
      events: [],
      sessionId: 'sdk-from-failed-attempt',
      error: 'infra down',
      failure: new RunFailure('infra', 'infra down'),
    });

    const fixture = await createRunFixture('sdk-empty');
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    const [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, fixture.conversationId))
      .limit(1);
    expect(conversation?.sdkSessionId).toBeNull();
  });

  it('does not save a failed attempt SDK session when the run will retry', async () => {
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-sdk-retry'));
    mocks.run
      .mockResolvedValueOnce({
        status: 'failed',
        sandboxId: 'sandbox-sdk-retry',
        // 停稳状态未知：这是基础设施失败，BullMQ 还会重试同一 run。
        settlement: { state: 'unconfirmed', error: 'infra down' },
        events: [],
        sessionId: 'sdk-from-failed-attempt',
        error: 'infra down',
        failure: new RunFailure('infra', 'infra down'),
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        sandboxId: 'sandbox-sdk-retry',
        settlement: { state: 'stopped', code: 0, signal: null },
        events: [],
        sessionId: 'sdk-after-success',
      });

    const fixture = await createRunFixture('sdk-retry');
    await db
      .update(schema.conversations)
      .set({ sdkSessionId: 'sdk-before', forkFromSdkMessageUuid: 'uuid-before' })
      .where(eq(schema.conversations.id, fixture.conversationId));

    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    let [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, fixture.conversationId))
      .limit(1);
    expect(conversation).toMatchObject({
      sdkSessionId: 'sdk-before',
      forkFromSdkMessageUuid: 'uuid-before',
    });

    await processor?.({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });
    const retryTask = (
      mocks.run.mock.calls[1]?.[0] as
        | { task: { resumeSessionId?: string; forkFromMessageUuid?: string } }
        | undefined
    )?.task;
    expect(retryTask).toMatchObject({
      resumeSessionId: 'sdk-before',
      forkFromMessageUuid: 'uuid-before',
    });
    [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, fixture.conversationId))
      .limit(1);
    expect(conversation).toMatchObject({
      sdkSessionId: 'sdk-after-success',
      forkFromSdkMessageUuid: null,
    });
  });
});
