import { fail } from '@agentport/core';
import { RUN_QUEUE_MAX_WAITING } from '@agentport/shared';
import { getQueue } from '../../queue/producer.js';

type WaitingQueue = { getWaitingCount(): Promise<number> };

const RUN_QUEUE_FULL_MESSAGE = '运行队列已满，请稍后重试';

export async function requireRunQueueCapacity(
  message = RUN_QUEUE_FULL_MESSAGE,
  queues: readonly WaitingQueue[] = [getQueue()],
): Promise<void> {
  const counts = await Promise.all(queues.map((queue) => queue.getWaitingCount()));
  if (counts.some((count) => count > RUN_QUEUE_MAX_WAITING)) fail('SERVICE_UNAVAILABLE', message);
}
