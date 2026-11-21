import {
  SCHEDULE_TRIGGERS_QUEUE,
  type ScheduleTriggerJob,
  scheduleTriggerArgs,
} from '@agentport/shared';
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

export async function upsertScheduler(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'upsertJobScheduler'>,
  schedule: { id: string; cron: string; timezone: string },
): Promise<void> {
  await queueLike.upsertJobScheduler(
    ...scheduleTriggerArgs(schedule.id, schedule.cron, schedule.timezone),
  );
}

export async function removeScheduler(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'removeJobScheduler'>,
  scheduleId: string,
): Promise<void> {
  await queueLike.removeJobScheduler(scheduleId);
}

export async function schedulerNextRun(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'getJobScheduler'>,
  scheduleId: string,
): Promise<string | null> {
  const entry = await queueLike.getJobScheduler(scheduleId);
  return entry?.next === undefined ? null : new Date(entry.next).toISOString();
}

export async function closeScheduleQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
}
