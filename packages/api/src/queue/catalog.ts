import {
  DATA_DOMAIN_BUILDS_QUEUE,
  DATA_DOMAIN_ENRICHMENTS_QUEUE,
  EVAL_RUNS_QUEUE,
  KNOWLEDGE_JOBS_QUEUE,
  QUEUE_REGISTRY,
  RUNS_QUEUE,
  RUNTIME_ENVIRONMENT_BUILDS_QUEUE,
  SCHEDULE_TRIGGERS_QUEUE,
} from '@agentport/shared';
import type { Queue } from 'bullmq';
import type { Config } from '../config.js';
import { assertNever } from '../lib/assert-never.js';
import {
  getDataDomainBuildQueue,
  getDataDomainEnrichmentQueue,
  getEvalQueue,
  getKnowledgeQueue,
  getMonitoringQueue,
  getQueue,
  getRuntimeEnvironmentBuildQueue,
} from './producer.js';
import { getScheduleQueue } from './schedule.js';

type RegistryEntry = (typeof QUEUE_REGISTRY)[number];

type NonMonitoredName = RegistryEntry extends infer Entry
  ? Entry extends { apiMonitored: true }
    ? never
    : Entry extends { name: infer Name }
      ? Name
      : never
  : never;

function otherQueue(name: NonMonitoredName, redisUrl: string, nodeEnv: Config['NODE_ENV']): Queue {
  switch (name) {
    case RUNS_QUEUE:
      return getQueue();
    case EVAL_RUNS_QUEUE:
      return getEvalQueue();
    case KNOWLEDGE_JOBS_QUEUE:
      return getKnowledgeQueue();
    case RUNTIME_ENVIRONMENT_BUILDS_QUEUE:
      return getRuntimeEnvironmentBuildQueue();
    case DATA_DOMAIN_BUILDS_QUEUE:
      return getDataDomainBuildQueue();
    case DATA_DOMAIN_ENRICHMENTS_QUEUE:
      return getDataDomainEnrichmentQueue();
    case SCHEDULE_TRIGGERS_QUEUE:
      return getScheduleQueue(redisUrl, nodeEnv);
    default:
      return assertNever(name);
  }
}

export function getQueues(redisUrl: string, nodeEnv: Config['NODE_ENV'] = 'development'): Queue[] {
  return QUEUE_REGISTRY.map((entry) =>
    entry.apiMonitored !== null
      ? getMonitoringQueue(entry.name)
      : otherQueue(entry.name, redisUrl, nodeEnv),
  );
}
