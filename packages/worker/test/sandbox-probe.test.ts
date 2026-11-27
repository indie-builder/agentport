import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { encryptSecrets } from '@agentport/core';
import { createDb, newId, schema } from '@agentport/db';
import {
  type ResolvedRuntimeEnvironment,
  SANDBOX_PROBE_STARTUP_TIMEOUT_MS,
  SANDBOX_PROBES_QUEUE,
} from '@agentport/shared';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Sandbox } from '../src/sandbox/provider.js';
import {
  type ProbeSandboxOptions,
  registerSandboxProbe,
  runSandboxProbe,
  type SandboxProbeDeps,
} from '../src/sandbox-probe.js';
import { bunRedisConnection } from './fixtures/bun-redis.js';
import { waitFor } from './fixtures/native-test.js';

const SECRET_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
const ready = await dbHandle.client.unsafe('select 1').then(
  () => true,
  () => false,
);

const createdIds: string[] = [];
let workspacesDir = '';

async function seedStdio(env: Record<string, string>): Promise<string> {
  const id = newId('server');
  createdIds.push(id);
  await db.insert(schema.servers).values({
    id,
    name: `probe-${id}`,
    kind: 'stdio',
    config: { command: 'node', args: ['-y', 'demo'] },
    secretsEncrypted: await encryptSecrets(env, SECRET_KEY),
  });
  return id;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly exited: Promise<number>;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private settleExited!: (code: number) => void;
  private exitedOnce = false;

  constructor() {
    super();
    this.exited = new Promise<number>((resolve) => {
      this.settleExited = resolve;
    });
  }

  finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exitedOnce) return;
    this.exitedOnce = true;
    this.exitCode = signal === null ? code : null;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.settleExited(signal === null ? (code ?? 0) : 137);
  }

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.finish(null, signal);
    return true;
  }
}

interface FakeProvider {
  options: ProbeSandboxOptions[];
  destroyed: string[];
  provider: SandboxProbeDeps['provider'];
}

