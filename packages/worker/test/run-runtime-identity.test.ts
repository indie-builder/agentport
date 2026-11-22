import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { personalMemoryDir, personalMemoryPath, RunFailure } from '@agentport/core';
import { createDb, newId, repo, schema } from '@agentport/db';
import { chatEventSchema } from '@agentport/shared';
import type { UserPromptSubmitHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import pino from 'pino';
import { createPersonalMemoryHook } from '../../sandbox/src/memory-permissions.js';
import { SandboxCleanupError } from '../src/sandbox/provider.js';
import type { SessionSandboxes } from '../src/sandbox/sessions.js';
import { testAccess } from './fixtures/access.js';
import { createIsolatedDatabase } from './isolated-db.js';

const { TEST_BUSINESS_ID } = testAccess(import.meta.url);
let caseSequence = 0;

const mocks = (() => ({
  sdkFailure: 'throw' as 'throw' | 'abort',
  sdkSynthetic: false,
  stdinLines: [] as string[],
  acquire: mock(),
  run: mock(),
  start: mock(),
  release: mock(),
  publishRun: mock(async () => undefined),
  publishChannelEvent: mock(async () => undefined),
  checkAccess: mock(),
}))();

mock.module('node:readline', () => ({
  createInterface: () => ({
    close() {},
    async *[Symbol.asyncIterator]() {
      yield* mocks.stdinLines;
    },
  }),
}));

const sdkActual = await import('@anthropic-ai/claude-agent-sdk');
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...sdkActual,
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

const runAccessActual = await import('../src/runs/run-access.js');
mock.module('../src/runs/run-access.js', () => ({
  ...runAccessActual,
  checkQueuedRunAccess: mocks.checkAccess,
}));

const runnerClientActual = await import('../src/runner-client.js');
const actualRunnerClient = { ...runnerClientActual };
mock.module('../src/runner-client.js', () => ({
  ...runnerClientActual,
  configureRunnerClient: mock(),
  closeRunnerClient: mock(),
  clearRunCancel: mock(async () => undefined),
  acquireSessionSandbox: mocks.acquire,
  runInSandbox: mocks.run,
  publishRun: mocks.publishRun,
  publishChannelEvent: mocks.publishChannelEvent,
}));

const { loadConfig } = await import('../src/config.js');
const {
  cleanupSandboxIdOf,
  createLoadAgentPlugins,
  createSandboxEnvFactory,
  denyQueuedRun,
  toEntry,
} = await import('../src/handlers.js');
const { runAgentJob } = await import('../src/runs/execute.js');
const { createWorkspaceAssembly } = await import('../src/runs/workspace-assembly.js');

const isolated = await createIsolatedDatabase('worker_runtime_identity');
const dbHandle = createDb(isolated?.url ?? '');
const { db } = dbHandle;

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
  if (channelId !== undefined) {
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

describe.skipIf(isolated === null)('run runtime environment identity persistence', () => {
  let workdir = '';
  let agentId = '';
  let conversationId = '';
  let runId = '';
  let triggerName = '';
  let functionName = '';
  let config!: ReturnType<typeof loadConfig>;
  let loadAgentPlugins!: ReturnType<typeof createLoadAgentPlugins>;
  let writeWorkspace!: ReturnType<typeof createWorkspaceAssembly>;
  let sandboxEnv!: ReturnType<typeof createSandboxEnvFactory>;
  const logger = pino({ level: 'silent' });
  const sandboxClosing = new AbortController();
  const sessionSandboxes = {} as SessionSandboxes;

  async function runJob(job: {
    data: { runId: string; agentId: string; conversationId: string; prompt: string };
    attemptsMade: number;
    opts: { attempts: number };
  }) {
    await runAgentJob(job as Job, {
      db,
      client: dbHandle.client,
      config,
      logger,
      workspacesDir: workdir,
      hostWorkspacesDir: workdir,
      sandboxApiUrl: config.SANDBOX_API_URL,
      sandboxClosing,
      sessionSandboxes,
      modelProxy: null,
      denyQueuedRun,
      loadAgentPlugins,
      writeWorkspace,
      toEntry,
      sandboxEnv,
      cleanupSandboxIdOf,
    });
  }

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'worker-runtime-identity-'));
    config = loadConfig({
      DATABASE_URL: isolated?.url ?? 'postgres://u:p@localhost:5432/db',
      APP_SECRET_KEY: 'a'.repeat(32),
      WORKSPACES_DIR: workdir,
      HOST_WORKSPACES_DIR: workdir,
      LOG_LEVEL: 'error',
    });
    loadAgentPlugins = createLoadAgentPlugins(db, logger);
    writeWorkspace = createWorkspaceAssembly({ db, workspacesDir: workdir, logger });
    sandboxEnv = createSandboxEnvFactory(config, null);
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
    mocks.checkAccess.mockReset();
    mocks.checkAccess.mockResolvedValue(null);
  });

  afterAll(async () => {
    if (triggerName !== '') {
      await dbHandle.client.unsafe(`drop trigger if exists "${triggerName}" on agent_runs`);
    }
    if (functionName !== '') {
      await dbHandle.client.unsafe(`drop function if exists "${functionName}"()`);
    }
    if (workdir !== '') {
      await rm(workdir, { recursive: true, force: true });
    }
    await dbHandle.client.close();
    await isolated?.close();
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

    const suffix = runId.replaceAll(/[^a-zA-Z0-9_]/g, '_');
    functionName = `fault_rt_identity_${suffix}`;
    triggerName = `fault_rt_identity_${suffix}`;
    await dbHandle.client.unsafe(`
      create function "${functionName}"() returns trigger language plpgsql as $$
      begin
        raise exception 'fault injection: runtime identity update failed';
      end $$;
    `);
    await dbHandle.client.unsafe(`
      create trigger "${triggerName}"
      before update of runtime_environment_id, runtime_environment_name,
        runtime_environment_version_id, runtime_environment_image_id
      on agent_runs
      for each row
      when (old.id = '${runId}')
      execute function "${functionName}"();
    `);

    await runJob({
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

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('redis unavailable');
    let [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({ status: 'queued', startedAt: null });
    expect(mocks.run).not.toHaveBeenCalled();

    await runJob({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });
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
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [],
      sessionId: 'sdk-from-failed-attempt',
      error: 'infra down',
      failure: new RunFailure('infra', 'infra down'),
    });

    const fixture = await createRunFixture('sdk-empty');

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
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

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
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

    await runJob({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });
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

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    let [run] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fixture.runId))
      .limit(1);
    expect(run).toMatchObject({ status: 'queued', startedAt: null, pendingFinish: null });

    await runJob({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });
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

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 3 } }),
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

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 3 } }),
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

    await runJob({
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

    await runJob({
      ...fixture.job,
      attemptsMade: 0,
      opts: { attempts: 1 },
    });

    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.checkAccess).toHaveBeenCalledWith(expect.anything(), {
      runId: fixture.runId,
      trigger: 'chat',
      evalRunId: null,
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
    await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

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
    for (const businessId of [userA, userB]) {
      await runJob({
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
    await runJob({ ...privateRun.job, attemptsMade: 0, opts: { attempts: 1 } });
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

    await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    expect(mocks.checkAccess).toHaveBeenCalledWith(expect.anything(), {
      runId: fixture.runId,
      trigger: 'schedule',
      evalRunId: null,
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

    await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

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
    await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

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

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    expect(
      await db
        .select()
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.runId, fixture.runId)),
    ).toHaveLength(0);
    expect(
      mocks.publishChannelEvent.mock.calls.filter(([, event]) => event.type === 'message.created'),
    ).toHaveLength(0);

    await runJob({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });

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

    await expect(
      runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 2 } }),
    ).rejects.toThrow('retryable sandbox failure');
    await runJob({ ...fixture.job, attemptsMade: 1, opts: { attempts: 2 } });

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
          const actual = actualRunnerClient;
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
                  const previousEnv = { ...process.env };
                  Object.assign(process.env, env);
                  const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
                    onEvent(chatEventSchema.parse(JSON.parse(String(chunk))));
                    return true;
                  });
                  try {
                    await import(`../../sandbox/src/runner.js?case=${caseSequence++}`);
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
                    send: () => true,
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

      await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

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
  ): Promise<{
    runId: string;
    job: { data: { runId: string; agentId: string; conversationId: string; prompt: string } };
  }> {
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

    await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

    expect(await conversationSession(fixture.conversationId)).toBeNull();

    const next = await admitNextChannelRun(fixture, 'next trigger');
    mocks.run.mockResolvedValue({
      status: 'succeeded',
      sandboxId: 'sandbox-session-unexecuted',
      settlement: { state: 'stopped', code: 0, signal: null },
      events: [{ type: 'assistant_text', text: 'after retry', blockIndex: 0 }],
      sessionId: 'sdk-next-executed',
    });
    await runJob({ ...next.job, attemptsMade: 0, opts: { attempts: 1 } });

    const task = taskOfCall(1);
    expect(task?.resumeSessionId).toBeUndefined();
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

    await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

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
    await runJob({ ...next.job, attemptsMade: 0, opts: { attempts: 1 } });

    const task = taskOfCall(1);
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

      await runJob({ ...fixture.job, attemptsMade: 0, opts: { attempts: 1 } });

      expect(await conversationSession(fixture.conversationId)).toBe(`sdk-private-${status}`);
    },
  );
});
