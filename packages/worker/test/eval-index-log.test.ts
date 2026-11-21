import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { DbError } from '@agentport/core';
import { EVAL_RUNS_QUEUE } from '@agentport/shared';
import { waitFor } from './fixtures/native-test.js';

type FailedHandler = (job: { id?: string; data?: unknown } | undefined, error: unknown) => void;

const mocks = (() => ({
  errors: [] as unknown[][],
  failedHandlers: new Map<string, FailedHandler>(),
  handleEvalJobFailed: mock(),
}))();

mock.module('pino', () => {
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

const coreActual = await import('@agentport/core');
mock.module('@agentport/core', () => {
  return { ...coreActual, installProcessGuards: () => undefined };
});

const bullmqActual = await import('bullmq');
mock.module('bullmq', () => {
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
  return { ...bullmqActual, Worker };
});

mock.module('../src/eval-job.js', () => ({
  runEvalJob: async () => undefined,
  handleEvalJobFailed: mocks.handleEvalJobFailed,
}));

const sessionCleanupActual = await import('../src/sandbox/session-cleanup.js');
mock.module('../src/sandbox/session-cleanup.js', () => ({
  ...sessionCleanupActual,
  startSessionCleanupChannel: async () => ({ close: async () => undefined }),
}));

mock.module('../src/sandbox/docker.js', () => ({
  DockerSandboxProvider: class {
    async destroyAll(): Promise<void> {}
    async ensureImage(): Promise<void> {}
  },
  resolveLocalImageId: async () => `sha256:${'a'.repeat(64)}`,
}));

mock.module('../src/sandbox/sessions.js', () => ({
  SessionSandboxes: class {
    async cleanup(): Promise<void> {}
    async close(): Promise<void> {}
  },
  memoryMountFor: (policy: { enabled: boolean; writeMode: string }, memoryDir: string) =>
    policy.enabled ? { memoryDir, memoryWritable: policy.writeMode === 'native_auto' } : {},
}));

const runnerClientActual = await import('../src/runner-client.js');
mock.module('../src/runner-client.js', () => {
  return {
    ...runnerClientActual,
    configureRunnerClient: () => undefined,
    closeRunnerClient: async () => undefined,
    acquireSessionSandbox: async () => undefined,
    runInSandbox: async () => undefined,
    publishRun: async () => undefined,
    isRetryable: () => false,
  };
});

mock.module('../src/runtime-environments/default.js', () => ({
  ensureDefaultEnvironment: async () => undefined,
  startDefaultEnvironmentRetry: () => async () => undefined,
}));

mock.module('../src/runtime-environments/build.js', () => ({
  startRuntimeEnvironmentBuildWorker: async () => ({ close: async () => undefined }),
}));

mock.module('../src/runtime-environments/reconcile.js', () => ({
  startRuntimeEnvironmentBuildReconciler: () => () => undefined,
}));

mock.module('../src/scheduling/reconcile.js', () => ({
  startReconciler: () => () => undefined,
}));

mock.module('../src/knowledge/queue.js', () => ({
  startKnowledgeWorker: async () => ({ close: async () => undefined }),
}));

mock.module('../src/knowledge/reconcile.js', () => ({
  startKnowledgeReconciler: () => () => undefined,
}));

mock.module('../src/knowledge/scheduler.js', () => ({
  startKnowledgeScheduler: () => ({ sync: async () => undefined, close: async () => undefined }),
}));

mock.module('../src/scheduling/scheduler.js', () => ({
  startScheduleScheduler: () => ({ sync: async () => undefined, close: async () => undefined }),
}));

mock.module('../src/maintenance.js', () => ({
  startMaintenanceWorker: async () => ({ close: async () => undefined }),
}));

mock.module('../src/sandbox-probe.js', () => ({
  registerSandboxProbe: async () => ({ close: async () => undefined }),
}));

mock.module('../src/native-plugins.js', () => ({
  registerNativePlugins: async () => ({ close: async () => undefined }),
}));

mock.module('../src/model-proxy.js', () => ({
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

    await waitFor(() => {
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

    expect(mocks.handleEvalJobFailed).toHaveBeenCalledWith(
      expect.objectContaining({ job, error: failedError }),
    );

    const serialized = inspect(mocks.errors, { depth: 8 });
    expect(serialized).not.toContain(failedSecret);
    expect(serialized).not.toContain(settleSecret);
    expect(serialized).not.toMatch(/Failed query|params:/);
  });
});