function fakeProvider(behavior: () => FakeChild): FakeProvider {
  const options: ProbeSandboxOptions[] = [];
  const destroyed: string[] = [];
  return {
    options,
    destroyed,
    provider: {
      create: async (createOptions: ProbeSandboxOptions) => {
        options.push(createOptions);
        return { id: 'probe-fake', child: behavior() } as unknown as Sandbox;
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
  environmentId: 'env_probe',
  environmentName: '默认环境',
  versionId: 'ver_probe',
  imageId: 'sha256:probe-image',
};

function deps(provider: FakeProvider['provider']): SandboxProbeDeps {
  return {
    db,
    logger: quietLogger,
    provider,
    resolveRuntimeEnvironment: async () => RUNTIME,
    workspacesDir,
    hostWorkspacesDir: workspacesDir,
    secretKey: SECRET_KEY,
  };
}

function respondingChild(line: unknown, stderr = ''): FakeChild {
  const child = new FakeChild();
  child.stdin.write = (() => {
    if (stderr) child.stderr.write(stderr);
    child.stdout.write(`${JSON.stringify(line)}\n`);
    child.finish(0);
    return true;
  }) as typeof child.stdin.write;
  return child;
}

function hangingChild(): FakeChild {
  const child = new FakeChild();
  child.stdin.write = (() => true) as typeof child.stdin.write;
  return child;
}

beforeAll(async () => {
  workspacesDir = await mkdtemp(join(tmpdir(), 'agentport-probe-'));
});

afterAll(async () => {
  if (workspacesDir) await rm(workspacesDir, { recursive: true, force: true });
  if (!ready) return;
  for (const id of createdIds) {
    await db.delete(schema.servers).where(eq(schema.servers.id, id));
  }
  await dbHandle.client.close();
});

describe.skipIf(!ready)('runSandboxProbe', () => {
  it('runs the probe entrypoint in the sandbox image without model credentials', async () => {
    const serverId = await seedStdio({ TOKEN: 'secret-token-value' });
    const fake = fakeProvider(() => respondingChild({ ok: true, tools: [{ name: 'echo' }] }));

    const result = await runSandboxProbe(deps(fake.provider), serverId);

    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: 'echo' }]);
    expect(result.runtimeEnvironment).toEqual(RUNTIME);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const [options] = fake.options;
    expect(options).toMatchObject({
      image: RUNTIME.imageId,
      entrypoint: 'bun',
      command: ['dist/probe.js'],
      env: { HOME: '/tmp' },
    });
    expect(Object.keys(options?.env ?? {}).some((key) => key.startsWith('ANTHROPIC'))).toBe(false);
    expect(options?.workspaceDir).toBe(join(workspacesDir, 'sandbox-probes'));
    expect(options?.signal?.aborted).toBe(false);
  });

  it('resolves the requested environment only when it starts a container', async () => {
    const serverId = await seedStdio({});
    const fake = fakeProvider(() => respondingChild({ ok: true, tools: [] }));
    const seen: Array<string | null> = [];

    const result = await runSandboxProbe(
      {
        ...deps(fake.provider),
        resolveRuntimeEnvironment: async (environmentId) => {
          seen.push(environmentId);
          return { ...RUNTIME, environmentId: environmentId ?? 'env_default' };
        },
      },
      serverId,
      undefined,
      'env_custom',
    );

    expect(seen).toEqual(['env_custom']);
    expect(fake.options[0]?.image).toBe(RUNTIME.imageId);
    expect(result.runtimeEnvironment).toEqual({ ...RUNTIME, environmentId: 'env_custom' });
  });

  it('fails clearly without creating a container when the environment cannot resolve', async () => {
    const serverId = await seedStdio({});
    const fake = fakeProvider(() => hangingChild());

    const result = await runSandboxProbe(
      {
        ...deps(fake.provider),
        resolveRuntimeEnvironment: async () => {
          throw new Error('运行环境 env_custom 没有可用的线上版本，无法创建沙盒');
        },
      },
      serverId,
      undefined,
      'env_custom',
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/没有可用的线上版本/);
    expect(fake.options).toEqual([]);
  });

  it('sends the decrypted stdio configuration as the single stdin task', async () => {
    const serverId = await seedStdio({ TOKEN: 'secret-token-value' });
    let task = '';
    const child = new FakeChild();
    child.stdin.write = ((chunk: string) => {
      task = chunk;
      child.stdout.write(`${JSON.stringify({ ok: true, tools: [] })}\n`);
      child.finish(0);
      return true;
    }) as typeof child.stdin.write;
    const fake = fakeProvider(() => child);

    await runSandboxProbe(deps(fake.provider), serverId);

    expect(JSON.parse(task)).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['-y', 'demo'],
      env: { TOKEN: 'secret-token-value' },
    });
    expect(fake.destroyed).toEqual(['probe-fake']);
  });

  it('reports an honest timeout with the elapsed budget and destroys the sandbox', async () => {
    const serverId = await seedStdio({});
    const fake = fakeProvider(hangingChild);

    const result = await runSandboxProbe(deps(fake.provider), serverId, 30);

    expect(result.ok).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toMatch(/连接测试超时（30ms）/);
    expect(result.durationMs).toBeLessThan(SANDBOX_PROBE_STARTUP_TIMEOUT_MS);
    expect(fake.destroyed).toEqual(['probe-fake']);
    expect(fake.options[0]?.signal?.aborted).toBe(true);
  });

  it('reports a container that exits without a result line', async () => {
    const serverId = await seedStdio({});
    const child = new FakeChild();
    child.stdin.write = (() => {
      child.stderr.write('Error: cannot find module demo\n');
      child.finish(1);
      return true;
    }) as typeof child.stdin.write;
    const fake = fakeProvider(() => child);

    const result = await runSandboxProbe(deps(fake.provider), serverId);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/没有返回结果/);
    expect(result.error).toContain('cannot find module demo');
  });

  it('redacts secrets in stderr and error text before returning them', async () => {
    const serverId = await seedStdio({});
    const fake = fakeProvider(() =>
      respondingChild(
        { ok: false, tools: [], error: 'connect failed' },
        'TOKEN=supersecretvalue123\n',
      ),
    );

    const result = await runSandboxProbe(deps(fake.provider), serverId);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('connect failed');
    expect(result.stderr).toContain('TOKEN=supe***');
    expect(JSON.stringify(result)).not.toContain('supersecretvalue123');
  });

  it('fails without starting a container for a missing or non-stdio server', async () => {
    const fake = fakeProvider(() => hangingChild());

    const missing = await runSandboxProbe(deps(fake.provider), 'srv_missing');
    expect(missing).toMatchObject({ ok: false, tools: [] });
    expect(missing.error).toMatch(/不存在/);

    const httpId = newId('server');
    createdIds.push(httpId);
    await db.insert(schema.servers).values({
      id: httpId,
      name: `probe-${httpId}`,
      kind: 'http',
      config: { url: 'https://example.com/mcp' },
    });
    const http = await runSandboxProbe(deps(fake.provider), httpId);
    expect(http.ok).toBe(false);
    expect(http.error).toMatch(/只支持 stdio/);
    expect(fake.options).toEqual([]);
  });

  it('times out container startup without leaking the late sandbox', async () => {
    const serverId = await seedStdio({});
    const child = hangingChild();
    const destroyed: string[] = [];
    const captured: { signal?: AbortSignal; resolve?: (value: Sandbox) => void } = {};
    const provider: SandboxProbeDeps['provider'] = {
      create: (options) => {
        captured.signal = options.signal;
        return new Promise<Sandbox>((resolve) => {
          captured.resolve = resolve;
        });
      },
      destroy: async (sandbox) => {
        destroyed.push(sandbox.id);
        throw new Error('docker stop failed');
      },
    };
    const warn = mock();
    const logger = { ...quietLogger, warn } as unknown as Logger;

    const result = await runSandboxProbe({ ...deps(provider), logger }, serverId, 220);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/启动超时/);
    expect(captured.signal?.aborted).toBe(true);

    captured.resolve?.({ id: 'late-sandbox', child } as unknown as Sandbox);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(destroyed).toEqual(['late-sandbox']);
    expect(child.signals).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ serverId, sandboxId: 'late-sandbox' });
    expect(warn.mock.calls[0]?.[0]).toHaveProperty('err');
  });

  it('aborts the pending create when the worker closes', async () => {
    const serverId = await seedStdio({});
    const closing = new AbortController();
    const captured: { signal?: AbortSignal } = {};
    const provider: SandboxProbeDeps['provider'] = {
      create: (options) =>
        new Promise<Sandbox>((_resolve, reject) => {
          captured.signal = options.signal;
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('sandbox create aborted')),
            { once: true },
          );
        }),
      destroy: async () => undefined,
    };

    const pending = runSandboxProbe({ ...deps(provider), closing: closing.signal }, serverId, 100);
    await waitFor(() => expect(captured.signal).toBeDefined());
    closing.abort();
    const result = await pending;

    expect(captured.signal?.aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it('reports shutdown cancellation when create rejects on the closing signal', async () => {
    const serverId = await seedStdio({});
    const closing = new AbortController();
    let rejectCreate: ((error: Error) => void) | undefined;
    const captured: { signal?: AbortSignal } = {};
    const provider: SandboxProbeDeps['provider'] = {
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

    const pending = runSandboxProbe(
      { ...deps(provider), closing: closing.signal },
      serverId,
      10_000,
    );
    await waitFor(() => expect(rejectCreate).toBeDefined());
    closing.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('worker 正在关停，连接测试已取消');
    expect(captured.signal?.aborted).toBe(true);
  });

  it('ends a started probe as soon as the worker closes', async () => {
    const serverId = await seedStdio({});
    const closing = new AbortController();
    const child = hangingChild();
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    child.stdin.write = (() => {
      started();
      return true;
    }) as typeof child.stdin.write;
    const fake = fakeProvider(() => child);

    const pending = runSandboxProbe(
      { ...deps(fake.provider), closing: closing.signal },
      serverId,
      180,
    );
    await startedPromise;
    closing.abort();
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toBe('worker 正在关停，连接测试已取消');
    expect(fake.destroyed).toEqual(['probe-fake']);
  });

  it('cancels an already-aborted probe without waiting for the startup budget', async () => {
    const serverId = await seedStdio({});
    const closing = new AbortController();
    closing.abort();
    const provider: SandboxProbeDeps['provider'] = {
      create: () => new Promise<Sandbox>(() => undefined),
      destroy: async () => undefined,
    };

    const result = await runSandboxProbe(
      { ...deps(provider), closing: closing.signal },
      serverId,
      180,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('worker 正在关停，连接测试已取消');
  });
});

const redisUrl = (() => {
  const url = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  url.pathname = '/1';
  return url.toString();
})();
async function obliterateQueue(): Promise<void> {
  const redis = bunRedisConnection(redisUrl);
  const queue = new Queue(SANDBOX_PROBES_QUEUE, { connection: redis.connection });
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
    await redis.close();
  }
}

