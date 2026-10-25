import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { encryptSecrets } from '@agentport/core';
import { createDb, newId, schema } from '@agentport/db';
import { SANDBOX_PROBE_STARTUP_TIMEOUT_MS } from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sandbox } from '../src/sandbox/provider.js';
import {
  type ProbeSandboxOptions,
  runSandboxProbe,
  type SandboxProbeDeps,
} from '../src/sandbox-probe.js';

const SECRET_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY';
const dbHandle = createDb(process.env.DATABASE_URL ?? '');
const { db } = dbHandle;
const ready = await dbHandle.pool.query('select 1').then(
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
    secretsEncrypted: encryptSecrets(env, SECRET_KEY),
  });
  return id;
}

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
  options: ProbeSandboxOptions[];
  destroyed: string[];
  provider: SandboxProbeDeps['provider'];
}

/** behavior 决定容器如何响应任务；child 由用例自己驱动 stdout/stderr/close。 */
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

function deps(provider: FakeProvider['provider']): SandboxProbeDeps {
  return {
    db,
    logger: quietLogger,
    provider,
    image: 'agentport/sandbox:test',
    workspacesDir,
    hostWorkspacesDir: workspacesDir,
    secretKey: SECRET_KEY,
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

beforeAll(async () => {
  workspacesDir = await mkdtemp(join(tmpdir(), 'agentport-probe-'));
});

afterAll(async () => {
  if (workspacesDir) await rm(workspacesDir, { recursive: true, force: true });
  if (!ready) return;
  for (const id of createdIds) {
    await db.delete(schema.servers).where(eq(schema.servers.id, id));
  }
  await dbHandle.pool.end();
});

describe.skipIf(!ready)('runSandboxProbe', () => {
  it('runs the probe entrypoint in the sandbox image without model credentials', async () => {
    const serverId = await seedStdio({ TOKEN: 'secret-token-value' });
    const fake = fakeProvider(() => respondingChild({ ok: true, tools: [{ name: 'echo' }] }));

    const result = await runSandboxProbe(deps(fake.provider), serverId);

    expect(result.ok).toBe(true);
    expect(result.tools).toEqual([{ name: 'echo' }]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    const [options] = fake.options;
    expect(options).toMatchObject({
      image: 'agentport/sandbox:test',
      entrypoint: 'node',
      command: ['dist/probe.js'],
      // 试连不调用模型：容器里不能出现任何模型凭证，只给一个可写的 HOME。
      env: { HOME: '/tmp' },
    });
    expect(Object.keys(options?.env ?? {}).some((key) => key.startsWith('ANTHROPIC'))).toBe(false);
    expect(options?.workspaceDir).toBe(join(workspacesDir, 'sandbox-probes'));
  });

  it('sends the decrypted stdio configuration as the single stdin task', async () => {
    const serverId = await seedStdio({ TOKEN: 'secret-token-value' });
    let task = '';
    const child = new FakeChild();
    child.stdin.write = ((chunk: string) => {
      task = chunk;
      child.stdout.write(`${JSON.stringify({ ok: true, tools: [] })}\n`);
      child.emit('close', 0, null);
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
  });

  it('reports a container that exits without a result line', async () => {
    const serverId = await seedStdio({});
    const child = new FakeChild();
    child.stdin.write = (() => {
      child.stderr.write('Error: cannot find module demo\n');
      child.emit('close', 1, null);
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
    let resolveCreate: ((value: Sandbox) => void) | undefined;
    const provider: SandboxProbeDeps['provider'] = {
      create: () =>
        new Promise<Sandbox>((resolve) => {
          resolveCreate = resolve;
        }),
      destroy: async () => undefined,
    };

    const result = await runSandboxProbe(
      { ...deps(provider), image: 'agentport/sandbox:test' },
      serverId,
      220, // 超过启动预算的 200ms
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/启动超时/);

    // 迟到的容器必须被立即销毁，不能因为超时先返回就泄漏。
    resolveCreate?.({ id: 'late-sandbox', child } as unknown as Sandbox);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(child.signals).toContain('SIGKILL');
  });
});
