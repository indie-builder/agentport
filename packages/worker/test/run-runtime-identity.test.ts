import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personalMemoryDir, personalMemoryPath, RunFailure } from '@agentport/core';
import { createDb, newId, repo, schema } from '@agentport/db';
import { chatEventSchema, RUNS_QUEUE } from '@agentport/shared';
import type { UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPersonalMemoryHook } from '../../sandbox/src/memory-permissions.js';
import { SandboxCleanupError } from '../src/sandbox/provider.js';

const mocks = vi.hoisted(() => ({
  sdkFailure: 'throw' as 'throw' | 'abort',
  sdkSynthetic: false,
  stdinLines: [] as string[],
  acquire: vi.fn(),
  run: vi.fn(),
  start: vi.fn(),
  release: vi.fn(),
  publishRun: vi.fn(async () => undefined),
  publishChannelEvent: vi.fn(async () => undefined),
  isRetryable: vi.fn(() => false),
  checkAccess: vi.fn(),
  processors: new Map<string, (job: unknown) => Promise<void>>(),
  dbHandles: [] as Array<{ pool: { end(): Promise<void> } }>,
}));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield* mocks.stdinLines;
    },
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@anthropic-ai/claude-agent-sdk')>()),
  query: ({ options }: { options: { abortController: AbortController } }) =>
    Object.assign(
      (async function* () {
        yield {
          type: 'assistant',
          parent_tool_use_id: null,
          uuid: '33333333-4444-4555-8666-777777777777',
          ...(mocks.sdkSynthetic ? { error: 'rate_limit' } : {}),
          message: {
            id: 'msg-boundary',
            content: [{ type: 'text', text: 'API Error: rate_limit' }],
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: mocks.sdkSynthetic ? 0 : 13,
            },
          },
        };
        if (mocks.sdkFailure === 'abort') options.abortController.abort();
        throw new Error('query ended before result');
      })(),
      { close() {} },
    ),
}));

vi.mock('../src/channel-events.js', () => ({
  publishChannelEventSafely: mocks.publishChannelEvent,
}));

vi.mock('../src/run-access.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/run-access.js')>();
  return { ...actual, checkQueuedRunAccess: mocks.checkAccess };
});

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
    async cleanup(): Promise<void> {}
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
const cleanupChannels: string[] = [];
const cleanupPreferences: string[] = [];
const TEST_BUSINESS_ID = 'worker-run-user';