describe.skipIf(!ready)('registerSandboxProbe close', () => {
  beforeAll(obliterateQueue);

  afterAll(obliterateQueue);

  it('aborts an active probe on shared closing signal without closing shared db', async () => {
    const serverId = await seedStdio({});
    const child = hangingChild();
    let started: () => void = () => {};
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    child.stdin.write = (() => {
      started();
      return true;
    }) as typeof child.stdin.write;
    const fake = fakeProvider(() => child);
    const closing = new AbortController();
    const redis = bunRedisConnection(redisUrl);
    const queue = new Queue(SANDBOX_PROBES_QUEUE, { connection: redis.connection });
    const handle = await registerSandboxProbe({
      db,
      logger: quietLogger,
      provider: fake.provider,
      resolveRuntimeEnvironment: async () => RUNTIME,
      workspacesDir,
      hostWorkspacesDir: workspacesDir,
      secretKey: SECRET_KEY,
      redisUrl,
      concurrency: 1,
      closingSignal: closing.signal,
    });
    try {
      await queue.add('probe', { serverId });
      await startedPromise;
      closing.abort();
      await handle.close();

      expect(child.signals).toContain('SIGKILL');
      expect(fake.destroyed).toEqual(['probe-fake']);
      await expect(dbHandle.client.unsafe('select 1')).resolves.toBeDefined();
    } finally {
      await handle.close();
      await queue.close();
      await redis.close();
    }
  });
});
