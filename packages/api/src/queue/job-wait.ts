import { SHORT_JOB_RETENTION } from '@agentport/shared';
import { createBunRedisClient, Queue, QueueEvents } from 'bullmq';
import { RedisClient } from 'bun';

export interface QueueJobLogger {
  warn: (obj: object, msg: string) => void;
}

export interface RunQueueJobAndWaitInput {
  redisUrl: string;
  queueName: string;
  jobName: string;
  payload: unknown;
  timeoutMs: number;
  logger: QueueJobLogger;
}

export type QueueJobOutcome =
  | { status: 'completed'; value: unknown }
  | { status: 'failed'; message: string }
  | { status: 'timeout' }
  | { status: 'error'; error: unknown };

export async function runQueueJobAndWait(input: RunQueueJobAndWaitInput): Promise<QueueJobOutcome> {
  const { redisUrl, queueName, jobName, payload, timeoutMs, logger } = input;
  const raw = new RedisClient(redisUrl, {
    autoReconnect: false,
    enableOfflineQueue: false,
    connectionTimeout: Math.min(2000, timeoutMs),
  });
  const connection = createBunRedisClient(raw);
  const queue = new Queue<unknown>(queueName, { connection });
  const events = new QueueEvents(queueName, { connection, lastEventId: '0-0' });
  const onError = (error: Error) => logger.warn({ err: error }, 'queue error');
  queue.on('error', onError);
  events.on('error', onError);

  const outcome = Promise.withResolvers<QueueJobOutcome>();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    outcome.resolve({ status: 'timeout' });
  }, timeoutMs);
  const pending = (async () => {
    await Promise.all([queue.waitUntilReady(), events.waitUntilReady()]);
    if (timedOut) return;
    const job = await queue.add(jobName, payload, {
      attempts: 1,
      ...SHORT_JOB_RETENTION,
    });
    const jobId = job.id;
    if (timedOut || !jobId) return;
    events.on('completed', (event) => {
      if (event.jobId === jobId) outcome.resolve({ status: 'completed', value: event.returnvalue });
    });
    events.on('failed', (event) => {
      if (event.jobId === jobId) outcome.resolve({ status: 'failed', message: event.failedReason });
    });
    const state = await queue.getBackend().isFinished(jobId, true);
    if (timedOut) return;
    if (typeof state !== 'number' && state[0] !== 0) {
      outcome.resolve(
        state[0] === -1 || state[0] === 2
          ? { status: 'failed', message: state[1] }
          : { status: 'completed', value: JSON.parse(state[1]) as unknown },
      );
    }
  })().catch((error: unknown) => outcome.resolve({ status: 'error', error }));

  try {
    return await outcome.promise;
  } finally {
    connection.on('error', onError);
    clearTimeout(timer);
    timedOut = true;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        drainTimer = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(drainTimer);
    await Promise.allSettled([queue.close(), events.close()]);
    await connection.quit();
  }
}
