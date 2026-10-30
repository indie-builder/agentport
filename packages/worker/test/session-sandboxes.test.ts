import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChatEvent, ResolvedRuntimeEnvironment, SandboxInputCommand } from '@agentport/shared';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Sandbox,
  SandboxCleanupError,
  type SandboxCreateOptions,
  type SandboxProvider,
} from '../src/sandbox/provider.js';

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  input = '';

  constructor() {
    super();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', (chunk: string) => {
      this.input += chunk;
    });
    this.stdin.on('error', () => undefined);
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): boolean {
    this.signalCode = signal;
    this.emit('close', null, signal);
    return true;
  }
}

interface FakeSandbox extends Sandbox {
  child: FakeChild;
}

interface HeldCreate {
  options: SandboxCreateOptions;
  resolve(): void;
  reject(error: Error): void;
  removeAbort(): void;
}

class FakeProvider implements SandboxProvider {
  readonly creates: SandboxCreateOptions[] = [];
  readonly sandboxes: FakeSandbox[] = [];
  readonly destroyed: string[] = [];
  readonly failing = new Set<string>();
  holdCreate = false;
  holdDestroy = false;
  holdReady = false;
  ignoreAbort = false;
  held: HeldCreate[] = [];
  destroyWaiters: Array<{ resolve(): void; reject(error: Error): void }> = [];
  private count = 0;

  async create(options: SandboxCreateOptions): Promise<Sandbox> {
    this.creates.push(options);
    if (this.holdCreate) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          if (this.ignoreAbort) resolve();
          else reject(abortError());
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
        const held: HeldCreate = {
          options,
          resolve: () => {
            options.signal?.removeEventListener('abort', onAbort);
            resolve();
          },
          reject,
          removeAbort: () => options.signal?.removeEventListener('abort', onAbort),
        };
        this.held.push(held);
        if (options.signal?.aborted === true) onAbort();
      });
    } else if (options.signal?.aborted === true) {
      throw abortError();
    }

    const count = ++this.count;
    const child = new FakeChild();
    const sandbox: FakeSandbox = { id: `sandbox-${count}`, child };
    this.sandboxes.push(sandbox);
    // acquire 会在 create 返回后挂 stdout 监听，ready 放到下一轮宏任务。
    if (!this.holdReady) setTimeout(() => child.stdout.write(line({ type: 'ready' })), 0);
    return sandbox;
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    await this.destroyById(sandbox.id);
    (sandbox as FakeSandbox).child.emit('close', 0, 'SIGTERM');
  }

  async destroyById(id: string): Promise<void> {
    this.destroyed.push(id);
    if (this.failing.has(id)) throw new Error(`cleanup failed for ${id}`);
    if (this.holdDestroy) {
      await new Promise<void>((resolve, reject) => {
        this.destroyWaiters.push({ resolve, reject });
      });
    }
  }

  releaseCreate(): void {
    this.held.shift()?.resolve();
  }

  releaseDestroy(): void {
    this.destroyWaiters.shift()?.resolve();
  }

  rejectDestroy(error: Error): void {
    this.destroyWaiters.shift()?.reject(error);
  }

  childOf(sandboxId: string): FakeChild {
    const sandbox = this.sandboxes.find((item) => item.id === sandboxId);
    if (sandbox === undefined) throw new Error(`unknown sandbox ${sandboxId}`);
    return sandbox.child;
  }
}

function spec(overrides: Partial<Parameters<typeof baseSpec>[0]> = {}) {
  return { ...baseSpec(), ...overrides };
}

function baseSpec() {
  return {
    agentId: 'agent_1',
    conversationId: 'conv_1',
    runtimeEnvironmentId: null,
    workspaceDir: '/host/workspace',
    outputsDir: '/host/outputs',
    inputsDir: '/host/inputs',
    memoryDir: '/host/memory',
    sessionsDir: '/host/sessions',
    personalDir: '/host/user',
  };
}

function runtime(versionId: string, imageId: string): ResolvedRuntimeEnvironment {
  return {
    environmentId: 'env_1',
    environmentName: '默认环境',
    versionId,
    imageId,
  };
}

function imageId(fill: string): string {
  return `sha256:${fill.repeat(64)}`;
}

function task(runId: string) {
  return {
    prompt: `prompt ${runId}`,
    model: 'claude-test',
    maxTurns: 1,
    maxBudgetUsd: 1,
    userMessageUuid: '00000000-0000-4000-8000-000000000001',
  };
}

async function createManager(
  provider: FakeProvider,
  idleTimeoutMs = 300_000,
  resolve: (environmentId: string | null) => Promise<ResolvedRuntimeEnvironment> = async () =>
    runtime('version_1', imageId('1')),
) {
  const { SessionSandboxes } = await import('../src/sandbox/sessions.js');
  return new SessionSandboxes({
    provider,
    idleTimeoutMs,
    logger: pino({ level: 'silent' }),
    resolveRuntimeEnvironment: resolve,
  });
}

async function acquire(
  sessions: Awaited<ReturnType<typeof createManager>>,
  target: ReturnType<typeof spec>,
  signal?: AbortSignal,
  runId = 'run_1',
) {
  return sessions.acquire(target, signal ?? new AbortController().signal, runId);
}