async function createRunFixture(
  label: string,
  subject:
    | { kind: 'user'; businessId: string }
    | { kind: 'service'; serviceId: 'system' | 'mcp' } = {
    kind: 'user',
    businessId: TEST_BUSINESS_ID,
  },
  trigger: 'chat' | 'schedule' | 'event' | 'review' | 'channel' = 'chat',
  channelId?: string,
) {
  const fixtureAgentId = newId('agent');
  const fixtureConversationId = newId('conversation');
  const fixtureRunId = newId('run');
  cleanupAgents.push(fixtureAgentId);
  cleanupConversations.push(fixtureConversationId);
  cleanupRuns.push(fixtureRunId);
  if (channelId !== undefined) {
    cleanupChannels.push(channelId);
    await db.insert(schema.channels).values({
      id: channelId,
      name: `retry-${channelId.slice(4)}`,
      createdBy: TEST_BUSINESS_ID,
    });
  }
  await db.insert(schema.agents).values({
    id: fixtureAgentId,
    slug: `retry-${fixtureAgentId.slice(4)}`,
    name: label,
    model: 'test',
    createdBy: TEST_BUSINESS_ID,
    ownerBusinessId: TEST_BUSINESS_ID,
  });
  await db.insert(schema.conversations).values({
    id: fixtureConversationId,
    agentId: fixtureAgentId,
    title: label,
    ...(channelId === undefined ? {} : { channelId }),
    ...(subject.kind === 'user'
      ? { createdBy: subject.businessId }
      : { serviceId: subject.serviceId }),
  });
  await db.insert(schema.agentRuns).values({
    id: fixtureRunId,
    conversationId: fixtureConversationId,
    agentId: fixtureAgentId,
    trigger,
    ...(channelId === undefined ? {} : { channelId }),
    ...(subject.kind === 'user'
      ? { subjectKind: 'user', initiatedBy: subject.businessId }
      : { subjectKind: 'service', serviceId: subject.serviceId }),
  });
  await db.insert(schema.messages).values({
    id: newId('message'),
    conversationId: fixtureConversationId,
    role: 'user',
    content: { type: 'text', text: 'ask' },
    runId: fixtureRunId,
    ...(subject.kind === 'user' ? { senderBusinessId: subject.businessId } : {}),
  });
  return {
    agentId: fixtureAgentId,
    conversationId: fixtureConversationId,
    runId: fixtureRunId,
    subject,
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
    mocks.publishChannelEvent.mockReset();
    mocks.publishChannelEvent.mockImplementation(async () => undefined);
    mocks.release.mockResolvedValue(undefined);
    // 默认放行身份重查；具体拒绝场景在用例里覆盖返回值。
    mocks.checkAccess.mockReset();
    mocks.checkAccess.mockResolvedValue(null);
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
    for (const id of cleanupChannels) {
      await db.delete(schema.channels).where(eq(schema.channels.id, id));
    }
    for (const id of cleanupPreferences) {
      await db.delete(schema.userPreferences).where(eq(schema.userPreferences.businessId, id));
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
      createdBy: TEST_BUSINESS_ID,
      ownerBusinessId: TEST_BUSINESS_ID,
    });
    await db.insert(schema.conversations).values({
      id: conversationId,
      agentId,
      title: 'identity',
      createdBy: TEST_BUSINESS_ID,
    });
    await db.insert(schema.agentRuns).values({
      id: runId,
      conversationId,
      agentId,
      subjectKind: 'user',
      initiatedBy: TEST_BUSINESS_ID,
    });
    await db.insert(schema.messages).values({
      id: newId('message'),
      conversationId,
      role: 'user',
      content: { type: 'text', text: 'ask' },
      runId,
      senderBusinessId: TEST_BUSINESS_ID,
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
      // 容器已确认停稳，只是执行本身是基础设施失败：这才是可重试的形态。
      settlement: { state: 'stopped', code: 0, signal: null },
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
        // 容器已确认停稳：基础设施失败可以交给 BullMQ 重试同一 run。
        settlement: { state: 'stopped', code: 0, signal: null },
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

  it('retries an infra acquire failure before a lease exists instead of deferring it', async () => {
    mocks.acquire
      .mockRejectedValueOnce(new RunFailure('infra', 'sandbox acquire failed'))
      .mockResolvedValueOnce(sandboxLease('sandbox-after-retry'));
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-after-retry',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [],
      sessionId: 'sdk-after-retry',
    });

    const fixture = await createRunFixture('prelease-retry');
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    // 还没拿到 lease：没有遗留容器，infra 失败必须保持可重试，且不能写 pending。
    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    let [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({ status: 'queued', startedAt: null, pendingFinish: null });

    await processor?.({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });
    [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({
      status: 'succeeded',
      pendingFinish: null,
      endedAt: expect.any(Date),
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('finalizes a cancellation before the lease exists without deferring it', async () => {
    mocks.acquire.mockRejectedValue(
      new RunFailure('cancelled', 'cancelled during sandbox acquire'),
    );

    const fixture = await createRunFixture('prelease-cancel');
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    // 取消发生在容器创建前：没有需要 reconcile 确认的容器，终态应立即落库。
    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 3 } }),
    ).resolves.toBeUndefined();
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({
      status: 'cancelled',
      endedAt: expect.any(Date),
      pendingFinish: null,
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(
      mocks.publishRun.mock.calls.filter(
        ([, event]) => (event as { type?: string }).type === 'run_finished',
      ),
    ).toHaveLength(1);
  });

  it('keeps the exact sandbox id when acquire reports a typed cleanup failure', async () => {
    mocks.acquire.mockRejectedValue(
      new RunFailure(
        'infra',
        'docker rm failed',
        new SandboxCleanupError('sandbox-typed', 'docker rm failed', new Error('rm failed')),
      ),
    );

    const fixture = await createRunFixture('typed-cleanup');
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    // 容器已创建但不能确认删除：交接终态时必须保留它的 id，供 reconcile 按 id 清理。
    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 3 } }),
    ).resolves.toBeUndefined();
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({
      status: 'running',
      endedAt: null,
      sandboxId: 'sandbox-typed',
      pendingFinish: {
        type: 'run_finished',
        status: 'failed',
        error: expect.stringContaining('docker rm failed'),
      },
    });
    expect(mocks.release).not.toHaveBeenCalled();
    expect(
      mocks.publishRun.mock.calls.filter(
        ([, event]) => (event as { type?: string }).type === 'run_finished',
      ),
    ).toHaveLength(0);
  });

  it('defers an unconfirmed stop to reconcile instead of retrying or finalizing', async () => {
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-pending-unit'));
    mocks.run.mockResolvedValue({
      status: 'failed',
      sandboxId: 'sandbox-pending-unit',
      settlement: { state: 'unconfirmed', error: 'cancel not confirmed' },
      cleanupError: 'destroy failed',
      events: [],
      sessionId: 'sdk-pending',
      error: 'cancel not confirmed',
      failure: new RunFailure('infra', 'cancel not confirmed'),
    });

    const fixture = await createRunFixture('pending');
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    // 还有重试额度也不能重跑：停稳未确认时副作用可能仍在发生。
    await processor?.({
      ...fixture.job,
      attemptsMade: 0,
      opts: { attempts: 3 },
    });

    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({
      status: 'running',
      endedAt: null,
      sandboxId: 'sandbox-pending-unit',
      errorKind: 'infra',
      sessionId: 'sdk-pending',
    });
    expect(run?.pendingFinish).toMatchObject({
      type: 'run_finished',
      status: 'failed',
      error: expect.stringContaining('cancel not confirmed'),
    });

    // 终态只在 reconcile 确认容器销毁后发布；这里不能提前发或写 finished 审计。
    const finished = mocks.publishRun.mock.calls.filter(
      ([, event]) => (event as { type?: string }).type === 'run_finished',
    );
    expect(finished).toHaveLength(0);
    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.target, fixture.runId),
          eq(schema.auditLog.action, 'agent.run.finished'),
        ),
      );
    expect(audits).toHaveLength(0);
    expect(mocks.release).toHaveBeenCalledWith({ reuse: false });
  });

  it('fails a queued run before starting when the account is disabled or access was revoked', async () => {
    const fixture = await createRunFixture('denied');
    mocks.checkAccess.mockResolvedValue({
      reason: 'account_inactive',
      message: '账户已停用或不存在，运行未启动',
    });

    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    await processor?.({
      ...fixture.job,
      attemptsMade: 0,
      opts: { attempts: 1 },
    });

    // 不建容器、不执行；排队运行明确失败，由 UI 看到原因。
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.checkAccess).toHaveBeenCalledWith(expect.anything(), {
      runId: fixture.runId,
      trigger: 'chat',
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      businessId: TEST_BUSINESS_ID,
      channelId: null,
    });
    const [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({
      status: 'failed',
      error: '账户已停用或不存在，运行未启动',
      errorKind: 'agent',
    });
    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.target, fixture.runId),
          eq(schema.auditLog.action, 'agent.run.denied'),
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it('mounts only the current business user personal directory', async () => {
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-user-mount'));
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-user-mount',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [],
      sessionId: 'sdk-user-mount',
    });

    const fixture = await createRunFixture('user-mount');
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    const acquireInput = mocks.acquire.mock.calls[0]?.[0] as
      | { spec: { personalDir?: string } }
      | undefined;
    const digest = createHash('sha256').update(TEST_BUSINESS_ID, 'utf8').digest('hex');
    expect(acquireInput?.spec.personalDir).toBe(join(workdir, '_users', digest));
  });

  it('skips personal memory for every member sharing a channel lane, and keeps it for their private chat', async () => {
    const channelId = newId('channel');
    const laneAgentId = newId('agent');
    const laneConversationId = newId('conversation');
    const userA = 'channel-lane-user-a';
    const userB = 'channel-lane-user-b';
    cleanupChannels.push(channelId);
    cleanupAgents.push(laneAgentId);
    cleanupConversations.push(laneConversationId);
    cleanupPreferences.push(userA, userB);
    await db.insert(schema.channels).values({
      id: channelId,
      name: 'privacy lane',
      createdBy: userA,
    });
    await db.insert(schema.agents).values({
      id: laneAgentId,
      slug: `lane-${laneAgentId.slice(4)}`,
      name: 'lane',
      model: 'test',
      createdBy: userA,
      ownerBusinessId: userA,
    });
    await db.insert(schema.conversations).values({
      id: laneConversationId,
      agentId: laneAgentId,
      channelId,
      title: 'lane',
      createdBy: userA,
    });
    await db.insert(schema.userPreferences).values([
      { businessId: userA, content: 'A 的个人偏好' },
      { businessId: userB, content: 'B 的个人偏好' },
    ]);

    const laneJob = async (businessId: string) => {
      const laneRunId = newId('run');
      cleanupRuns.push(laneRunId);
      await db.insert(schema.agentRuns).values({
        id: laneRunId,
        conversationId: laneConversationId,
        agentId: laneAgentId,
        trigger: 'channel',
        channelId,
        subjectKind: 'user',
        initiatedBy: businessId,
      });
      await db.insert(schema.messages).values({
        id: newId('message'),
        conversationId: laneConversationId,
        role: 'user',
        content: { type: 'text', text: 'ask' },
        runId: laneRunId,
        senderBusinessId: businessId,
      });
      return {
        data: {
          runId: laneRunId,
          agentId: laneAgentId,
          conversationId: laneConversationId,
          prompt: 'ask',
        },
      };
    };

    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-channel-lane'));
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-channel-lane',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [],
      sessionId: 'sdk-channel-lane',
    });
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    for (const businessId of [userA, userB]) {
      await processor?.({
        data: (await laneJob(businessId)).data,
        attemptsMade: 0,
        opts: { attempts: 1 },
      });
    }

    expect(mocks.acquire).toHaveBeenCalledTimes(2);
    for (const call of mocks.acquire.mock.calls) {
      expect((call[0] as { spec: { personalDir?: string } }).spec.personalDir).toBeUndefined();
    }
    await expect(stat(personalMemoryPath(workdir, userA))).rejects.toThrow(/ENOENT/);
    await expect(stat(personalMemoryPath(workdir, userB))).rejects.toThrow(/ENOENT/);

    // 频道 lane 共享给所有成员，模型输入不能出现任一成员的个人偏好。
    const channelPrompts = mocks.run.mock.calls.map(
      ([input]) => (input as { task: { prompt: string } }).task.prompt,
    );
    expect(channelPrompts).toHaveLength(2);
    for (const prompt of channelPrompts) {
      expect(prompt).not.toContain('A 的个人偏好');
      expect(prompt).not.toContain('B 的个人偏好');
    }
    const promptEvent: UserPromptSubmitHookInput = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session',
      transcript_path: '/tmp/transcript',
      cwd: '/workspace',
      prompt: 'ask',
    };
    for (const businessId of [userA, userB]) {
      const hook = createPersonalMemoryHook(personalMemoryPath(workdir, businessId));
      expect(await hook(promptEvent, undefined, { signal: new AbortController().signal })).toEqual(
        {},
      );
    }

    const privateRun = await createRunFixture('private-same-author', {
      kind: 'user',
      businessId: userA,
    });
    await processor?.({ ...privateRun.job, attemptsMade: 0, opts: { attempts: 1 } });
    const privateAcquire = mocks.acquire.mock.calls[2]?.[0] as
      | { spec: { personalDir?: string } }
      | undefined;
    expect(privateAcquire?.spec.personalDir).toBe(personalMemoryDir(workdir, userA));
    expect(await readFile(personalMemoryPath(workdir, userA), 'utf8')).toBe('A 的个人偏好');
    expect(
      await createPersonalMemoryHook(personalMemoryPath(workdir, userA))(promptEvent, undefined, {
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'A 的个人偏好' },
    });
  });

  it('fails a queued schedule run without sandbox when schedules.manage was revoked', async () => {
    const fixture = await createRunFixture('schedule-denied', undefined, 'schedule');
    mocks.checkAccess.mockResolvedValue({
      reason: 'permission_denied',
      message: '当前账户没有该操作的权限，运行未启动',
    });

    const processor = mocks.processors.get(RUNS_QUEUE);
    await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    expect(mocks.checkAccess).toHaveBeenCalledWith(expect.anything(), {
      runId: fixture.runId,
      trigger: 'schedule',
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      businessId: TEST_BUSINESS_ID,
      channelId: null,
    });
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    const [run] = await db
      .select({ status: schema.agentRuns.status })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run?.status).toBe('failed');
  });

  it('leaves an already claimed running run untouched instead of re-checking or killing it', async () => {
    const fixture = await createRunFixture('already-running');
    await db
      .update(schema.agentRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(schema.agentRuns.id, fixture.runId));

    const processor = mocks.processors.get(RUNS_QUEUE);
    await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    expect(mocks.checkAccess).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    const [run] = await db
      .select({ status: schema.agentRuns.status, endedAt: schema.agentRuns.endedAt })
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({ status: 'running', endedAt: null });
  });

  it('does not mount any personal memory for a service run', async () => {
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-service'));
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-service',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [],
      sessionId: 'sdk-service',
    });

    const fixture = await createRunFixture('service', { kind: 'service', serviceId: 'system' });
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    expect(mocks.checkAccess).not.toHaveBeenCalled();
    const acquireInput = mocks.acquire.mock.calls[0]?.[0] as
      | { spec: { personalDir?: string } }
      | undefined;
    expect(acquireInput?.spec.personalDir).toBeUndefined();
  });

  it('projects only the final channel reply after a retried attempt', async () => {
    const channelId = newId('channel');
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-channel-retry'));
    mocks.run
      .mockResolvedValueOnce({
        status: 'failed',
        sandboxId: 'sandbox-channel-retry',
        settlement: { state: 'stopped', code: 0, signal: null },
        events: [{ type: 'assistant_text', text: '中间回复 A', blockIndex: 0 }],
        error: 'infra down',
        failure: new RunFailure('infra', 'infra down'),
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        sandboxId: 'sandbox-channel-retry',
        settlement: { state: 'stopped', code: 0, signal: null },
        events: [{ type: 'assistant_text', text: '最终回复 B', blockIndex: 0 }],
      });

    const fixture = await createRunFixture('channel-retry', undefined, 'channel', channelId);
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    // 中间轮已落库到私有会话，但不能提前占用频道 seq：已订阅者会漏掉最终正文。
    expect(
      await db
        .select()
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.runId, fixture.runId)),
    ).toHaveLength(0);
    expect(
      mocks.publishChannelEvent.mock.calls.filter(([, event]) => event.type === 'message.created'),
    ).toHaveLength(0);

    await processor?.({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });

    const [projection] = await db
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.runId, fixture.runId));
    expect(projection).toMatchObject({
      channelId,
      kind: 'agent',
      agentId: fixture.agentId,
      runId: fixture.runId,
      body: '最终回复 B',
    });
    const assistant = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.runId, fixture.runId), eq(schema.messages.role, 'assistant')));
    expect(assistant.some((row) => row.id === projection?.sourceMessageId)).toBe(true);

    const created = mocks.publishChannelEvent.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.type === 'message.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      channelId,
      seq: projection?.seq,
      message: { id: projection?.id, body: '最终回复 B' },
    });
  });

  it('leaves no channel projection when the final retry has no assistant text', async () => {
    const channelId = newId('channel');
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-channel-empty'));
    mocks.run
      .mockResolvedValueOnce({
        status: 'failed',
        sandboxId: 'sandbox-channel-empty',
        settlement: { state: 'stopped', code: 0, signal: null },
        events: [{ type: 'assistant_text', text: '中间回复 A', blockIndex: 0 }],
        error: 'infra down',
        failure: new RunFailure('infra', 'infra down'),
      })
      .mockResolvedValueOnce({
        status: 'succeeded',
        sandboxId: 'sandbox-channel-empty',
        settlement: { state: 'stopped', code: 0, signal: null },
        events: [],
      });

    const fixture = await createRunFixture('channel-empty', undefined, 'channel', channelId);
    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();

    await expect(
      processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    await processor?.({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });

    expect(
      await db
        .select()
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.runId, fixture.runId)),
    ).toHaveLength(0);
    expect(
      mocks.publishChannelEvent.mock.calls.filter(([, event]) => event.type === 'message.created'),
    ).toHaveLength(0);
  });

  for (const scenario of [
    { name: 'a failed outcome with model tokens', status: 'failed', tokens: { inputTokens: 17 } },
    {
      name: 'a cancelled outcome with model tokens',
      status: 'cancelled',
      tokens: { outputTokens: 9 },
    },
    { name: 'a succeeded outcome without text', status: 'succeeded', tokens: {} },
    { name: 'a failure with only a session id', status: 'failed', tokens: {}, advances: false },
    {
      name: 'real runner assistant then throw',
      status: 'failed',
      tokens: {},
      sdk: 'throw',
      synthetic: false,
    },
    {
      name: 'real runner assistant then abort',
      status: 'cancelled',
      tokens: {},
      sdk: 'abort',
      synthetic: false,
    },
    {
      name: 'real runner synthetic rate_limit then throw',
      status: 'failed',
      tokens: {},
      sdk: 'throw',
      synthetic: true,
      advances: false,
    },
  ] as const) {
    it(`advances the channel cursor after ${scenario.name} only when the model executed`, async () => {
      const channelId = newId('channel');
      const fixture = await createRunFixture(
        `cursor-${scenario.status}`,
        undefined,
        'channel',
        channelId,
      );
      await db
        .insert(schema.channelMembers)
        .values({ channelId, businessId: TEST_BUSINESS_ID, role: 'owner' });
      await db.insert(schema.channelAgentBindings).values({
        channelId,
        agentId: fixture.agentId,
        conversationId: fixture.conversationId,
        addedBy: TEST_BUSINESS_ID,
      });
      const [, trigger] = await db
        .insert(schema.channelMessages)
        .values(
          ['unconsumed context', 'first trigger'].map((body) => ({
            id: newId('channelMessage'),
            channelId,
            kind: 'human' as const,
            authorBusinessId: TEST_BUSINESS_ID,
            body,
          })),
        )
        .returning();
      if (!trigger) throw new Error('missing trigger message');
      await db
        .update(schema.agentRuns)
        .set({ channelTriggerMessageId: trigger.id })
        .where(eq(schema.agentRuns.id, fixture.runId));

      mocks.acquire.mockResolvedValue(sandboxLease(`sandbox-cursor-${scenario.status}`));
      mocks.run.mockResolvedValue({
        status: scenario.status,
        sandboxId: `sandbox-cursor-${scenario.status}`,
        settlement: { state: 'stopped', code: 0, signal: null },
        events: [],
        sessionId: `sdk-cursor-${scenario.status}`,
        ...scenario.tokens,
        ...(scenario.status === 'succeeded' ? {} : { error: 'model failed without output' }),
      });

      if ('sdk' in scenario) {
        mocks.sdkFailure = scenario.sdk;
        mocks.sdkSynthetic = scenario.synthetic;
        mocks.run.mockImplementation(async (input) => {
          const actual =
            await vi.importActual<typeof import('../src/runner-client.js')>(
              '../src/runner-client.js',
            );
          actual.configureRunnerClient(process.env.REDIS_URL ?? '');
          try {
            return await actual.runInSandbox({
              ...input,
              lease: {
                sandboxId: 'runner-boundary',
                release: async () => undefined,
                start: async ({ onEvent, env }) => {
                  mocks.stdinLines = [JSON.stringify(input.task)];
                  const signals = new Set(process.listeners('SIGTERM'));
                  // 容器边界：把 worker 交给 sandbox 的 env 原样注入 runner 进程。
                  const previousEnv = { ...process.env };
                  Object.assign(process.env, env);
                  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
                    onEvent(chatEventSchema.parse(JSON.parse(String(chunk))));
                    return true;
                  });
                  try {
                    vi.resetModules();
                    await import('../../sandbox/src/runner.js');
                  } finally {
                    stdout.mockRestore();
                    for (const key of Object.keys(env)) {
                      if (previousEnv[key] === undefined) delete process.env[key];
                      else process.env[key] = previousEnv[key];
                    }
                    for (const listener of process.listeners('SIGTERM')) {
                      if (!signals.has(listener)) process.off('SIGTERM', listener);
                    }
                  }
                  return {
                    done: Promise.resolve({ state: 'stopped', code: 0, signal: null }),
                    send() {},
                    cancel: async () => ({ state: 'stopped', code: 0, signal: null }),
                  };
                },
              },
            });
          } finally {
            await actual.closeRunnerClient();
          }
        });
      }

      const processor = mocks.processors.get(RUNS_QUEUE);
      expect(processor).toBeDefined();
      await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

      if ('sdk' in scenario) {
        expect(await mocks.run.mock.results[0]?.value).toMatchObject({
          status: scenario.status,
          ...(scenario.synthetic ? {} : { inputTokens: 13, outputTokens: 0 }),
        });
        const [reply] = await db
          .select()
          .from(schema.messages)
          .where(
            and(eq(schema.messages.runId, fixture.runId), eq(schema.messages.role, 'assistant')),
          );
        expect(repo.chat.messageText(reply?.content)).toBe('API Error: rate_limit');
      }

      const [run] = await db
        .select({ status: schema.agentRuns.status })
        .from(schema.agentRuns)
        .where(eq(schema.agentRuns.id, fixture.runId))
        .limit(1);
      expect(run?.status).toBe(scenario.status);
      const [binding] = await db
        .select({ contextSeq: schema.channelAgentBindings.contextSeq })
        .from(schema.channelAgentBindings)
        .where(
          and(
            eq(schema.channelAgentBindings.channelId, channelId),
            eq(schema.channelAgentBindings.agentId, fixture.agentId),
          ),
        );
      const advances = 'advances' in scenario ? scenario.advances : true;
      expect(binding?.contextSeq).toBe(advances ? trigger.seq : 0);

      // 下一轮准入用真实 repo：游标已推进时不能再注入上一轮已消费的上下文。
      const [nextTrigger] = await db
        .insert(schema.channelMessages)
        .values({
          id: newId('channelMessage'),
          channelId,
          kind: 'human',
          authorBusinessId: TEST_BUSINESS_ID,
          body: 'next trigger',
        })
        .returning();
      if (!nextTrigger) throw new Error('missing next trigger');
      const admitted = await repo.chat.admitChatRun(db, {
        agentId: fixture.agentId,
        message: nextTrigger.body,
        subject: { kind: 'user', businessId: TEST_BUSINESS_ID },
        channel: { channelId, channelMessageId: nextTrigger.id },
      });
      cleanupRuns.push(admitted.run.id);
      const [user] = await db
        .select({ content: schema.messages.content })
        .from(schema.messages)
        .where(and(eq(schema.messages.runId, admitted.run.id), eq(schema.messages.role, 'user')));
      const text = repo.chat.messageText(user?.content);
      if (advances) {
        expect(text).not.toContain('first trigger');
      } else {
        expect(text).toContain('first trigger');
      }
    });
  }

  /** 频道失败轮与正常轮的 session 边界必须和游标一致，否则下一轮会同时恢复 transcript 并重注入上下文。 */
  async function channelLane(
    label: string,
  ): Promise<Awaited<ReturnType<typeof createRunFixture>> & { channelId: string }> {
    const channelId = newId('channel');
    const fixture = await createRunFixture(label, undefined, 'channel', channelId);
    await db.insert(schema.channelMembers).values({
      channelId,
      businessId: TEST_BUSINESS_ID,
      role: 'owner',
    });
    await db.insert(schema.channelAgentBindings).values({
      channelId,
      agentId: fixture.agentId,
      conversationId: fixture.conversationId,
      addedBy: TEST_BUSINESS_ID,
    });
    const [, trigger] = await db
      .insert(schema.channelMessages)
      .values(
        ['unconsumed context', 'first trigger'].map((body) => ({
          id: newId('channelMessage'),
          channelId,
          kind: 'human' as const,
          authorBusinessId: TEST_BUSINESS_ID,
          body,
        })),
      )
      .returning();
    if (!trigger) throw new Error('missing trigger message');
    await db
      .update(schema.agentRuns)
      .set({ channelTriggerMessageId: trigger.id })
      .where(eq(schema.agentRuns.id, fixture.runId));
    return { ...fixture, channelId };
  }

  async function admitNextChannelRun(
    fixture: { channelId: string; agentId: string; conversationId: string },
    prompt: string,
  ): Promise<{ runId: string; job: { data: Record<string, string> } }> {
    const [trigger] = await db
      .insert(schema.channelMessages)
      .values({
        id: newId('channelMessage'),
        channelId: fixture.channelId,
        kind: 'human',
        authorBusinessId: TEST_BUSINESS_ID,
        body: prompt,
      })
      .returning();
    if (!trigger) throw new Error('missing next trigger');
    const admitted = await repo.chat.admitChatRun(db, {
      agentId: fixture.agentId,
      message: trigger.body,
      subject: { kind: 'user', businessId: TEST_BUSINESS_ID },
      channel: { channelId: fixture.channelId, channelMessageId: trigger.id },
    });
    cleanupRuns.push(admitted.run.id);
    return {
      runId: admitted.run.id,
      job: {
        data: {
          runId: admitted.run.id,
          agentId: fixture.agentId,
          conversationId: admitted.conversationId,
          prompt: trigger.body,
        },
      },
    };
  }

  function taskOfCall(index: number): { prompt: string; resumeSessionId?: string } | undefined {
    const call = mocks.run.mock.calls[index]?.[0] as
      | { task: { prompt: string; resumeSessionId?: string } }
      | undefined;
    return call?.task;
  }

  function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  async function conversationSession(conversationId: string): Promise<string | null | undefined> {
    return (await repo.chat.getConversationSdkState(db, conversationId))?.sdkSessionId;
  }

  it('does not resume a failed channel round that never executed the model', async () => {
    const fixture = await channelLane('channel-session-unexecuted');
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-session-unexecuted'));
    mocks.run.mockResolvedValue({
      status: 'failed',
      sandboxId: 'sandbox-session-unexecuted',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [],
      inputTokens: 0,
      outputTokens: 0,
      sessionId: 'sdk-failed-without-execution',
      error: 'API Error: model failed before producing output',
    });

    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    // 零用量：游标不推进，session 也不能成为下一轮可恢复的 transcript 边界。
    expect(await conversationSession(fixture.conversationId)).toBeNull();

    const next = await admitNextChannelRun(fixture, 'next trigger');
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-session-unexecuted',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [{ type: 'assistant_text', text: 'after retry', blockIndex: 0 }],
      sessionId: 'sdk-next-executed',
    });
    await processor?.({ ...next.job, attemptsMade: 0, opts: { attempts: 1 } });

    const task = taskOfCall(1);
    expect(task?.resumeSessionId).toBeUndefined();
    // 游标未推进，上下文重新注入是正确的；没有 transcript 恢复时最终请求只出现一次。
    expect(occurrences(task?.prompt ?? '', 'unconsumed context')).toBe(1);
    expect(await conversationSession(fixture.conversationId)).toBe('sdk-next-executed');
  });

  it('keeps the executed channel session boundary and does not re-inject consumed context', async () => {
    const fixture = await channelLane('channel-session-executed');
    mocks.acquire.mockResolvedValue(sandboxLease('sandbox-session-executed'));
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-session-executed',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [{ type: 'assistant_text', text: 'first answer', blockIndex: 0 }],
      inputTokens: 12,
      sessionId: 'sdk-executed',
    });

    const processor = mocks.processors.get(RUNS_QUEUE);
    expect(processor).toBeDefined();
    await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    expect(await conversationSession(fixture.conversationId)).toBe('sdk-executed');

    const next = await admitNextChannelRun(fixture, 'next trigger');
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-session-executed',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [{ type: 'assistant_text', text: 'second answer', blockIndex: 0 }],
      inputTokens: 9,
      sessionId: 'sdk-executed',
    });
    await processor?.({ ...next.job, attemptsMade: 0, opts: { attempts: 1 } });

    const task = taskOfCall(1);
    // 已执行轮恢复 transcript，游标已推进，下一轮不再拼入同一段频道上下文。
    expect(task?.resumeSessionId).toBe('sdk-executed');
    expect(occurrences(task?.prompt ?? '', 'unconsumed context')).toBe(0);
    expect(task?.prompt).toContain('next trigger');
  });

  it.each(['failed', 'succeeded'] as const)(
    'keeps saving the SDK session for a private %s run',
    async (status) => {
      const fixture = await createRunFixture(`private-session-${status}`);
      mocks.acquire.mockResolvedValue(sandboxLease(`sandbox-private-${status}`));
      mocks.run.mockResolvedValue({
        status,
        sandboxId: `sandbox-private-${status}`,
        settlement: { state: 'stopped', code: 0, signal: null },
        events: [],
        sessionId: `sdk-private-${status}`,
        ...(status === 'failed' ? { error: 'model failed without output' } : {}),
      });

      const processor = mocks.processors.get(RUNS_QUEUE);
      expect(processor).toBeDefined();
      await processor?.({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

      expect(await conversationSession(fixture.conversationId)).toBe(`sdk-private-${status}`);
    },
  );
});
