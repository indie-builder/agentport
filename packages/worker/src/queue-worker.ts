import { createBunRedisClient, type Processor, Worker } from 'bullmq';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';

interface StartRedisWorkerOptions<Data> {
  queue: string;
  redisUrl: string;
  logger: Logger;
  failureMessage: string;
  processor: (signal: AbortSignal) => Processor<Data>;
  prefix?: string;
  externalSignal?: AbortSignal;
  includeErrorInFailedLog?: boolean;
  concurrency?: number;
}

export function startRedisWorker<Data>(options: StartRedisWorkerOptions<Data>): {
  close: () => Promise<void>;
} {
  const closing = new AbortController();
  const onExternalAbort = () => closing.abort();
  options.externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  if (options.externalSignal?.aborted) closing.abort();
  const processor = options.processor(closing.signal);
  const connection = createBunRedisClient(new RedisClient(options.redisUrl));
  const worker = new Worker<Data>(options.queue, processor, {
    connection,
    ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    concurrency: options.concurrency ?? 1,
  });
  worker.on('failed', (job, err) => {
    options.logger.warn(
      { jobId: job?.id, ...(options.includeErrorInFailedLog === true ? { err } : {}) },
      options.failureMessage,
    );
  });

  return {
    close: async () => {
      closing.abort();
      options.externalSignal?.removeEventListener('abort', onExternalAbort);
      await worker.close().finally(() => connection.quit());
    },
  };
}
