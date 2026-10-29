import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, newId, repo, schema } from '@agentport/db';
import { RUNS_QUEUE } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  acquire: vi.fn(),
  run: vi.fn(),
  start: vi.fn(),
  release: vi.fn(),
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

vi.mock('../src/runner-client.js', () => ({
  configureRunnerClient: vi.fn(),
  closeRunnerClient: vi.fn(),
  acquireSessionSandbox: mocks.acquire,
  runInSandbox: mocks.run,
  publishRun: vi.fn(async () => undefined),
  isRetryable: () => false,
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

  afterAll(async () => {
    if (triggerName !== '') {
      await dbHandle.pool.query(`drop trigger if exists "${triggerName}" on agent_runs`);
    }
    if (functionName !== '') {
      await dbHandle.pool.query(`drop function if exists "${functionName}"()`);
    }
    if (runId !== '') {
      await db.delete(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
      await db.delete(schema.auditLog).where(eq(schema.auditLog.target, runId));
    }
    if (conversationId !== '') {
      await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));
    }
    if (agentId !== '') {
      await db.delete(schema.agents).where(eq(schema.agents.id, agentId));
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
});
