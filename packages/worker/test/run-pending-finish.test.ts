import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createDb, newId, repo, schema } from '@agentport/db';
import { type AgentRunJob, runCancelKey, runStreamKey } from '@agentport/shared';
import { type Job, Queue } from 'bullmq';
import { RedisClient } from 'bun';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import {
  createTestAccount,
  expectProblem,
  loginCookie,
  request,
  startApp,
  type TestApp,
} from '../../api/test/helpers.js';
import { loadConfig } from '../src/config.js';
import {
  cleanupSandboxIdOf,
  createLoadAgentPlugins,
  createSandboxEnvFactory,
  denyQueuedRun,
  toEntry,
} from '../src/handlers.js';
import { closeRunnerClient, configureRunnerClient } from '../src/runner-client.js';
import { runAgentJob } from '../src/runs/execute.js';
import { createWorkspaceAssembly } from '../src/runs/workspace-assembly.js';
import type { Sandbox, SandboxCreateOptions, SandboxProvider } from '../src/sandbox/provider.js';
import { SessionSandboxes } from '../src/sandbox/sessions.js';
import { reconcileOrphanedRuns } from '../src/scheduling/reconcile.js';
import { testAccess } from './fixtures/access.js';
import { bunRedisConnection, probeBunRedis } from './fixtures/bun-redis.js';
import { createIsolatedDatabase } from './isolated-db.js';

const { agentOwnership, TEST_BUSINESS_ID, userSubject } = testAccess(import.meta.url);

const isolated = await createIsolatedDatabase('worker_pending_finish');
const redisUrl = process.env.REDIS_URL ?? '';
const ready = isolated !== null && (await probeBunRedis(redisUrl));
if (!ready && isolated) await isolated.close();

interface SupervisorChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  exited: Promise<number>;
  finish(code: number): void;
}

const sandboxState = {
  destroyFailures: 0,
  destroyed: [] as string[],
  child: null as SupervisorChild | null,
  onStarted: null as (() => void) | null,
  startedRuns: [] as string[],
  cancelFrames: 0,
};

class FakeSandboxProvider implements SandboxProvider {
  async create(options: SandboxCreateOptions): Promise<Sandbox> {
    const child = new (class extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      exitCode: number | null = null;
      signalCode: NodeJS.Signals | null = null;
      readonly exited: Promise<number>;
      private settleExited!: (code: number) => void;
      private exitedOnce = false;

      constructor() {
        super();
        this.exited = new Promise<number>((resolve) => {
          this.settleExited = resolve;
        });
      }

      finish(code: number): void {
        if (this.exitedOnce) return;
        this.exitedOnce = true;
        this.exitCode = code;
        this.stdout.end();
        this.stderr.end();
        this.settleExited(code);
      }
    })();
    sandboxState.child = child;
    let buffer = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = JSON.parse(line) as { type: string; runId?: string };
        if (frame.type === 'start' && frame.runId !== undefined) {
          sandboxState.startedRuns.push(frame.runId);
          child.stdout.write(`${JSON.stringify({ type: 'started', runId: frame.runId })}\n`);
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
                  failureKind: 'cancelled',
                  costUsd: 0.25,
                  turns: 2,
                  sessionId: 'sdk-pending',
                  inputTokens: 5,
                  outputTokens: 7,
                },
              })}\n`,
            );
            sandboxState.onStarted?.();
          }, 10);
        }
        if (frame.type === 'cancel') sandboxState.cancelFrames += 1;
        newline = buffer.indexOf('\n');
      }
    });
    setTimeout(() => child.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`), 0);
    return {
      id: options.name ?? 'fake-sandbox',
      child: child as unknown as Sandbox['child'],
    };
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    await this.destroyById(sandbox.id);
  }

  async destroyById(id: string): Promise<void> {
    sandboxState.destroyed.push(id);
    sandboxState.child?.finish(0);
    if (sandboxState.destroyFailures > 0) {
      sandboxState.destroyFailures -= 1;
      throw new Error('docker rm -f failed');
    }
  }
}