async function startRun(
  lease: Awaited<ReturnType<typeof acquire>>,
  provider: FakeProvider,
  runId: string,
  events: ChatEvent[] = [],
  stderr: string[] = [],
) {
  const starting = lease.start({
    runId,
    task: task(runId),
    env: { ANTHROPIC_AUTH_TOKEN: 'run-token' },
    onEvent: (event) => events.push(event),
    onStderr: (text) => stderr.push(text),
  });
  const child = provider.childOf(lease.sandboxId);
  await vi.waitFor(() => expect(child.input).toContain('"type":"start"'));
  child.stdout.write(line({ type: 'started', runId }));
  return starting;
}

/**
 * 在旧容器 destroy 确认后、等待中的 acquire 恢复续体前插入第二个 acquire：
 * provider.destroy 的续体先跑完，竞争者的微任务才开始，正好落在交接空档。
 */
function acquireDuringHandoff(
  provider: FakeProvider,
  sessions: Awaited<ReturnType<typeof createManager>>,
  target: ReturnType<typeof spec>,
): Promise<string> {
  return new Promise((resolve) => {
    provider.releaseDestroy();
    void Promise.resolve().then(() => {
      queueMicrotask(() => {
        void acquire(sessions, target).then(
          (lease) => {
            void lease.release({ reuse: false });
            resolve('acquired');
          },
          (error: unknown) =>
            resolve(/busy/i.test(String(error)) ? 'busy' : `failed: ${String(error)}`),
        );
      });
    });
  });
}

