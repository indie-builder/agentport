import { fail } from '@agentport/core';
import { RUN_QUEUE_MAX_WAITING } from '@agentport/shared';
import { getQueue } from '../../queue/producer.js';

async function runQueueHasCapacity(): Promise<boolean> {
  return (await getQueue().getWaitingCount()) <= RUN_QUEUE_MAX_WAITING;
}

export const RUN_QUEUE_FULL_MESSAGE = '运行队列已满，请稍后重试';

export async function requireRunQueueCapacity(message = RUN_QUEUE_FULL_MESSAGE): Promise<void> {
  if (!(await runQueueHasCapacity())) fail('SERVICE_UNAVAILABLE', message);
}
