import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_PLUGINS_QUEUE,
  type NativePluginAction,
  type ResolvedRuntimeEnvironment,
} from '@agentport/shared';
import { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import type { NativePluginsDeps } from '../src/native-plugins.js';
import type { Sandbox, SandboxCreateOptions } from '../src/sandbox/provider.js';
import { bunRedisConnection } from './fixtures/bun-redis.js';
import { waitFor } from './fixtures/native-test.js';

const docker = (() => ({
  createImpl: mock<(options: SandboxCreateOptions) => Promise<Sandbox>>(),
  destroy: mock(async (_sandbox: Sandbox) => undefined),
  destroyAll: mock(async () => undefined),
}))();

const dockerActual = await import('../src/sandbox/docker.js');
mock.module('../src/sandbox/docker.js', () => ({
  ...dockerActual,
  DockerSandboxProvider: class {
    create = docker.createImpl;
    destroy = docker.destroy;
    destroyAll = docker.destroyAll;
  },
}));

const { registerNativePlugins, runNativePluginAction } = await import('../src/native-plugins.js');

let workspacesDir = '';

class FakeChild {
  readonly stdin: { write: (chunk: string) => number; end: () => number };
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<number>;
  signalCode: NodeJS.Signals | number | null = null;
  exitCode: number | null = null;
  private readonly encoder = new TextEncoder();
  private readonly stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  private readonly stderrController!: ReadableStreamDefaultController<Uint8Array>;
  private readonly settle!: (code: number) => void;
  private done = false;

  constructor() {
    this.stdin = { write: () => 0, end: () => 0 };
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stdoutController = controller;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.stderrController = controller;
      },
    });
    this.exited = new Promise<number>((resolve) => {
      this.settle = resolve;
    });
  }

  writeStdout(chunk: string): void {
    this.stdoutController.enqueue(this.encoder.encode(chunk));
  }

  writeStderr(chunk: string): void {
    this.stderrController.enqueue(this.encoder.encode(chunk));
  }

  finish(code: number): void {
    if (this.done) return;
    this.done = true;
    this.exitCode = code;
    this.stdoutController.close();
    this.stderrController.close();
    this.settle(code);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.signalCode = signal;
    this.finish(137);
    return true;
  }
}

interface FakeProvider {
  options: SandboxCreateOptions[];
  destroyed: string[];
  provider: NativePluginsDeps['provider'];
}

function fakeProvider(behavior: () => FakeChild): FakeProvider {
  const options: SandboxCreateOptions[] = [];
  const destroyed: string[] = [];
  return {
    options,
    destroyed,
    provider: {
      create: async (createOptions: SandboxCreateOptions) => {
        options.push(createOptions);
        return { id: 'native-plugin-fake', child: behavior() } as unknown as Sandbox;
      },
      destroy: async (sandbox: Sandbox) => {
        destroyed.push(sandbox.id);
      },
    },
  };
}

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quietLogger,
} as unknown as Logger;

const RUNTIME: ResolvedRuntimeEnvironment = {
  environmentId: 'env_default',
  environmentName: '默认环境',
  versionId: 'ver_default',
  imageId: 'sha256:native-plugin-image',
};

function deps(provider: FakeProvider['provider'], timeoutMs?: number): NativePluginsDeps {
  return {
    provider,
    resolveRuntimeEnvironment: async () => RUNTIME,
    workspacesDir,
    hostWorkspacesDir: workspacesDir,
    logger: quietLogger,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function respondingChild(line: unknown, stderr = ''): FakeChild {
  const child = new FakeChild();
  child.stdin.write = (() => {
    if (stderr) child.writeStderr(stderr);
    child.writeStdout(`${JSON.stringify(line)}\n`);
    child.finish(0);
    return 0;
  }) as typeof child.stdin.write;
  return child;
}

function hangingChild(): FakeChild {
  const child = new FakeChild();
  child.stdin.write = (() => 0) as typeof child.stdin.write;
  return child;
}

const redisUrl = (() => {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  url.pathname = '/1';
  return url.toString();
})();
const queueConnections: Array<ReturnType<typeof bunRedisConnection>> = [];

function config(): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    APP_SECRET_KEY: 'a'.repeat(32),
    WORKSPACES_DIR: workspacesDir,
    REDIS_URL: redisUrl,
    LOG_LEVEL: 'error',
  });
}

