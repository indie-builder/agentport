import { z } from 'zod';

/** BullMQ 原生 Job Scheduler 的队列：只负责按 cron 投递触发信号，不直接跑运行。 */
export const SCHEDULE_TRIGGERS_QUEUE = 'schedule-triggers';

/** 运行队列待处理超过这个数就不再新增定时运行，避免积压时雪上加霜。 */
export const AGENT_RUNS_BACKLOG_LIMIT = 100;

/**
 * scheduler id、payload.scheduleId 与 data 的三个 id 都用 agent_schedules.id。
 * worker 先落盘再补 runId/conversationId/messageId，让重投递能识别已创建的运行。
 */
export const scheduleTriggerJobSchema = z.object({
  scheduleId: z.string().min(1),
  runId: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
});

export type ScheduleTriggerJob = z.infer<typeof scheduleTriggerJobSchema>;

export interface ScheduleTriggerTemplate {
  name: 'trigger';
  data: { scheduleId: string };
  opts: {
    attempts: number;
    backoff: { type: 'exponential'; delay: number };
    removeOnComplete: number;
    removeOnFail: number;
  };
}

/** scheduler id / repeat / job template 的三元组：API、worker 与测试共用同一契约。 */
export function scheduleTriggerArgs(
  scheduleId: string,
  cron: string,
): [string, { pattern: string; tz: 'UTC' }, ScheduleTriggerTemplate] {
  return [
    scheduleId,
    { pattern: cron, tz: 'UTC' },
    {
      name: 'trigger',
      data: { scheduleId },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: 100,
        removeOnFail: 200,
      },
    },
  ];
}
