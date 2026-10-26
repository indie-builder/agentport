import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { NATIVE_PLUGINS_QUEUE, type NativePluginAction } from '@agentport/shared';
import { Queue } from 'bullmq';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { loadConfig } from '../src/config.js';
import {
  type NativePluginsDeps,
  registerNativePlugins,
  runNativePluginAction,
} from '../src/native-plugins.js';
import type { Sandbox, SandboxCreateOptions } from '../src/sandbox/provider.js';

/** registerNativePlugins 自建 provider；用可控替身覆盖 create/destroyAll。 */
const docker = vi.hoisted(() => ({
  createImpl: vi.fn<(options: SandboxCreateOptions) => Promise<Sandbox>>(),
  destroy: vi.fn(async (_sandbox: Sandbox) => undefined),
  destroyAll: vi.fn(async () => undefined),
}));

vi.mock('../src/sandbox/docker.js', () => ({
  DockerSandboxProvider: class {
    create = docker.createImpl;
    destroy = docker.destroy;
    destroyAll = docker.destroyAll;
  },
}));

let workspacesDir = '';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
}

interface FakeProvider {
  options: SandboxCreateOptions[];
  destroyed: string[];
  provider: NativePluginsDeps['provider'];
}

/** behavior 决定容器如何响应任务；child 由用例自己驱动 stdout/stderr/close。 */
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

function deps(provider: FakeProvider['provider'], timeoutMs?: number): NativePluginsDeps {
  return {
    provider,
    image: 'agentport/sandbox:test',
    workspacesDir,
    hostWorkspacesDir: workspacesDir,
    logger: quietLogger,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** 容器收到任务后写一行结果并退出。 */
function respondingChild(line: unknown, stderr = ''): FakeChild {
  const child = new FakeChild();
  child.stdin.write = (() => {
    if (stderr) child.stderr.write(stderr);
    child.stdout.write(`${JSON.stringify(line)}\n`);
    child.emit('close', 0, null);
    return true;
  }) as typeof child.stdin.write;
  return child;
}

function hangingChild(): FakeChild {
  const child = new FakeChild();
  child.stdin.write = (() => true) as typeof child.stdin.write;
  return child;
}

/**
 * close 用独立 Redis db：worker 容器在 db 0 消费同一个队列名，共用会让真实安装抢走任务。
 */
const redisUrl = (() => {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  url.pathname = '/1';
  return url.toString();
})();
const connection = { url: redisUrl };

function config(): Config {
  return loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    APP_SECRET_KEY: 'a'.repeat(32),
    WORKSPACES_DIR: workspacesDir,
    REDIS_URL: redisUrl,
    LOG_LEVEL: 'error',
  });
}

/** 等消费者真正拿到 job：create 被调用即表示任务已在跑。 */
async function waitForCreate(): Promise<void> {
  await vi.waitFor(() => expect(docker.createImpl).toHaveBeenCalled(), { timeout: 10_000 });
}

async function enqueueInstall(): Promise<Queue<NativePluginAction>> {
  const queue = new Queue<NativePluginAction>(NATIVE_PLUGINS_QUEUE, { connection });
  await queue.add('install', { action: 'install', marketplace: 'owner/repo', plugin: 'demo' });
  return queue;
}

beforeAll(async () => {
  workspacesDir = await mkdtemp(join(tmpdir(), 'agentport-native-plugin-'));
});

afterAll(async () => {
  if (workspacesDir) await rm(workspacesDir, { recursive: true, force: true });
});

describe('runNativePluginAction', () => {
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
      image: 'agentport/sandbox:test',
      entrypoint: 'node',
      command: ['dist/native-plugins.js'],
      // 安装不调用模型：容器里只有可写的 HOME/TMPDIR，没有任何平台密钥。
      env: { HOME: '/tmp', TMPDIR: '/tmp' },
      workspaceDir: join(workspacesDir, 'native-plugin-actions'),
    });
    expect(options?.extraMounts).toEqual([
      {
        hostPath: join(workspacesDir, 'plugin-cache'),
        containerPath: '/mnt/plugin-cache',
      },
    ]);
    // 正常完成的动作不能触发取消。
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
      child.stdout.write(
        `${JSON.stringify({ ok: true, plugin: { pluginId: 'demo@fixture-market', version: '1' }, files: [] })}\n`,
      );
      child.emit('close', 0, null);
      return true;
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
    // 总预算用完也要取消这次创建，冷拉取不能继续。
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
    await vi.waitFor(() => expect(captured.signal).toBeDefined());
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
    // provider 先于动作注册 closing 监听：关停时 create 的拒绝先于 done 落地。
    closing.signal.addEventListener(
      'abort',
      () => rejectCreate?.(new Error('sandbox create aborted')),
      { once: true },
    );

    const pending = runNativePluginAction(
      { ...deps(provider, 10_000), closing: closing.signal },
      { action: 'list' },
    );
    await vi.waitFor(() => expect(rejectCreate).toBeDefined());
    closing.abort();
    const result = await pending;

    expect(result).toEqual({ ok: false, error: 'worker 正在关停，安装已取消' });
    expect(captured.signal?.aborted).toBe(true);
  });

  it('leaves late cleanup to the provider and reports its failure', async () => {
    const child = hangingChild();
    const destroyed: string[] = [];
    const warn = vi.fn();
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
    await vi.waitFor(() => expect(destroyed).toEqual(['native-plugin-late']));
    // 停止语义归 provider；这里不能杀进程，清理失败也必须带上下文告警。
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
      child.stdout.write(`${'x'.repeat(9 * 1024 * 1024)}\n`);
      return true;
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
  beforeAll(async () => {
    await new Queue(NATIVE_PLUGINS_QUEUE, { connection }).obliterate({ force: true });
  });

  afterAll(async () => {
    await new Queue(NATIVE_PLUGINS_QUEUE, { connection }).obliterate({ force: true });
  });

  beforeEach(() => {
    // clearAllMocks 保留实现；上面两个用例各自 set 了 createImpl。
    vi.clearAllMocks();
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
    child.once('close', () => {
      jobFinished = true;
    });
    const finishedAtDestroy: boolean[] = [];
    docker.destroyAll.mockImplementation(async () => {
      finishedAtDestroy.push(jobFinished);
      // docker rm -f 后容器立刻退出，这是 close 能快速返回的前提。
      child.emit('close', 137, 'SIGKILL');
    });
    const queue = await enqueueInstall();
    const handle = await registerNativePlugins(config());
    try {
      await waitForCreate();
      await handle.close();

      // 先停新任务、再销毁容器：销毁发生时安装任务还在跑，close 未被安装预算拖住。
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
    const handle = await registerNativePlugins(config());
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
    const handle = await registerNativePlugins(config());
    try {
      await waitForCreate();
      // create 未完成时 destroyAll 清不到容器，close 必须自行返回而不是等满安装预算。
      await handle.close();

      // 迟到的容器由 provider 销毁，native-plugins 不再直接杀进程。
      const child = hangingChild();
      resolveCreate({ id: 'native-plugin-late', child } as unknown as Sandbox);
      await vi.waitFor(() => expect(docker.destroy).toHaveBeenCalledTimes(1));
      expect(child.signals).toEqual([]);
    } finally {
      await handle.close();
      await queue.close();
    }
  });
});