async function waitForCreate(): Promise<void> {
  await waitFor(() => expect(docker.createImpl).toHaveBeenCalled(), { timeout: 10_000 });
}

async function enqueueInstall(): Promise<Queue<NativePluginAction>> {
  const redis = bunRedisConnection(redisUrl);
  queueConnections.push(redis);
  const queue = new Queue<NativePluginAction>(NATIVE_PLUGINS_QUEUE, {
    connection: redis.connection,
  });
  await queue.add('install', { action: 'install', marketplace: 'owner/repo', plugin: 'demo' });
  return queue;
}

async function obliterateQueue(): Promise<void> {
  const redis = bunRedisConnection(redisUrl);
  const queue = new Queue<NativePluginAction>(NATIVE_PLUGINS_QUEUE, {
    connection: redis.connection,
  });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    await redis.close();
  }
}

beforeAll(async () => {
  workspacesDir = await mkdtemp(join(tmpdir(), 'agentport-native-plugin-'));
});

afterAll(async () => {
  await Promise.allSettled(queueConnections.map((connection) => connection.close()));
  if (workspacesDir) await rm(workspacesDir, { recursive: true, force: true });
});

describe('runNativePluginAction', () => {
  it('uses the default environment image and creates nothing when it cannot resolve', async () => {
    const fake = fakeProvider(() => respondingChild({ ok: true, installed: [] }));
    const seen: Array<string | null> = [];

    await runNativePluginAction(
      {
        ...deps(fake.provider),
        resolveRuntimeEnvironment: async (environmentId) => {
          seen.push(environmentId);
          return RUNTIME;
        },
      },
      { action: 'list' },
    );
    expect(seen).toEqual([null]);
    expect(fake.options[0]?.image).toBe(RUNTIME.imageId);

    const failed = await runNativePluginAction(
      {
        ...deps(fake.provider),
        resolveRuntimeEnvironment: async () => {
          throw new Error('平台默认运行环境还没有可用的线上版本，无法创建沙盒');
        },
      },
      { action: 'list' },
    );
    expect(failed).toMatchObject({ ok: false });
    expect(failed.ok ? '' : failed.error).toMatch(/没有可用的线上版本/);
    expect(fake.options).toHaveLength(1);
  });

  it('mounts only the cache, uses the action entrypoint and sends one stdin action', async () => {
    const fake = fakeProvider(() =>
      respondingChild({
        ok: true,
        installed: [{ pluginId: 'demo@fixture-market', version: '1.0.0' }],
      }),
    );

    const result = await runNativePluginAction(deps(fake.provider), { action: 'list' });

    expect(result).toEqual({
      ok: true,
      installed: [{ pluginId: 'demo@fixture-market', version: '1.0.0' }],
    });
    const [options] = fake.options;
    expect(options).toMatchObject({
      image: RUNTIME.imageId,
      entrypoint: 'bun',
      command: ['dist/native-plugins.js'],
      env: { HOME: '/tmp', TMPDIR: '/tmp' },
      workspaceDir: join(workspacesDir, 'native-plugin-actions'),
    });
    expect(options?.extraMounts).toEqual([
      {
        hostPath: join(workspacesDir, 'plugin-cache'),
        containerPath: '/mnt/plugin-cache',
      },
    ]);
    expect(options?.signal?.aborted).toBe(false);
    expect(fake.destroyed).toEqual(['native-plugin-fake']);
  });

  it('creates the persistent cache and workspace with owner-only permissions', async () => {
    const fake = fakeProvider(() => respondingChild({ ok: true, installed: [] }));

    await runNativePluginAction(deps(fake.provider), { action: 'list' });

    const cache = await stat(join(workspacesDir, 'plugin-cache'));
    const workspace = await stat(join(workspacesDir, 'native-plugin-actions'));
    expect(cache.mode & 0o777).toBe(0o700);
    expect(workspace.mode & 0o777).toBe(0o700);
  });

  it('forwards read actions verbatim', async () => {
    let task = '';
    const child = new FakeChild();
    child.stdin.write = ((chunk: string) => {
      task = chunk;
      child.writeStdout(
        `${JSON.stringify({ ok: true, plugin: { pluginId: 'demo@fixture-market', version: '1' }, files: [] })}\n`,
      );
      child.finish(0);
      return 0;
    }) as typeof child.stdin.write;
    const fake = fakeProvider(() => child);

    await runNativePluginAction(deps(fake.provider), {
      action: 'read',
      pluginId: 'demo@fixture-market',
    });

    expect(JSON.parse(task)).toEqual({ action: 'read', pluginId: 'demo@fixture-market' });
  });

  it('reports an honest timeout and destroys the sandbox', async () => {
    const fake = fakeProvider(hangingChild);

    const result = await runNativePluginAction(deps(fake.provider, 30), { action: 'list' });

    expect(result).toEqual({ ok: false, error: '沙盒动作超时（30ms）' });
    expect(fake.destroyed).toEqual(['native-plugin-fake']);
    expect(fake.options[0]?.signal?.aborted).toBe(true);
  });

  it('aborts a pending create when the action budget expires', async () => {
    const captured: { signal?: AbortSignal } = {};
    const provider: FakeProvider['provider'] = {
      create: (options) => {
        captured.signal = options.signal;
        return new Promise<Sandbox>(() => undefined);
      },
      destroy: async () => undefined,
    };

    const result = await runNativePluginAction(deps(provider, 30), { action: 'list' });

    expect(result).toEqual({
      ok: false,
      error: '沙盒启动超时（30ms），请检查 Docker 服务与镜像后重试',
    });
    expect(captured.signal?.aborted).toBe(true);
  });

  it('aborts a pending create when the worker closes', async () => {
    const closing = new AbortController();
    const captured: { signal?: AbortSignal } = {};
    const provider: FakeProvider['provider'] = {
      create: (options) => {
        captured.signal = options.signal;
        return new Promise<Sandbox>(() => undefined);
      },
      destroy: async () => undefined,
    };

    const pending = runNativePluginAction(
      { ...deps(provider, 5_000), closing: closing.signal },
      { action: 'list' },
    );
    await waitFor(() => expect(captured.signal).toBeDefined());
    closing.abort();
    const result = await pending;

    expect(result).toEqual({ ok: false, error: 'worker 正在关停，安装已取消' });
    expect(captured.signal?.aborted).toBe(true);
  });

  it('reports worker shutdown when create rejects on the closing signal', async () => {
    const closing = new AbortController();
    let rejectCreate: ((error: Error) => void) | undefined;
    const captured: { signal?: AbortSignal } = {};
    const provider: FakeProvider['provider'] = {
      create: (options) => {
        captured.signal = options.signal;
        return new Promise<Sandbox>((_resolve, reject) => {
          rejectCreate = reject;
        });
      },
      destroy: async () => undefined,
    };
    closing.signal.addEventListener(
      'abort',
      () => rejectCreate?.(new Error('sandbox create aborted')),
      { once: true },
    );

    const pending = runNativePluginAction(
      { ...deps(provider, 10_000), closing: closing.signal },
      { action: 'list' },
    );
    await waitFor(() => expect(rejectCreate).toBeDefined());
    closing.abort();
    const result = await pending;

    expect(result).toEqual({ ok: false, error: 'worker 正在关停，安装已取消' });
    expect(captured.signal?.aborted).toBe(true);
  });

  it('leaves late cleanup to the provider and reports its failure', async () => {
    const child = hangingChild();
    const destroyed: string[] = [];
    const warn = mock();
    const logger = { ...quietLogger, warn } as unknown as Logger;
    const captured: { resolve?: (value: Sandbox) => void } = {};
    const provider: FakeProvider['provider'] = {
      create: () =>
        new Promise<Sandbox>((resolve) => {
          captured.resolve = resolve;
        }),
      destroy: async (sandbox) => {
        destroyed.push(sandbox.id);
        throw new Error('rm failed');
      },
    };

    const result = await runNativePluginAction(
      { ...deps(provider, 30), logger },
      { action: 'list' },
    );
    expect(result).toEqual({
      ok: false,
      error: '沙盒启动超时（30ms），请检查 Docker 服务与镜像后重试',
    });

    captured.resolve?.({ id: 'native-plugin-late', child } as unknown as Sandbox);
    await waitFor(() => expect(destroyed).toEqual(['native-plugin-late']));
    expect(child.signals).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        action: 'list',
        sandboxId: 'native-plugin-late',
      }),
      'native plugin sandbox cleanup failed after timeout',
    );
  });

  it('rejects an invalid result line instead of parsing partial output', async () => {
    const fake = fakeProvider(() => respondingChild({ ok: false, error: '' }));

    const result = await runNativePluginAction(deps(fake.provider), { action: 'list' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('沙盒没有返回结果');
  });

  it('rejects output over the byte limit', async () => {
    const child = new FakeChild();
    child.stdin.write = (() => {
      child.writeStdout(`${'x'.repeat(9 * 1024 * 1024)}\n`);
      return 0;
    }) as typeof child.stdin.write;
    const fake = fakeProvider(() => child);

    const result = await runNativePluginAction(deps(fake.provider), {
      action: 'read',
      pluginId: 'a@m',
    });

    expect(result).toEqual({ ok: false, error: '沙盒输出超过 8388608 字节上限' });
  });
});

