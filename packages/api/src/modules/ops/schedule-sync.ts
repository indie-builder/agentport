import { type ScheduleTriggerJob, scheduleTriggerArgs } from '@agentport/shared';
import type { Queue } from 'bullmq';

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