describe.skipIf(!ready)('unconfirmed stop handoff', () => {
  const logger = pino({ level: 'silent' });
  let dbHandle: ReturnType<typeof createDb>;
  let db: ReturnType<typeof createDb>['db'];
  let workdir = '';
  let app: TestApp;
  let cookie = '';
  let sessionSandboxes: SessionSandboxes;
  let runDeps: Parameters<typeof runAgentJob>[1];

  const putMemory = (agentId: string, content = 'note') =>
    request(app, {
      method: 'PUT',
      url: `/api/agents/${agentId}/memory/MEMORY.md`,
      headers: { cookie },
      payload: { content },
    });

  const patchAgent = (agentId: string, payload: Record<string, unknown>) =>
    request(app, {
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
      } as unknown as Job,
    };
  }

  async function requestCancel(runId: string): Promise<void> {
    const redis = new RedisClient(redisUrl);
    try {
      await redis.set(runCancelKey(runId), '1', 'EX', 60);
      await redis.publish(runCancelKey(runId), '1');
    } finally {
      redis.close();
    }
  }

  async function readStream(runId: string): Promise<Array<{ type?: string }>> {
    const redis = new RedisClient(redisUrl);
    try {
      const entries = await redis.xrange(runStreamKey(runId), '-', '+');
      return entries.map(([, fields]) => JSON.parse(fields[1] ?? '{}'));
    } finally {
      redis.close();
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

  beforeAll(async () => {
    const databaseUrl = isolated?.url ?? '';
    dbHandle = createDb(databaseUrl);
    db = dbHandle.db;
    workdir = await mkdtemp(join(await realpath(tmpdir()), 'worker-pending-finish-'));
    const config = loadConfig({
      ...process.env,
      DATABASE_URL: databaseUrl,
      WORKSPACES_DIR: workdir,
      HOST_WORKSPACES_DIR: workdir,
    });
    configureRunnerClient(redisUrl, logger);
    sessionSandboxes = new SessionSandboxes({
      provider: new FakeSandboxProvider(),
      idleTimeoutMs: config.SANDBOX_IDLE_TIMEOUT_MS,
      maxActive: config.SANDBOX_MAX_ACTIVE,
      logger,
      resolveRuntimeEnvironment: async () => ({
        environmentId: 'rte_pending',
        environmentName: 'pending environment',
        versionId: 'rtv_pending',
        imageId: `sha256:${'b'.repeat(64)}`,
      }),
    });
    runDeps = {
      db,
      client: dbHandle.client,
      config,
      logger,
      workspacesDir: workdir,
      hostWorkspacesDir: workdir,
      sandboxApiUrl: config.SANDBOX_API_URL,
      sandboxClosing: new AbortController(),
      sessionSandboxes,
      modelProxy: null,
      denyQueuedRun,
      loadAgentPlugins: createLoadAgentPlugins(db, logger),
      writeWorkspace: createWorkspaceAssembly({ db, workspacesDir: workdir, logger }),
      toEntry,
      sandboxEnv: createSandboxEnvFactory(config, null),
      cleanupSandboxIdOf,
    };
    app = await startApp({ WORKSPACES_DIR: workdir, DATABASE_URL: databaseUrl });
    cookie = await loginCookie(app);
    await createTestAccount(app, cookie, {
      businessId: TEST_BUSINESS_ID,
      systemKeys: ['user'],
    });
  });

  afterAll(async () => {
    sandboxState.destroyFailures = 0;
    await sessionSandboxes?.close().catch(() => undefined);
    await closeRunnerClient();
    if (app) await app.close();
    await rm(workdir, { recursive: true, force: true });
    await dbHandle?.client.close().catch(() => undefined);
    await isolated?.close();
  });

  it('publishes the database terminal result when the producer loses its final CAS', async () => {
    sandboxState.destroyFailures = 0;
    const fixture = await createFixture('lost-cas');
    const started = new Promise<void>((resolve) => {
      sandboxState.onStarted = resolve;
    });
    const processing = runAgentJob(fixture.job, runDeps);
    await started;
    await db
      .update(schema.agentRuns)
      .set({
        status: 'failed',
        endedAt: new Date(),
        error: 'external terminal',
        errorKind: 'infra',
        costUsd: '0.7500',
        turns: 9,
      })
      .where(eq(schema.agentRuns.id, fixture.runId));
    sandboxState.child?.stdout.write(
      `${JSON.stringify({
        type: 'settled',
        runId: fixture.runId,
        code: 0,
        signal: null,
        stopped: true,
      })}\n`,
    );
    await expect(processing).resolves.toBeUndefined();
    expect(await runRow(fixture.runId)).toMatchObject({
      status: 'failed',
      error: 'external terminal',
      errorKind: 'infra',
      costUsd: '0.7500',
      turns: 9,
    });
    const finished = (await readStream(fixture.runId)).filter(
      (event) => event.type === 'run_finished',
    );
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      status: 'failed',
      error: 'external terminal',
      failureKind: 'infra',
      costUsd: 0.75,
      turns: 9,
    });
    const audits = await db
      .select({ action: schema.auditLog.action, status: schema.auditLog.status })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.target, fixture.runId));
    expect(audits.filter((row) => row.action === 'agent.run.finished')).toEqual([
      { action: 'agent.run.finished', status: 'error' },
    ]);
  });

  it('keeps the run and its memory occupancy until reconcile confirms cleanup', async () => {
    sandboxState.destroyFailures = 2;
    const fixture = await createFixture('pending');

    const started = new Promise<void>((resolve) => {
      sandboxState.onStarted = resolve;
    });
    const processing = runAgentJob(fixture.job, runDeps);
    await started;
    await requestCancel(fixture.runId);
    await expect(processing).resolves.toBeUndefined();
    expect(sandboxState.cancelFrames).toBe(1);
    expect(sandboxState.destroyed).toHaveLength(1);

    const pending = await runRow(fixture.runId);
    const pendingSnapshot = structuredClone(pending);
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

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (await readStream(fixture.runId)).filter((event) => event.type === 'run_finished'),
    ).toHaveLength(0);

    const audits = await db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.target, fixture.runId));
    expect(audits.map((row) => row.action)).not.toContain('agent.run.finished');

    expectProblem(await putMemory(fixture.childId), 'CONFLICT');
    expectProblem(await patchAgent(fixture.childId, { enabled: false }), 'CONFLICT');
    expectProblem(await patchAgent(fixture.agentId, { subAgentIds: [] }), 'CONFLICT');
    expect((await patchAgent(fixture.agentId, { timeoutMs: 120_000 })).statusCode).toBe(200);

    const cleanup = (input: { runId: string; conversationId: string; sandboxId: string }) =>
      sessionSandboxes.cleanup(input.conversationId, input.sandboxId, input.runId);
    const queueRedis = bunRedisConnection(redisUrl);
    const queue = new Queue<AgentRunJob>(`pending-${randomUUID()}`, {
      connection: queueRedis.connection,
    });

    try {
      sandboxState.destroyFailures = 1;
      expect(
        await reconcileOrphanedRuns(db, logger, 10_000, queue, (input) =>
          cleanup({
            runId: input.runId,
            conversationId: input.conversationId,
            sandboxId: input.sandboxId,
          }),
        ),
      ).toBe(0);
      const stillRunning = await runRow(fixture.runId);
      expect(stillRunning).toMatchObject({ status: 'running', endedAt: null });
      expect(stillRunning?.pendingFinish).toEqual(pendingSnapshot?.pendingFinish);
      expect(
        (await readStream(fixture.runId)).filter((e) => e.type === 'run_finished'),
      ).toHaveLength(0);

      expectProblem(await putMemory(fixture.childId), 'CONFLICT');
      expectProblem(await patchAgent(fixture.childId, { enabled: false }), 'CONFLICT');
      expectProblem(await patchAgent(fixture.agentId, { subAgentIds: [] }), 'CONFLICT');

      expect(
        await reconcileOrphanedRuns(db, logger, 10_000, queue, (input) =>
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
      expect(sandboxState.destroyed.at(-1)).toBe(pendingSnapshot?.sandboxId);

      const finished = (await readStream(fixture.runId)).filter(
        (event) => event.type === 'run_finished',
      );
      expect(finished).toHaveLength(1);
      expect(finished[0]).toEqual(pendingSnapshot?.pendingFinish);

      const reconciled = await db
        .select({ action: schema.auditLog.action, status: schema.auditLog.status })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.target, fixture.runId));
      expect(reconciled.filter((row) => row.action === 'agent.run.reconciled')).toEqual([
        { action: 'agent.run.reconciled', status: 'error' },
      ]);

      const saved = await putMemory(fixture.childId, 'settled memory');
      expect(saved.statusCode, saved.body).toBe(200);
      const stored = await request(app, {
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
      await queueRedis.close();
    }
  }, 20_000);
});