describe('registerNativePlugins close', () => {
  beforeAll(obliterateQueue);

  afterAll(obliterateQueue);

  beforeEach(() => {
    mock.clearAllMocks();
  });

  it('destroys the active install before waiting for the job to finish', async () => {
    const child = hangingChild();
    docker.createImpl.mockImplementation(
      async () =>
        ({
          id: 'native-plugin-live',
          child,
        }) as unknown as Sandbox,
    );
    let jobFinished = false;
    void child.exited.then(() => {
      jobFinished = true;
    });
    const finishedAtDestroy: boolean[] = [];
    docker.destroyAll.mockImplementation(async () => {
      finishedAtDestroy.push(jobFinished);
      child.finish(137);
    });
    const queue = await enqueueInstall();
    const handle = await registerNativePlugins(config(), async () => RUNTIME);
    try {
      await waitForCreate();
      await handle.close();

      expect(finishedAtDestroy).toEqual([false]);
      expect(docker.destroyAll).toHaveBeenCalledTimes(1);
      expect(child.signals).toContain('SIGKILL');
    } finally {
      await handle.close();
      await queue.close();
    }
  });

  it('reports cleanup failure instead of swallowing it', async () => {
    docker.destroyAll.mockRejectedValueOnce(new Error('rm failed'));
    const handle = await registerNativePlugins(config(), async () => RUNTIME);
    try {
      await expect(handle.close()).rejects.toMatchObject({
        name: 'AggregateError',
        errors: [expect.objectContaining({ message: 'rm failed' })],
      });
    } finally {
      await handle.close();
    }
  });

  it('does not wait for an install stuck in provider.create', async () => {
    let resolveCreate: (sandbox: Sandbox) => void = () => {};
    docker.createImpl.mockImplementation(
      () =>
        new Promise<Sandbox>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const queue = await enqueueInstall();
    const handle = await registerNativePlugins(config(), async () => RUNTIME);
    try {
      await waitForCreate();
      await handle.close();

      const child = hangingChild();
      resolveCreate({ id: 'native-plugin-late', child } as unknown as Sandbox);
      await waitFor(() => expect(docker.destroy).toHaveBeenCalledTimes(1));
      expect(child.signals).toEqual([]);
    } finally {
      await handle.close();
      await queue.close();
    }
  });
});
