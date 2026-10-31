export const RUN_CANCEL_PAYLOAD = '1';
/** At ~40KiB per job this bounds waiting history near 4MiB per queue. */
export const RUN_QUEUE_MAX_WAITING = 100;

/** 单 run 展示上限：瞬时增量与块边界超出后只停止展示，不占用落库额度。 */
export const RUN_TRANSIENT_MAX_EVENTS = 2_000;
export const RUN_TRANSIENT_MAX_BYTES = 32 * 1024 * 1024;
/**
 * 单 run 落库上限：只统计需要持久化的完整消息与工具事件。
 * 与展示额度分开，避免 text_delta 把完整的 assistant_text 挤出持久化集合。
 */
export const RUN_PERSISTED_MAX_EVENTS = 2_000;
export const RUN_PERSISTED_MAX_BYTES = 32 * 1024 * 1024;

export function runStreamKey(runId: string): string {
  return `run:${runId}:events`;
}

/** Redis connection name for a run's blocking event follower; also used to count followers. */
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
    removeOnComplete: 100,
    removeOnFail: 200,
  };
}
