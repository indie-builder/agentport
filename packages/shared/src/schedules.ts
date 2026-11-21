import { z } from 'zod';
import { DEFAULT_JOB_RETENTION } from './run-stream.js';

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
  triggerAt: z.number().int().optional(),
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
  timezone: string,
): [string, { pattern: string; tz: string }, ScheduleTriggerTemplate] {
  return [
    scheduleId,
    { pattern: cron, tz: timezone },
    {
      name: 'trigger',
      data: { scheduleId },
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        ...DEFAULT_JOB_RETENTION,
      },
    },
  ];
}

export function describeScheduleCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return '自定义计划';
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = parts;
  if (month !== '*') return '自定义计划';
  if (hour === '*' && day === '*' && weekday === '*') {
    const interval = /^\*\/([1-9]\d*)$/.exec(minute);
    if (interval && Number(interval[1]) <= 59) return `每 ${Number(interval[1])} 分钟`;
    if (/^\d+$/.test(minute) && Number(minute) <= 59) return `每小时第 ${Number(minute)} 分`;
  }
  if (!/^\d+$/.test(minute) || Number(minute) > 59 || !/^\d+$/.test(hour) || Number(hour) > 23) {
    return '自定义计划';
  }
  const time = `${String(Number(hour)).padStart(2, '0')}:${String(Number(minute)).padStart(2, '0')}`;
  if (day === '*' && weekday === '*') return `每天 ${time}`;
  if (day === '*' && /^[0-7](,[0-7])*$/.test(weekday)) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${weekday
      .split(',')
      .map((value) => names[Number(value) % 7])
      .join('、')} ${time}`;
  }
  if (weekday === '*' && /^\d+$/.test(day) && Number(day) >= 1 && Number(day) <= 31) {
    return `每月 ${Number(day)} 日 ${time}`;
  }
  return '自定义计划';
}
