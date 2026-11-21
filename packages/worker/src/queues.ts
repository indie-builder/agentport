import { QUEUE_REGISTRY } from '@agentport/shared';

export const WORKER_QUEUES = QUEUE_REGISTRY.map((queue) => queue.name);
