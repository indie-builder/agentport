import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { DbError } from '@agentport/core';
import { EVAL_RUNS_QUEUE } from '@agentport/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

type FailedHandler = (job: { id?: string; data?: unknown } | undefined, error: unknown) => void;

const mocks = vi.hoisted(() => ({
  /** 关闭事件回调的 logger 参数，用来验证生产日志载荷。 */
  errors: [] as unknown[][],
  failedHandlers: new Map<string, FailedHandler>(),
  handleEvalJobFailed: vi.fn(),
}));

// 真实 index.ts 用 pino 建 logger；这里只捕获 error 载荷，不改变任何模块行为。
vi.mock('pino', () => {
  const logger = {
    error: (...args: unknown[]) => {
      mocks.errors.push(args);
    },
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return { default: () => logger };
});

vi.mock('@agentport/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentport/core')>();
  // 进程级守卫会把测试里的未处理异常变成 process.exit；这里只验证日志载荷。
  return { ...actual, installProcessGuards: () => undefined };
});

// 只保留真实 index 的 failed 回调注册；不消费队列、不连接 Redis。
vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  class Worker {
    private readonly name: string;
    constructor(name: string) {
      this.name = name;
    }
    on(event: string, handler: FailedHandler): this {
      if (event === 'failed') mocks.failedHandlers.set(this.name, handler);
      return this;
    }
    async close(): Promise<void> {}
    async waitUntilReady(): Promise<void> {}
  }
  return { ...actual, Worker };
});

// 收口 handler 是外部 DB 边界；本用例只验证 index 如何记录它抛出的错误。
vi.mock('../src/eval-job.js', () => ({
  runEvalJob: async () => undefined,
  handleEvalJobFailed: mocks.handleEvalJobFailed,
}));

vi.mock('../src/sandbox/session-cleanup.js', () => ({
  startSessionCleanupChannel: async () => ({ close: async () => undefined }),
}));

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
  return {
    ...actual,
    configureRunnerClient: () => undefined,
    closeRunnerClient: async () => undefined,
    acquireSessionSandbox: async () => undefined,
    runInSandbox: async () => undefined,
    publishRun: async () => undefined,
    isRetryable: () => false,
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

vi.mock('../src/model-proxy.js', () => ({
  startModelProxy: async () => null,
}));

const failedSecret = `sk-live-eval-failed-${crypto.randomUUID()}`;
const settleSecret = `sk-live-eval-settle-${crypto.randomUUID()}`;
const failedError = new DbError(
  `Failed query: update "eval_runs" set "claimed_at" = $1 params: ${failedSecret}`,
  { code: 'P0001', message: `forced failure ${failedSecret}` },
);
const settlementError = new DbError(
  `Failed query: update "eval_runs" set "status" = $1 params: ${settleSecret}`,
  { code: '42P01', message: `forced failure ${settleSecret}` },
);

describe('eval failure logs in the real worker entry', () => {
  let workdir = '';

  beforeAll(async () => {
    workdir = await mkdtemp(join(tmpdir(), 'worker-eval-index-log-'));
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

  afterAll(async () => {
    await rm(workdir, { recursive: true, force: true });
  });

  it('logs only jobId/errorName/errorCode, never the SQL error text or params', async () => {
    const failed = mocks.failedHandlers.get(EVAL_RUNS_QUEUE);
    expect(failed).toBeTypeOf('function');

    const job = { id: 'eval-job-1' };
    mocks.handleEvalJobFailed.mockRejectedValueOnce(settlementError);
    failed?.(job, failedError);

    await vi.waitFor(() => {
      expect(mocks.errors.some((args) => args[1] === 'eval job failure settlement failed')).toBe(
        true,
      );
    });

    const failedLog = mocks.errors.find((args) => args[1] === 'eval job failed');
    expect(failedLog?.[0]).toEqual({
      jobId: 'eval-job-1',
      errorName: 'DbError',
      errorCode: 'P0001',
    });
    const settleLog = mocks.errors.find((args) => args[1] === 'eval job failure settlement failed');
    expect(settleLog?.[0]).toEqual({
      jobId: 'eval-job-1',
      errorName: 'DbError',
      errorCode: '42P01',
    });

    // 收口边界仍拿到原始错误，只有日志被脱敏。
    expect(mocks.handleEvalJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ job, error: failedError }),
    );

    const serialized = inspect(mocks.errors, { depth: 8 });
    expect(serialized).not.toContain(failedSecret);
    expect(serialized).not.toContain(settleSecret);
    expect(serialized).not.toMatch(/Failed query|params:/);
  });
});
