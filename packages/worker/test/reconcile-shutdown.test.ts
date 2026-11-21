import { afterEach, describe, expect, it, mock } from 'bun:test';
import { newId, schema } from '@agentport/db';
import type { Logger } from 'pino';

const { publishRun, queueClose } = (() => {
  let failed!: () => void;
  const failedPromise = new Promise<void>((resolve) => {
    failed = resolve;
  });
  return {
    publishRun: {
      failed: failedPromise,
      signal: failed,
      fn: mock(async () => {
        failed();
        throw new Error('publish failed');
      }),
    },
    queueClose: mock(async () => undefined),
  };
})();

const runnerClientActual = await import('../src/runner-client.js');
mock.module('../src/runner-client.js', () => ({
  ...runnerClientActual,
  publishRun: publishRun.fn,
  clearRunCancel: async () => undefined,
}));
mock.module('bullmq', () => ({
  createBunRedisClient: () => ({ quit: async () => undefined }),
  Queue: class {
    on(): void {}
    getJob = async (): Promise<undefined> => undefined;
    close = queueClose;
  },
}));

const { startReconciler } = await import('../src/scheduling/reconcile.js');

const logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: mock(),
} as unknown as Logger;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('startReconciler shutdown', () => {
  afterEach(() => {
    mock.clearAllMocks();
  });

  it('waits for both reconcile branches before stop closes the queues', async () => {
    let releaseEval!: (rows: unknown[]) => void;
    const evalRows = new Promise<unknown[]>((resolve) => {
      releaseEval = resolve;
    });
    const runningRow = {
      id: newId('run'),
      conversationId: newId('conversation'),
      status: 'running',
      sandboxId: null,
      pendingFinish: null,
    };
    // where() 既可能被直接 await，也可能在 running 重查时继续 .limit(1)。
    const rows = (value: unknown[] | Promise<unknown[]>) =>
      Object.assign(Promise.resolve(value), { limit: async () => value });
    const terminalRow = {
      id: runningRow.id,
      channelId: null,
      agentId: newId('agent'),
      conversationId: runningRow.conversationId,
      initiatedBy: null,
      departmentId: null,
      scheduleId: null,
      trigger: 'chat',
      costUsd: null,
    };
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          update: () => ({
            set: () => ({
              where: () => ({ returning: async () => [terminalRow] }),
            }),
          }),
        }),
      select: (fields: { id: unknown; status?: unknown }) => ({
        from: () => ({
          where: () =>
            fields.id === schema.evalRuns.id
              ? evalRows
              : fields.status !== undefined
                ? rows([runningRow])
                : rows([]),
          innerJoin: () => ({
            where: () => rows([runningRow]),
          }),
        }),
      }),
    };

    const stop = startReconciler({
      db: db as never,
      logger,
      agentTimeoutMs: 1_000,
      redisUrl: 'redis://unused',
      cleanup: async () => undefined,
    });

    await publishRun.failed;

    let stopped = false;
    const stopping = stop().then(() => {
      stopped = true;
    });
    await flush();

    expect(stopped).toBe(false);
    expect(queueClose).not.toHaveBeenCalled();

    releaseEval([]);
    await stopping;

    expect(stopped).toBe(true);
    expect(queueClose).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('reconcile failed');
  });
});