function settle(
  child: FakeChild,
  runId: string,
  outcome: { code?: number | null; signal?: string | null; stopped?: boolean; error?: string } = {},
): void {
  child.stdout.write(
    line({
      type: 'settled',
      runId,
      code: outcome.code ?? 0,
      signal: outcome.signal ?? null,
      stopped: outcome.stopped ?? true,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session sandboxes', () => {
  it('reuses one supervisor container for repeated leases in the same conversation', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const target = spec();

    const lease1 = await acquire(sessions, target);
    expect(lease1.sandboxId).toBe('sandbox-1');
    const execution = await startRun(lease1, provider, 'run_1');
    settle(provider.childOf(lease1.sandboxId), 'run_1');
    await expect(execution.done).resolves.toEqual({ state: 'stopped', code: 0, signal: null });
    await lease1.release({ reuse: true });

    const lease2 = await acquire(sessions, target);
    expect(lease2.sandboxId).toBe('sandbox-1');
    expect(provider.creates).toHaveLength(1);
    await lease2.release({ reuse: false });

    expect(provider.destroyed).toEqual(['sandbox-1']);
    await sessions.close();
  });

  it('creates the supervisor with session mounts, a clean env, and an init process', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const target = spec();

    const lease = await acquire(sessions, target);
    const create = provider.creates[0];
    expect(create).toBeDefined();
    expect(create?.entrypoint).toBe('node');
    expect(create?.command).toEqual(['dist/session-supervisor.js']);
    expect(create?.workspaceDir).toBe('/host/workspace');
    expect(create?.env).toEqual({});
    expect(create?.init).toBe(true);
    expect(create?.name).toMatch(/^pace-session-[0-9a-f]+$/);
    expect(create?.extraMounts).toEqual([
      { hostPath: '/host/outputs', containerPath: '/mnt/outputs' },
      { hostPath: '/host/inputs', containerPath: '/mnt/inputs', readonly: true },
      { hostPath: '/host/memory', containerPath: '/mnt/agent-memory' },
      { hostPath: '/host/sessions', containerPath: '/home/node/.claude' },
      { hostPath: '/host/user', containerPath: '/mnt/user', readonly: true },
    ]);

    await lease.release({ reuse: false });
    await sessions.close();
  });

  it('mounts every child memory directory rw under the project memory root', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const target = spec({
      subAgentMemoryDirs: [
        { slug: 'alpha', memoryDir: '/host/memory-alpha' },
        { slug: 'beta', memoryDir: '/host/memory-beta' },
      ],
    });

    const lease = await acquire(sessions, target);
    expect(provider.creates[0]?.extraMounts).toEqual(
      expect.arrayContaining([
        { hostPath: '/host/memory-alpha', containerPath: '/workspace/.claude/agent-memory/alpha' },
        { hostPath: '/host/memory-beta', containerPath: '/workspace/.claude/agent-memory/beta' },
      ]),
    );

    await lease.release({ reuse: false });
    await sessions.close();
  });

  it('rebuilds when child memory bindings start, stop, or move', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const withChild = (memoryDir: string) =>
      spec({ subAgentMemoryDirs: [{ slug: 'child', memoryDir }] });

    const first = await acquire(sessions, spec());
    await first.release({ reuse: true });

    const started = await acquire(sessions, withChild('/host/child'));
    expect(started.sandboxId).toBe('sandbox-2');
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await started.release({ reuse: true });

    // 绑定不变时空闲容器按原规格复用。
    const reused = await acquire(sessions, withChild('/host/child'));
    expect(reused.sandboxId).toBe('sandbox-2');
    expect(provider.creates).toHaveLength(2);
    await reused.release({ reuse: true });

    const moved = await acquire(sessions, withChild('/host/child-2'));
    expect(moved.sandboxId).toBe('sandbox-3');
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-2']);
    await moved.release({ reuse: true });

    const stopped = await acquire(sessions, spec());
    expect(stopped.sandboxId).toBe('sandbox-4');
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-2', 'sandbox-3']);
    await stopped.release({ reuse: false });
    await sessions.close();
  });

  it('isolates different conversations and rejects concurrent writers for one conversation', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);

    const first = await acquire(sessions, spec());
    const second = await acquire(sessions, spec({ conversationId: 'conv_2' }));
    expect(first.sandboxId).not.toBe(second.sandboxId);
    await expect(acquire(sessions, spec())).rejects.toThrow(/busy/i);
    await expect(acquire(sessions, spec({ agentId: 'agent_2' }))).rejects.toThrow(/agent_1/);

    await first.release({ reuse: false });
    await second.release({ reuse: false });
    await sessions.close();
  });

  it('rebuilds the container when the bound environment or a session mount changes', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);

    const first = await acquire(sessions, spec());
    await first.release({ reuse: true });
    const changed = await acquire(sessions, spec({ runtimeEnvironmentId: 'env_2' }));
    expect(changed.sandboxId).toBe('sandbox-2');
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await changed.release({ reuse: true });

    const moved = await acquire(
      sessions,
      spec({
        runtimeEnvironmentId: 'env_2',
        memoryDir: '/host/m2',
        personalDir: '/host/user-2',
      }),
    );
    expect(moved.sandboxId).toBe('sandbox-3');
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-2']);
    await moved.release({ reuse: false });
    await sessions.close();
  });

  it('keeps the live container and its recorded identity across publish and rollback', async () => {
    const provider = new FakeProvider();
    const online = runtime('version_1', imageId('1'));
    const calls: Array<string | null> = [];
    const sessions = await createManager(provider, 300_000, async (environmentId) => {
      calls.push(environmentId);
      return { ...online };
    });

    const first = await acquire(sessions, spec());
    expect(first.runtimeEnvironment).toEqual(runtime('version_1', imageId('1')));
    expect(provider.creates[0]?.image).toBe(imageId('1'));
    await first.release({ reuse: true });

    // 发布新版本：存活容器不重建，lease 仍报告实际旧版本。
    online.versionId = 'version_2';
    online.imageId = imageId('2');
    const second = await acquire(sessions, spec());
    expect(provider.creates).toHaveLength(1);
    expect(second.sandboxId).toBe('sandbox-1');
    expect(second.runtimeEnvironment).toEqual(runtime('version_1', imageId('1')));
    expect(calls).toEqual([null]);

    // 回退到旧版本后容器消亡：下一次真实创建采用当时的线上版本。
    online.versionId = 'version_1';
    online.imageId = imageId('1');
    await second.release({ reuse: false });
    const third = await acquire(sessions, spec());
    expect(provider.creates).toHaveLength(2);
    expect(provider.creates[1]?.image).toBe(imageId('1'));
    expect(third.runtimeEnvironment).toEqual(runtime('version_1', imageId('1')));
    expect(calls).toEqual([null, null]);

    await third.release({ reuse: false });
    await sessions.close();
  });

  it('uses the current online version when a dead container is recreated', async () => {
    const provider = new FakeProvider();
    const online = runtime('version_1', imageId('1'));
    const sessions = await createManager(provider, 300_000, async () => ({ ...online }));

    const first = await acquire(sessions, spec());
    await first.release({ reuse: true });
    provider.childOf(first.sandboxId).emit('close', 1, null);
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1']));

    // 容器已经消亡：下一次 acquire 是真实创建，必须读当时的线上版本。
    online.versionId = 'version_2';
    online.imageId = imageId('2');
    const second = await acquire(sessions, spec());

    expect(second.sandboxId).toBe('sandbox-2');
    expect(provider.creates).toHaveLength(2);
    expect(provider.creates[1]?.image).toBe(imageId('2'));
    expect(second.runtimeEnvironment).toEqual(runtime('version_2', imageId('2')));
    await second.release({ reuse: false });
    await sessions.close();
  });

  it('fails clearly when the environment has no online version and creates nothing', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 300_000, async () => {
      throw new Error('平台默认运行环境还没有可用的线上版本，无法创建沙盒');
    });

    await expect(acquire(sessions, spec())).rejects.toThrow(/没有可用的线上版本/);
    expect(provider.creates).toEqual([]);
    await sessions.close();
  });

  it('reclaims an idle container after the idle timeout', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 5 * 60_000);
    const lease = await acquire(sessions, spec());

    vi.useFakeTimers();
    await lease.release({ reuse: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(provider.destroyed).toEqual(['sandbox-1']);
    await vi.runOnlyPendingTimersAsync();
    await sessions.close();
  });

  it('never reclaims a busy lease and starts counting only after release', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 1_000);
    const lease = await acquire(sessions, spec());
    await startRun(lease, provider, 'run_1');

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(provider.destroyed).toEqual([]);

    settle(provider.childOf(lease.sandboxId), 'run_1');
    await lease.release({ reuse: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.destroyed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await sessions.close();
  });

  it('cancels the idle timer when the conversation is acquired again', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 1_000);
    const first = await acquire(sessions, spec());

    vi.useFakeTimers();
    await first.release({ reuse: true });
    const second = await acquire(sessions, spec());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.destroyed).toEqual([]);
    expect(provider.creates).toHaveLength(1);

    await second.release({ reuse: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.destroyed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await sessions.close();
  });

  it('routes events and stderr per run and never forwards control frames as chat events', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const events: ChatEvent[] = [];
    const stderr: string[] = [];
    const execution = await startRun(lease, provider, 'run_1', events, stderr);
    const child = provider.childOf(lease.sandboxId);

    child.stdout.write(line({ type: 'ready' }));
    child.stdout.write(
      line({ type: 'event', runId: 'run_1', event: { type: 'error', message: 'a' } }),
    );
    child.stdout.write(line({ type: 'stderr', runId: 'run_1', text: 'warn\n' }));
    child.stdout.write(
      line({ type: 'event', runId: 'run_2', event: { type: 'error', message: 'cross' } }),
    );
    settle(child, 'run_1');

    await expect(execution.done).resolves.toEqual({ state: 'stopped', code: 0, signal: null });
    expect(events).toEqual([{ type: 'error', message: 'a' }]);
    expect(stderr).toEqual(['warn\n']);

    // 上一轮的迟到帧不能进入下一轮回调。
    await lease.release({ reuse: true });
    const next = await acquire(sessions, spec());
    const nextEvents: ChatEvent[] = [];
    await startRun(next, provider, 'run_2', nextEvents);
    child.stdout.write(
      line({ type: 'event', runId: 'run_1', event: { type: 'error', message: 'late' } }),
    );
    child.stdout.write(
      line({ type: 'settled', runId: 'run_1', code: 0, signal: null, stopped: true }),
    );
    child.stdout.write(
      line({ type: 'event', runId: 'run_2', event: { type: 'error', message: 'fresh' } }),
    );
    await vi.waitFor(() => expect(nextEvents).toEqual([{ type: 'error', message: 'fresh' }]));
    settle(child, 'run_2');
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('resolves start only after the supervisor acknowledges it', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const child = provider.childOf(lease.sandboxId);
    let resolved = false;
    const starting = lease
      .start({
        runId: 'run_1',
        task: task('run_1'),
        env: {},
        onEvent: () => undefined,
        onStderr: () => undefined,
      })
      .then((execution) => {
        resolved = true;
        return execution;
      });

    await vi.waitFor(() => expect(child.input).toContain('"type":"start"'));
    await Promise.resolve();
    expect(resolved).toBe(false);

    child.stdout.write(line({ type: 'started', runId: 'run_1' }));
    const execution = await starting;
    expect(resolved).toBe(true);

    const command: SandboxInputCommand = {
      type: 'question_response',
      requestId: 'q1',
      response: { answers: {} },
    };
    execution.send(command);
    await vi.waitFor(() => expect(child.input).toContain('"type":"input","runId":"run_1"'));

    settle(child, 'run_1');
    await execution.done;
    await lease.release({ reuse: false });
    await sessions.close();
  });

  it('rejects start when the supervisor reports a rejected frame', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const child = provider.childOf(lease.sandboxId);
    const starting = lease.start({
      runId: 'run_1',
      task: task('run_1'),
      env: {},
      onEvent: () => undefined,
      onStderr: () => undefined,
    });
    await vi.waitFor(() => expect(child.input).toContain('"type":"start"'));
    child.stdout.write(
      line({ type: 'rejected', runId: 'run_1', code: 'SPAWN_FAILED', message: 'no runner' }),
    );

    await expect(starting).rejects.toMatchObject({ code: 'SPAWN_FAILED', message: 'no runner' });
    await lease.release({ reuse: false });
    await sessions.close();
  });

  it('marks the run unconfirmed when the supervisor process exits before settling', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const execution = await startRun(lease, provider, 'run_1');

    provider.childOf(lease.sandboxId).emit('close', 1, null);

    await expect(execution.done).resolves.toMatchObject({
      state: 'unconfirmed',
      error: expect.stringContaining('exited'),
    });
    await lease.release({ reuse: false });
    await sessions.close();
  });

  it('returns the supervisor cancel acknowledgement when it arrives in time', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const execution = await startRun(lease, provider, 'run_1');
    const child = provider.childOf(lease.sandboxId);

    const cancelling = execution.cancel();
    await vi.waitFor(() => expect(child.input).toContain('"type":"cancel","runId":"run_1"'));
    settle(child, 'run_1', { signal: 'SIGTERM' });

    await expect(cancelling).resolves.toEqual({
      state: 'stopped',
      code: 0,
      signal: 'SIGTERM',
    });
    await expect(execution.done).resolves.toEqual({
      state: 'stopped',
      code: 0,
      signal: 'SIGTERM',
    });
    await lease.release({ reuse: true });
    await sessions.close();
  });

  it('gives up after the cancel grace and never waits forever', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const execution = await startRun(lease, provider, 'run_1');
    const child = provider.childOf(lease.sandboxId);

    vi.useFakeTimers();
    let settled: unknown;
    const cancelling = execution.cancel().then((value) => {
      settled = value;
      return value;
    });
    await vi.waitFor(() => expect(child.input).toContain('"type":"cancel"'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(cancelling).resolves.toMatchObject({
      state: 'unconfirmed',
      error: expect.stringContaining('cancel'),
    });
    settle(child, 'run_1');
    await expect(execution.done).resolves.toMatchObject({ state: 'unconfirmed' });

    await lease.release({ reuse: false });
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await sessions.close();
  });

  it('waits for an in-flight idle cleanup instead of reporting busy', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 1_000);
    const lease = await acquire(sessions, spec());

    vi.useFakeTimers();
    provider.holdDestroy = true;
    await lease.release({ reuse: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(provider.destroyed).toEqual(['sandbox-1']);

    const acquiring = acquire(sessions, spec());
    await expect(acquire(sessions, spec())).rejects.toThrow(/busy/i);
    let settled = false;
    void acquiring.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    provider.releaseDestroy();
    vi.useRealTimers();
    const next = await acquiring;
    expect(next.sandboxId).toBe('sandbox-2');
    provider.holdDestroy = false;
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('destroys the container when the supervisor exits while idle, not just forgets it', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    await lease.release({ reuse: true });
    provider.holdDestroy = true;

    provider.childOf('sandbox-1').emit('close', 0, null);
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1']));

    const acquiring = acquire(sessions, spec());
    let settled = false;
    void acquiring.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    provider.releaseDestroy();
    const next = await acquiring;
    expect(next.sandboxId).toBe('sandbox-2');
    provider.holdDestroy = false;
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('retries a failed idle-exit cleanup from acquisition and again from close', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    await lease.release({ reuse: true });

    provider.failing.add('sandbox-1');
    provider.childOf('sandbox-1').emit('close', 1, null);

    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1']));
    // 等 idle-exit 的失败销毁收口；acquire 与仍在收口的 destroy 并发时只 join 那一轮。
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(acquire(sessions, spec())).rejects.toThrow(/cleanup failed for sandbox-1/);
    expect(provider.creates).toHaveLength(1);

    provider.failing.delete('sandbox-1');
    await expect(sessions.close()).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1', 'sandbox-1']);
  });

  it('destroys instead of idling when released before the run settled', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const execution = await startRun(lease, provider, 'run_1');

    await lease.release({ reuse: true });

    expect(provider.destroyed).toEqual(['sandbox-1']);
    await expect(execution.done).resolves.toMatchObject({ state: 'unconfirmed' });
    await sessions.close();
  });

  it('aborts an acquire while the container is being created', async () => {
    const provider = new FakeProvider();
    provider.holdCreate = true;
    const sessions = await createManager(provider);
    const controller = new AbortController();

    const acquiring = acquire(sessions, spec(), controller.signal);
    await vi.waitFor(() => expect(provider.held).toHaveLength(1));
    controller.abort();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.sandboxes).toHaveLength(0);
    await sessions.close();
  });

  it('destroys a container that arrives after the acquire was cancelled', async () => {
    const provider = new FakeProvider();
    provider.holdCreate = true;
    provider.ignoreAbort = true;
    const sessions = await createManager(provider);
    const controller = new AbortController();

    const acquiring = acquire(sessions, spec(), controller.signal);
    await vi.waitFor(() => expect(provider.held).toHaveLength(1));
    controller.abort();
    provider.releaseCreate();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await sessions.close();
  });

  it('aborts a ready wait through the caller signal and destroys the container', async () => {
    const provider = new FakeProvider();
    provider.holdReady = true;
    const sessions = await createManager(provider);

    // 先挂断言再等容器出现：调用方 20ms 超时可能早于 waitFor 的首次检查，
    // 延迟挂载会让已拒绝的 acquire 短暂成为 unhandled rejection。
    const acquiring = expect(
      acquire(sessions, spec(), AbortSignal.timeout(20)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(provider.sandboxes).toHaveLength(1));

    await acquiring;
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await expect(sessions.close()).resolves.toBeUndefined();
  });

  it('closes every active and idle container and rejects new acquisitions', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);

    const active = await acquire(sessions, spec());
    const execution = await startRun(active, provider, 'run_1');
    const idle = await acquire(sessions, spec({ conversationId: 'conv_2' }));
    await idle.release({ reuse: true });

    await sessions.close();

    expect(provider.destroyed.sort()).toEqual(['sandbox-1', 'sandbox-2']);
    await expect(execution.done).resolves.toMatchObject({ state: 'unconfirmed' });
    await expect(acquire(sessions, spec({ conversationId: 'conv_3' }))).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('cleans up a late-created container when close wins the creation race', async () => {
    const provider = new FakeProvider();
    provider.holdCreate = true;
    provider.ignoreAbort = true;
    const sessions = await createManager(provider);

    const acquiring = acquire(sessions, spec());
    await vi.waitFor(() => expect(provider.held).toHaveLength(1));
    const closing = sessions.close();
    provider.releaseCreate();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    await expect(closing).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual(['sandbox-1']);
  });

  it('blocks new containers after a failed cleanup and reports it from release and close', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 1_000);
    const lease = await acquire(sessions, spec());

    vi.useFakeTimers();
    provider.failing.add(lease.sandboxId);
    await lease.release({ reuse: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(acquire(sessions, spec())).rejects.toThrow(/cleanup failed for sandbox-1/);
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']);
    expect(provider.creates).toHaveLength(1);

    provider.failing.delete(lease.sandboxId);
    await expect(sessions.close()).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1', 'sandbox-1']);
  });

  it('rebuilds the session once the broken container can finally be destroyed', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);
    expect(provider.creates).toHaveLength(1);

    provider.failing.delete(lease.sandboxId);
    const next = await acquire(sessions, spec());

    // 先销毁旧容器再创建新环境，不并发写同一批宿主目录。
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']);
    expect(provider.creates).toHaveLength(2);
    expect(next.sandboxId).toBe('sandbox-2');
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('retries a broken destroy through cleanup and coalesces concurrent recovery', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const sandboxId = lease.sandboxId;

    provider.failing.add(sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(
      `cleanup failed for ${sandboxId}`,
    );
    // release 缓存了第一次失败的 Promise，重复调用不会重新尝试。
    await expect(lease.release({ reuse: false })).rejects.toThrow(
      `cleanup failed for ${sandboxId}`,
    );
    expect(provider.destroyed).toEqual([sandboxId]);

    provider.failing.delete(sandboxId);
    provider.holdDestroy = true;
    const first = sessions.cleanup('conv_1', sandboxId, 'run_1');
    const second = sessions.cleanup('conv_1', sandboxId, 'run_1');
    await vi.waitFor(() => expect(provider.destroyed).toEqual([sandboxId, sandboxId]));
    provider.releaseDestroy();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    // 两次并发 cleanup 共用同一轮销毁，没有重复删除。
    expect(provider.destroyed).toEqual([sandboxId, sandboxId]);

    provider.holdDestroy = false;
    const next = await acquire(sessions, spec());
    expect(next.sandboxId).toBe('sandbox-2');
    expect(provider.destroyed).toEqual([sandboxId, sandboxId]);
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('cleans up by container id when the manager has no entry for it', async () => {
    const provider = new FakeProvider();
    const oldManager = await createManager(provider);
    const lease = await acquire(oldManager, spec());
    const sandboxId = lease.sandboxId;

    // 模拟 worker 重启：新 manager 没有该会话条目，只能按容器名删除。
    const restarted = await createManager(provider);
    await expect(restarted.cleanup('conv_1', sandboxId, 'run_1')).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual([sandboxId]);

    // 没有条目也不能把删除失败当成已清理。
    provider.failing.add(sandboxId);
    await expect(restarted.cleanup('conv_1', sandboxId, 'run_1')).rejects.toThrow(
      `cleanup failed for ${sandboxId}`,
    );
    provider.failing.delete(sandboxId);

    await lease.release({ reuse: false });
    expect(provider.destroyed).toEqual([sandboxId, sandboxId, sandboxId]);
    await restarted.close();
    await oldManager.close();
  });

  it('rejects cleanup for the old run while a new lease holds the container before start', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);

    const first = await acquire(sessions, spec(), undefined, 'run_1');
    const sandboxId = first.sandboxId;
    await first.release({ reuse: true });

    const second = await acquire(sessions, spec(), undefined, 'run_2');
    expect(second.sandboxId).toBe(sandboxId);
    // 新 lease 已独占容器但还没 start：旧 run 的清理不得销毁它。
    await expect(sessions.cleanup('conv_1', sandboxId, 'run_1')).rejects.toThrow(/run_2/);
    expect(provider.destroyed).toEqual([]);

    await second.release({ reuse: false });
    expect(provider.destroyed).toEqual([sandboxId]);
    await sessions.close();
  });

  it('reports the sandbox id when a late-created container cannot be destroyed', async () => {
    const provider = new FakeProvider();
    provider.holdCreate = true;
    provider.ignoreAbort = true;
    const sessions = await createManager(provider);
    const controller = new AbortController();

    const acquiring = acquire(sessions, spec(), controller.signal);
    await vi.waitFor(() => expect(provider.held).toHaveLength(1));
    provider.failing.add('sandbox-1');
    controller.abort();
    provider.releaseCreate();

    await expect(acquiring).rejects.toMatchObject({
      name: 'SandboxCleanupError',
      sandboxId: 'sandbox-1',
    });
    provider.failing.delete('sandbox-1');
    await expect(sessions.close()).resolves.toBeUndefined();
  });

  it('reports the sandbox id when a failed ready wait cannot destroy the container', async () => {
    const provider = new FakeProvider();
    provider.holdReady = true;
    const sessions = await createManager(provider);
    const controller = new AbortController();

    const acquiring = acquire(sessions, spec(), controller.signal);
    await vi.waitFor(() => expect(provider.sandboxes).toHaveLength(1));
    provider.failing.add('sandbox-1');
    controller.abort();

    await expect(acquiring).rejects.toMatchObject({
      name: 'SandboxCleanupError',
      sandboxId: 'sandbox-1',
    });
    expect(provider.destroyed).toEqual(['sandbox-1']);
    provider.failing.delete('sandbox-1');
    await expect(sessions.close()).resolves.toBeUndefined();
  });

  it('reports the sandbox id when replacing the container cannot destroy the old one', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const sandboxId = lease.sandboxId;
    await lease.release({ reuse: true });

    provider.failing.add(sandboxId);
    await expect(
      acquire(sessions, spec({ runtimeEnvironmentId: 'env_2' }), undefined, 'run_2'),
    ).rejects.toMatchObject({ name: 'SandboxCleanupError', sandboxId });
    expect(provider.creates).toHaveLength(1);

    provider.failing.delete(sandboxId);
    await expect(sessions.close()).resolves.toBeUndefined();
  });

  it('reports the sandbox id when a broken retry fails to destroy the container again', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);

    const failure = await acquire(sessions, spec(), undefined, 'run_2').then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxCleanupError);
    expect((failure as SandboxCleanupError).sandboxId).toBe('sandbox-1');
    // 二次失败仍保留 provider 的原始错误，上层可按 id 继续清理。
    expect(((failure as SandboxCleanupError).cause as Error).message).toBe(
      'cleanup failed for sandbox-1',
    );
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']);
    expect(provider.creates).toHaveLength(1);

    provider.failing.delete(lease.sandboxId);
    await expect(sessions.close()).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1', 'sandbox-1']);
  });

  it('reports the sandbox id when a concurrent destroy fails while acquiring', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 10);
    const lease = await acquire(sessions, spec());
    provider.holdDestroy = true;
    await lease.release({ reuse: true });
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1']));

    const acquiring = acquire(sessions, spec(), undefined, 'run_2');
    // 等待中的 acquire 占住 entry，第三个请求仍按 busy 拒绝，不带别的 run 的错误 id。
    await expect(acquire(sessions, spec(), undefined, 'run_3')).rejects.toThrow(/busy/i);

    provider.rejectDestroy(new Error('destroy failed while held'));

    const failure = await acquiring.then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SandboxCleanupError);
    expect((failure as SandboxCleanupError).sandboxId).toBe('sandbox-1');
    expect(((failure as SandboxCleanupError).cause as Error).message).toBe(
      'destroy failed while held',
    );

    provider.holdDestroy = false;
    await expect(sessions.close()).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']);
  });

  it('cleans an older container by id without destroying the current one', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const first = await acquire(sessions, spec());
    const oldId = first.sandboxId;
    await first.release({ reuse: false });

    const current = await acquire(sessions, spec());
    const currentId = current.sandboxId;
    expect(currentId).not.toBe(oldId);

    await sessions.cleanup('conv_1', oldId, 'run_1');
    expect(provider.destroyed).toEqual([oldId, oldId]);

    // 当前条目仍被跟踪：释放后复用的还是新容器，没有被旧 id 的清理误杀。
    await current.release({ reuse: true });
    const reused = await acquire(sessions, spec());
    expect(reused.sandboxId).toBe(currentId);
    expect(provider.creates).toHaveLength(2);
    await reused.release({ reuse: false });
    await sessions.close();
  });

  it('keeps refusing replacement while the broken cleanup still fails and retries once per acquire', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);

    await expect(acquire(sessions, spec())).rejects.toThrow(/cleanup failed for sandbox-1/);
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']);
    expect(provider.creates).toHaveLength(1);
    expect(provider.sandboxes).toHaveLength(1);

    // 失败记录保留；每次 acquire 只重试一轮，不无限循环。
    await expect(acquire(sessions, spec())).rejects.toThrow(/cleanup failed for sandbox-1/);
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1', 'sandbox-1']);
    expect(provider.creates).toHaveLength(1);

    provider.failing.delete(lease.sandboxId);
    await expect(sessions.close()).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1', 'sandbox-1', 'sandbox-1']);
  });

  it('lets only one acquire retry a broken cleanup and create the replacement', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);
    provider.failing.delete(lease.sandboxId);

    provider.holdDestroy = true;
    const first = acquire(sessions, spec());
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']));
    await expect(acquire(sessions, spec())).rejects.toThrow(/busy/i);

    provider.releaseDestroy();
    const next = await first;
    expect(next.sandboxId).toBe('sandbox-2');
    expect(provider.creates).toHaveLength(2);
    provider.holdDestroy = false;
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('does not let a second acquire replace the recovery container for a broken entry', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);
    provider.failing.delete(lease.sandboxId);

    provider.holdDestroy = true;
    const replacement = acquire(sessions, spec());
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']));

    const competing = acquireDuringHandoff(provider, sessions, spec());
    const next = await replacement;
    expect(provider.creates).toHaveLength(2);
    expect(await competing).toBe('busy');
    expect(next.sandboxId).toBe('sandbox-2');
    provider.holdDestroy = false;
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('does not let a second acquire replace the container during a spec-change destroy', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    await lease.release({ reuse: true });

    provider.holdDestroy = true;
    const changed = spec({ runtimeEnvironmentId: 'env_2' });
    const replacement = acquire(sessions, changed);
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1']));

    const competing = acquireDuringHandoff(provider, sessions, changed);
    const next = await replacement;
    expect(provider.creates).toHaveLength(2);
    expect(await competing).toBe('busy');
    expect(next.sandboxId).toBe('sandbox-2');
    provider.holdDestroy = false;
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('does not let a second acquire replace the container while joining an idle destroy', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider, 10);
    const lease = await acquire(sessions, spec());
    provider.holdDestroy = true;
    await lease.release({ reuse: true });
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1']));

    const replacement = acquire(sessions, spec());
    const competing = acquireDuringHandoff(provider, sessions, spec());
    const next = await replacement;
    expect(provider.creates).toHaveLength(2);
    expect(await competing).toBe('busy');
    expect(next.sandboxId).toBe('sandbox-2');
    provider.holdDestroy = false;
    await next.release({ reuse: false });
    await sessions.close();
  });

  it('does not create a replacement when close begins during the recovery destroy', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);
    provider.failing.delete(lease.sandboxId);

    provider.holdDestroy = true;
    const acquiring = acquire(sessions, spec());
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']));
    const closing = sessions.close();
    provider.releaseDestroy();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    await expect(closing).resolves.toBeUndefined();
    expect(provider.creates).toHaveLength(1);
  });

  it('does not create a replacement when the acquire is cancelled during recovery', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);
    await expect(lease.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);
    provider.failing.delete(lease.sandboxId);

    provider.holdDestroy = true;
    const controller = new AbortController();
    const acquiring = acquire(sessions, spec(), controller.signal);
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']));
    controller.abort();
    provider.releaseDestroy();

    await expect(acquiring).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.creates).toHaveLength(1);
    provider.holdDestroy = false;
    await sessions.close();
  });

  it('throws from release(false) when cleanup fails and aggregates close failures', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const first = await acquire(sessions, spec());
    const second = await acquire(sessions, spec({ conversationId: 'conv_2' }));
    provider.failing.add(first.sandboxId);
    provider.failing.add(second.sandboxId);

    await expect(first.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-1/);
    await expect(second.release({ reuse: false })).rejects.toThrow(/cleanup failed for sandbox-2/);
    await expect(sessions.close()).rejects.toMatchObject({
      name: 'AggregateError',
      message: expect.stringContaining('sandbox-1'),
    });
    expect(provider.destroyed.sort()).toEqual(['sandbox-1', 'sandbox-1', 'sandbox-2', 'sandbox-2']);
  });

  it('shares one in-flight release so a repeated call cannot claim success early', async () => {
    const provider = new FakeProvider();
    provider.holdDestroy = true;
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());

    const first = lease.release({ reuse: false });
    const second = lease.release({ reuse: false });
    await vi.waitFor(() => expect(provider.destroyed).toEqual(['sandbox-1']));
    const settled = [first, second].map((promise) => {
      const state = { done: false };
      void promise.then(
        () => {
          state.done = true;
        },
        () => {
          state.done = true;
        },
      );
      return state;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled.map((state) => state.done)).toEqual([false, false]);

    provider.releaseDestroy();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await sessions.close();
  });

  it('rejects every repeated release call when cleanup fails', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    provider.failing.add(lease.sandboxId);

    const first = lease.release({ reuse: false });
    const second = lease.release({ reuse: false });

    await expect(first).rejects.toThrow(/cleanup failed for sandbox-1/);
    await expect(second).rejects.toThrow(/cleanup failed for sandbox-1/);
    expect(provider.destroyed).toEqual(['sandbox-1']);
    await expect(sessions.close()).rejects.toMatchObject({ name: 'AggregateError' });
    expect(provider.destroyed).toEqual(['sandbox-1', 'sandbox-1']);
  });

  it('drops an oversized NDJSON line and keeps parsing the next frame', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const events: ChatEvent[] = [];
    const execution = await startRun(lease, provider, 'run_1', events);
    const child = provider.childOf(lease.sandboxId);

    child.stdout.write(`${'x'.repeat(8 * 1024 * 1024 + 1)}\n`);
    child.stdout.write(
      line({ type: 'event', runId: 'run_1', event: { type: 'error', message: 'kept' } }),
    );
    settle(child, 'run_1');

    await execution.done;
    expect(events).toEqual([{ type: 'error', message: 'kept' }]);
    await lease.release({ reuse: false });
    await sessions.close();
  });

  it('ignores invalid JSON and non-contract frames', async () => {
    const provider = new FakeProvider();
    const sessions = await createManager(provider);
    const lease = await acquire(sessions, spec());
    const events: ChatEvent[] = [];
    const execution = await startRun(lease, provider, 'run_1', events);
    const child = provider.childOf(lease.sandboxId);

    child.stdout.write('not json\n');
    child.stdout.write(line({ type: 'unknown', runId: 'run_1' }));
    child.stdout.write(
      line({ type: 'event', runId: 'run_1', event: { type: 'error', message: 'ok' } }),
    );
    settle(child, 'run_1');

    await execution.done;
    expect(events).toEqual([{ type: 'error', message: 'ok' }]);
    await lease.release({ reuse: false });
    await sessions.close();
  });
});
