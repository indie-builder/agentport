import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runCancelKey } from '@agentport/shared';
import { Effect, Fiber } from 'effect';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  closeRunnerClient,
  configureRunnerClient,
  isRetryable,
  runInSandbox,
} from '../src/runner-client.js';
import type { Sandbox, SandboxProvider } from '../src/sandbox/provider.js';

async function probeRedis(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return false;
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await redis.connect();
    return (await redis.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    redis.disconnect();
  }
}

const redisUrl = process.env.REDIS_URL ?? '';
const ready = await probeRedis();

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

const quietLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => quietLogger,
} as unknown as Parameters<typeof runInSandbox>[0]['logger'];

const task = {
  prompt: 'hi',
  model: 'test',
  maxTurns: 1,
  maxBudgetUsd: 1,
  userMessageUuid: '11111111-2222-4333-8444-555555555555',
};

function input(runId: string, provider: SandboxProvider) {
  return {
    runId,
    timeoutMs: 5_000,
    task,
    workspaceDir: '/tmp/fake',
    image: 'fake',
    env: {},
    provider,
    logger: quietLogger,
  };
}

async function requestCancel(runId: string): Promise<void> {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    await redis.set(runCancelKey(runId), '1', 'EX', 60);
    await redis.publish(runCancelKey(runId), '1');
  } finally {
    redis.disconnect();
  }
}

afterAll(async () => {
  await closeRunnerClient();
});

describe('runInSandbox task payload', () => {
  it('serializes the shared sandbox task to the runner unchanged', async () => {
    configureRunnerClient(redisUrl);
    const child = new FakeChild();

    // 宿主写任务只经过 stdin；截下原始文本，再回一条终态让 run 收尾。
    const written: string[] = [];
    const originalWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = ((chunk: string) => {
      written.push(chunk);
      child.stdout.write(`${JSON.stringify({ type: 'run_finished', status: 'succeeded' })}\n`);
      child.emit('close', 0, null);
      return originalWrite(chunk);
    }) as typeof child.stdin.write;

    await runInSandbox(
      input(`run-payload-${randomUUID()}`, {
        create: async () => ({ id: 'fake', child }) as unknown as Sandbox,
        destroy: async () => undefined,
      }),
    );

    expect(JSON.parse(written.join('').trim())).toEqual(task);
  });
});

describe('Effect.tryPromise signal semantics', () => {
  it('aborts the signal when a racing branch wins but not when the promise completes', async () => {
    let raced: AbortSignal | undefined;
    await Effect.runPromise(
      Effect.raceAllFirst([
        Effect.tryPromise({
          try: (signal) => {
            raced = signal;
            return new Promise<never>(() => undefined);
          },
          catch: (err) => err,
        }),
        Effect.sleep(10),
      ]),
    );
    // create 分支被 race 打断时必须 abort，provider 才能中断 docker pull。
    expect(raced?.aborted).toBe(true);

    let completed: AbortSignal | undefined;
    await Effect.runPromise(
      Effect.tryPromise({
        try: (signal) => {
          completed = signal;
          return Promise.resolve('ok');
        },
        catch: (err) => err,
      }),
    );
    // 正常完成不 abort：create 成功后 provider 仍要 start 容器。
    expect(completed?.aborted).toBe(false);

    let interrupted: AbortSignal | undefined;
    const fiber = Effect.runFork(
      Effect.tryPromise({
        try: (signal) => {
          interrupted = signal;
          return new Promise<never>(() => undefined);
        },
        catch: (err) => err,
      }),
    );
    await Effect.runPromise(Effect.sleep(10));
    await Effect.runPromise(Fiber.interrupt(fiber));
    // Effect 被停止（worker 关停/上层中断）时也会 abort create。
    expect(interrupted?.aborted).toBe(true);
  });
});

describe.skipIf(!ready)('runInSandbox cancellation', () => {
  it('aborts a create that is still pending when the user cancels', async () => {
    configureRunnerClient(redisUrl);
    const runId = `run-cancel-create-${randomUUID()}`;
    let createSignal: AbortSignal | undefined;
    let createStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      createStarted = resolve;
    });

    const running = runInSandbox(
      input(runId, {
        create: (options) => {
          createSignal = options.signal;
          createStarted();
          return new Promise<Sandbox>(() => undefined);
        },
        destroy: async () => undefined,
      }),
    );
    await started;
    expect(createSignal?.aborted).toBe(false);

    await requestCancel(runId);
    const outcome = await running;

    expect(outcome.status).toBe('cancelled');
    expect(createSignal?.aborted).toBe(true);
  });

  it('lets the provider own container shutdown instead of killing the docker client', async () => {
    configureRunnerClient(redisUrl);
    const runId = `run-cancel-${randomUUID()}`;
    const child = new FakeChild();
    const destroyed: string[] = [];

    const running = runInSandbox(
      input(runId, {
        create: async () => ({ id: 'fake', child }) as unknown as Sandbox,
        destroy: async (sandbox) => {
          destroyed.push(sandbox.id);
        },
      }),
    );
    // 等 create 完成、取消订阅建立，再发真实取消信号。
    await new Promise((resolve) => setTimeout(resolve, 20));
    await requestCancel(runId);
    const outcome = await running;

    expect(outcome.status).toBe('cancelled');
    expect(destroyed).toEqual(['fake']);
    expect(child.signals).toEqual([]);
  });

  it('destroys a sandbox that finishes creating after the cancel', async () => {
    configureRunnerClient(redisUrl);
    const runId = `run-cancel-late-${randomUUID()}`;
    const child = new FakeChild();
    const destroyed: string[] = [];
    let finishCreate: ((sandbox: Sandbox) => void) | undefined;

    const running = runInSandbox(
      input(runId, {
        create: () =>
          new Promise<Sandbox>((resolve) => {
            finishCreate = resolve;
          }),
        destroy: async (sandbox) => {
          destroyed.push(sandbox.id);
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await requestCancel(runId);
    const outcome = await running;
    expect(outcome.status).toBe('cancelled');

    // 取消先返回时容器可能随后才创建完成；必须走 provider 销毁，不能直接杀 docker 客户端。
    finishCreate?.({ id: 'late', child } as unknown as Sandbox);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(destroyed).toEqual(['late']);
    expect(child.signals).toEqual([]);
  });

  it('keeps the cancelled result when cleanup fails', async () => {
    configureRunnerClient(redisUrl);
    const runId = `run-cancel-cleanup-${randomUUID()}`;
    const child = new FakeChild();

    const running = runInSandbox(
      input(runId, {
        create: async () => ({ id: 'fake', child }) as unknown as Sandbox,
        destroy: async () => {
          throw new Error('docker rm -f fake failed');
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await requestCancel(runId);
    const outcome = await running;

    // 清理失败不能把取消改判成可重试的 infra。
    expect(outcome.status).toBe('cancelled');
    expect(outcome.failure).toMatchObject({ reason: 'cancelled' });
    expect(outcome.error).toBeUndefined();
    expect(isRetryable(outcome)).toBe(false);
  });
});
