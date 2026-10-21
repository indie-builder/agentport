export const RUN_STREAM_MAXLEN = 1000;
export const RUN_CANCEL_PAYLOAD = '1';
/** At ~40KiB per job this bounds waiting history near 4MiB per queue. */
export const RUN_QUEUE_MAX_WAITING = 100;

export function runStreamKey(runId: string): string {
  return `run:${runId}:events`;
}

/** Pub/sub channel used to wake event-stream subscribers. */
export function runChannel(runId: string): string {
  return `${runStreamKey(runId)}:wake`;
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
