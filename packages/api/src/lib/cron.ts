import { getNextMillis } from 'bullmq';

export const INVALID_CRON_MESSAGE = 'cron 表达式无法解析或不产生触发时间';

/** 用 BullMQ 自己的 cron 解析判定表达式是否可调度；解析异常与 undefined 都算非法。 */
export function isSchedulableCron(cron: string): boolean {
  try {
    return getNextMillis(Date.now(), { pattern: cron, tz: 'UTC' }) !== undefined;
  } catch {
    return false;
  }
}
