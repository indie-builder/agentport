import { DATA_DOMAIN_BUILDS_QUEUE, DATA_DOMAIN_ENRICHMENTS_QUEUE } from './data-domain.js';
import { KNOWLEDGE_JOBS_QUEUE, KNOWLEDGE_SYNC_TRIGGERS_QUEUE } from './knowledge.js';
import { NATIVE_PLUGINS_QUEUE } from './native-plugins.js';
import { MAINTENANCE_QUEUE } from './ops.js';
import { EVAL_RUNS_QUEUE, RUNS_QUEUE } from './run-stream.js';
import { RUNTIME_ENVIRONMENT_BUILDS_QUEUE } from './runtime-environment.js';
import { SANDBOX_PROBES_QUEUE } from './sandbox-probe.js';
import { SCHEDULE_TRIGGERS_QUEUE } from './schedules.js';

export const QUEUE_REGISTRY = [
  { name: RUNS_QUEUE, apiMonitored: null },
  { name: EVAL_RUNS_QUEUE, apiMonitored: null },
  { name: KNOWLEDGE_JOBS_QUEUE, apiMonitored: null },
  { name: KNOWLEDGE_SYNC_TRIGGERS_QUEUE, apiMonitored: true },
  { name: SCHEDULE_TRIGGERS_QUEUE, apiMonitored: null },
  { name: RUNTIME_ENVIRONMENT_BUILDS_QUEUE, apiMonitored: null },
  { name: SANDBOX_PROBES_QUEUE, apiMonitored: true },
  { name: NATIVE_PLUGINS_QUEUE, apiMonitored: true },
  { name: MAINTENANCE_QUEUE, apiMonitored: true },
  { name: DATA_DOMAIN_BUILDS_QUEUE, apiMonitored: null },
  { name: DATA_DOMAIN_ENRICHMENTS_QUEUE, apiMonitored: null },
] as const;

type RegistryEntry = (typeof QUEUE_REGISTRY)[number];

export type MonitoredQueueName = Extract<RegistryEntry, { apiMonitored: true }>['name'];
