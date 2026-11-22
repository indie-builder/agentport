export const RUNS_QUEUE = 'agent-runs';

export const EVAL_RUNS_QUEUE = 'eval-runs';

export const RUN_CANCEL_PAYLOAD = '1';

const ACTIVE_JOB_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
]);

export function isActiveJobState(state: string): boolean {
  return ACTIVE_JOB_STATES.has(state);
}

export const STREAM_TTL_SECONDS = 3600;

export const STREAM_INTERRUPTED_MESSAGE = '事件流中断，请刷新页面或重试';

export const SERVER_SHUTDOWN_MESSAGE = 'Server shutting down';

export const RUN_QUEUE_MAX_WAITING = 100;

export const DEFAULT_JOB_RETENTION = { removeOnComplete: 100, removeOnFail: 200 } as const;

export const SHORT_JOB_RETENTION = { removeOnComplete: 50, removeOnFail: 50 } as const;

export const RUN_TRANSIENT_MAX_EVENTS = 2_000;
export const RUN_TRANSIENT_MAX_BYTES = 32 * 1024 * 1024;
export const RUN_PERSISTED_MAX_EVENTS = 2_000;
export const RUN_PERSISTED_MAX_BYTES = 32 * 1024 * 1024;

export function runStreamKey(runId: string): string {
  return `run:${runId}:events`;
}

export function runEventsConnectionName(runId: string): string {
  return `run-events:${runId}`;
}

export function runCancelKey(runId: string): string {
  return `run:${runId}:cancel`;
}

export function runEnqueueOptions(jobId: string) {
  return {
    jobId,
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    ...DEFAULT_JOB_RETENTION,
  };
}
