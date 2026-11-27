import { createServiceLogger, logEvent } from '@agentport/core/logger';
import { SCHEDULE_TRIGGERS_QUEUE, type ScheduleTriggerJob } from '@agentport/shared';
import { createBunRedisClient, Queue } from 'bullmq';
import { RedisClient } from 'bun';
import type { Logger } from 'pino';
import type { Config } from '../config.js';

const { version }: { version: string } = await Bun.file(
  new URL('../../../../package.json', import.meta.url),
).json();

let queue: Queue<ScheduleTriggerJob> | undefined;
let connection: ReturnType<typeof createBunRedisClient> | undefined;
let logger: Logger | undefined;

export function configureScheduleLogger(log: Logger): void {
  logger = log;
}

function scheduleLogger(nodeEnv: Config['NODE_ENV'] = 'development'): Logger {
  logger ??= createServiceLogger({
    service: 'api',
    env: nodeEnv,
    version,
    level: 'info',
  });
  return logger;
}

export function getScheduleQueue(
  redisUrl: string,
  nodeEnv: Config['NODE_ENV'] = 'development',
): Queue<ScheduleTriggerJob> {
  if (!queue) {
    const log = scheduleLogger(nodeEnv);
    connection = createBunRedisClient(new RedisClient(redisUrl));
    queue = new Queue<ScheduleTriggerJob>(SCHEDULE_TRIGGERS_QUEUE, {
      connection,
    });
    queue.on('error', (err: Error) => {
      logEvent(log, 'queue error', { queue: SCHEDULE_TRIGGERS_QUEUE }, 'error', { err });
    });
  }
  return queue;
}

export async function closeScheduleQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
}
