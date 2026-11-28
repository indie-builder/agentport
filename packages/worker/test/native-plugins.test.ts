import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
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
import {
  type NativePluginsDeps,
  registerNativePlugins,
  runNativePluginAction,
} from '../src/native-plugins.js';
import type { Sandbox, SandboxCreateOptions } from '../src/sandbox/provider.js';
import { bunRedisConnection } from './fixtures/bun-redis.js';
import { waitFor } from './fixtures/native-test.js';

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

  it('destroys the active install before close finishes', async () => {
    const child = hangingChild();
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    child.stdin.write = (() => {
      started();
      return 0;
    }) as typeof child.stdin.write;
    const destroyed: string[] = [];
    const provider: NativePluginsDeps['provider'] = {
      create: async () => ({ id: 'native-plugin-live', child }) as unknown as Sandbox,
      destroy: async (sandbox) => {
        destroyed.push(sandbox.id);
      },
    };
    const closing = new AbortController();
    const queue = await enqueueInstall();
    const handle = await registerNativePlugins({
      provider,
      resolveRuntimeEnvironment: async () => RUNTIME,
      workspacesDir,
      hostWorkspacesDir: workspacesDir,
      logger: quietLogger,
      redisUrl,
      closingSignal: closing.signal,
    });
    try {
      await startedPromise;
      await handle.close();

      expect(destroyed).toEqual(['native-plugin-live']);
      expect(child.signals).toContain('SIGKILL');
    } finally {
      await handle.close();
      await queue.close();
    }
  });

  it('aborts the active install when the shared closing signal aborts', async () => {
    const child = hangingChild();
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    child.stdin.write = (() => {
      started();
      return 0;
    }) as typeof child.stdin.write;
    const fake = fakeProvider(() => child);
    const closing = new AbortController();
    const queue = await enqueueInstall();
    const handle = await registerNativePlugins({
      provider: fake.provider,
      resolveRuntimeEnvironment: async () => RUNTIME,
      workspacesDir,
      hostWorkspacesDir: workspacesDir,
      logger: quietLogger,
      redisUrl,
      closingSignal: closing.signal,
    });
    try {
      await startedPromise;
      closing.abort();
      await handle.close();

      expect(fake.destroyed).toEqual(['native-plugin-fake']);
      expect(child.signals).toContain('SIGKILL');
    } finally {
      await handle.close();
      await queue.close();
    }
  });

  it('does not wait for an install stuck in provider.create', async () => {
    let resolveCreate: (sandbox: Sandbox) => void = () => {};
    let createdCalled = false;
    const destroyed: string[] = [];
    const provider: NativePluginsDeps['provider'] = {
      create: () => {
        createdCalled = true;
        return new Promise<Sandbox>((resolve) => {
          resolveCreate = resolve;
        });
      },
      destroy: async (sandbox) => {
        destroyed.push(sandbox.id);
      },
    };
    const closing = new AbortController();
    const queue = await enqueueInstall();
    const handle = await registerNativePlugins({
      provider,
      resolveRuntimeEnvironment: async () => RUNTIME,
      workspacesDir,
      hostWorkspacesDir: workspacesDir,
      logger: quietLogger,
      redisUrl,
      closingSignal: closing.signal,
    });
    try {
      await waitFor(() => expect(createdCalled).toBe(true), { timeout: 10_000 });
      await handle.close();

      const child = hangingChild();
      resolveCreate({ id: 'native-plugin-late', child } as unknown as Sandbox);
      await waitFor(() => expect(destroyed).toEqual(['native-plugin-late']));
      expect(child.signals).toEqual([]);
    } finally {
      await handle.close();
      await queue.close();
    }
  });
});
