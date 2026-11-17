import { getNextMillis } from 'bullmq';

export const INVALID_CRON_MESSAGE = 'cron 表达式无法解析或不产生触发时间';

export function isSchedulableCron(cron: string, timezone: string): boolean {
  try {
    return getNextMillis(Date.now(), { pattern: cron, tz: timezone }) !== undefined;
  } catch {
    return false;
  }
}
