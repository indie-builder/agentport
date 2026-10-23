import {
  SCHEDULE_TRIGGERS_QUEUE,
  type ScheduleTriggerJob,
  scheduleTriggerArgs,
} from '@agentport/shared';
import { getNextMillis, Queue } from 'bullmq';

let queue: Queue<ScheduleTriggerJob> | undefined;

/** API 侧共享一条 scheduler 队列连接：CRUD 提交后同步，读取时展示真实的 next。 */
export function getScheduleQueue(redisUrl: string): Queue<ScheduleTriggerJob> {
  if (!queue) {
    queue = new Queue<ScheduleTriggerJob>(SCHEDULE_TRIGGERS_QUEUE, {
      connection: { url: redisUrl },
    });
    queue.on('error', (err: Error) =>
      process.stderr.write(`[queue] schedule redis error: ${err.message}\n`),
    );
  }
  return queue;
}

/** 用 BullMQ 自己的 cron 解析判定表达式是否可调度；解析异常与 undefined 都算非法。 */
export function isSchedulableCron(cron: string): boolean {
  try {
    return getNextMillis(Date.now(), { pattern: cron, tz: 'UTC' }) !== undefined;
  } catch {
    return false;
  }
}

export async function upsertScheduler(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'upsertJobScheduler'>,
  schedule: { id: string; cron: string },
): Promise<void> {
  await queueLike.upsertJobScheduler(...scheduleTriggerArgs(schedule.id, schedule.cron));
}

export async function removeScheduler(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'removeJobScheduler'>,
  scheduleId: string,
): Promise<void> {
  await queueLike.removeJobScheduler(scheduleId);
}

/** 展示用：nextDueAt 只读 BullMQ scheduler，不再在库里自算。 */
export async function schedulerNextRun(
  queueLike: Pick<Queue<ScheduleTriggerJob>, 'getJobScheduler'>,
  scheduleId: string,
): Promise<string | null> {
  const entry = await queueLike.getJobScheduler(scheduleId);
  return entry?.next === undefined ? null : new Date(entry.next).toISOString();
}
