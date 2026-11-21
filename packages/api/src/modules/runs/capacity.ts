import { RUN_QUEUE_MAX_WAITING } from '@agentport/shared';
import { getQueue } from '../../queue/producer.js';

export async function runQueueHasCapacity(): Promise<boolean> {
  return (await getQueue().getWaitingCount()) <= RUN_QUEUE_MAX_WAITING;
}
