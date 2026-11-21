import { SCHEDULE_TRIGGERS_QUEUE, type ScheduleTriggerJob } from '@agentport/shared';
import { createBunRedisClient, Queue } from 'bullmq';
import { RedisClient } from 'bun';

let queue: Queue<ScheduleTriggerJob> | undefined;
let connection: ReturnType<typeof createBunRedisClient> | undefined;

export function getScheduleQueue(redisUrl: string): Queue<ScheduleTriggerJob> {
  if (!queue) {
    connection = createBunRedisClient(new RedisClient(redisUrl));
    queue = new Queue<ScheduleTriggerJob>(SCHEDULE_TRIGGERS_QUEUE, {
      connection,
    });
    queue.on('error', (err: Error) =>
      process.stderr.write(`[queue] schedule redis error: ${err.message}\n`),
    );
  }
  return queue;
}

export async function closeScheduleQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
}
