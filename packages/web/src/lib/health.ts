import type { HealthMetrics } from './api.js';

/** 等待超过 10 个任务即视为积压；概览与健康页共用这一个阈值。 */
const QUEUE_WAITING_LIMIT = 10;

export interface QueueHealth {
  condition: 'unavailable' | 'backlog' | 'waiting-without-active' | 'failed' | 'ok';
  /** 事实描述：概览的一行与健康页的原因共用同一句。 */
  message: string;
  /** 仅健康页展示的排查提示。 */
  hint: string | null;
}

export function judgeQueue(queue: HealthMetrics['queue']): QueueHealth {
  if (!queue) {
    return {
      condition: 'unavailable',
      message: '队列指标不可用',
      hint: 'BullMQ 查询失败或超过 1.5 秒：Redis 不可用，或队列键被阻塞。',
    };
  }
  const { waiting, active, failed } = queue;
  const failedNote = failed > 0 ? `，另有 ${failed} 个历史失败记录` : '';
  if (waiting > QUEUE_WAITING_LIMIT) {
    return {
      condition: 'backlog',
      message: `队列积压：${waiting} 个等待，${active} 个运行中${failedNote}`,
      hint: 'worker 可能未运行、并发（AGENT_MAX_CONCURRENT）太低，或单个任务卡住。',
    };
  }
  if (waiting > 0 && active === 0) {
    return {
      condition: 'waiting-without-active',
      message: `有 ${waiting} 个任务等待，当前没有运行中的任务${failedNote}`,
      hint: '若持续出现，检查 worker 是否存活。',
    };
  }
  if (failed > 0) {
    return {
      condition: 'failed',
      message: `队列有 ${failed} 个历史失败记录`,
      // 这是队列保留的累计失败计数，不是当前可用性。
      hint: '历史失败记录不代表服务不可用；可在运行列表确认失败原因。',
    };
  }
  return { condition: 'ok', message: '', hint: null };
}
