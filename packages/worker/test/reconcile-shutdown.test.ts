import { newId, schema } from '@agentport/db';
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { publishRun, queueClose } = vi.hoisted(() => {
  let failed!: () => void;
  const failedPromise = new Promise<void>((resolve) => {
    failed = resolve;
  });
  return {
    publishRun: {
      failed: failedPromise,
      signal: failed,
      fn: vi.fn(async () => {
        failed();
        throw new Error('publish failed');
      }),
    },
    queueClose: vi.fn(async () => undefined),
  };
});

vi.mock('../src/runner-client.js', () => ({ publishRun: publishRun.fn }));
vi.mock('bullmq', () => ({
  Queue: class {
    on(): void {}
    close = queueClose;
  },
}));

const { startReconciler } = await import('../src/reconcile.js');

const logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: vi.fn(),
} as unknown as Logger;

/** 等所有排队的微任务与 setImmediate 回调走完，再断言 stop 没有提前结束。 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('startReconciler shutdown', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('waits for both reconcile branches before stop closes the queues', async () => {
    let releaseEval!: (rows: unknown[]) => void;
    const evalRows = new Promise<unknown[]>((resolve) => {
      releaseEval = resolve;
    });
    // 无数据库：run 分支在 publish 边界立即失败，eval 分支停在 select 上。
    const db = {
      update: () => ({
        set: () => ({
          from: () => ({
            where: () => ({
              returning: async () => [{ id: newId('run'), conversationId: newId('conversation') }],
            }),
          }),
        }),
      }),
      select: (fields: { id: unknown }) => ({
        from: () => ({
          where: () =>
            fields.id === schema.evalRuns.id ? evalRows : Promise.resolve<unknown[]>([]),
        }),
      }),
    };

    const stop = startReconciler({
      db: db as never,
      logger,
      agentTimeoutMs: 1_000,
      redisUrl: 'redis://unused',
    });

    // run 分支已 reject，eval 分支仍挂着；旧的 Promise.all 此时已结束 inFlight。
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
