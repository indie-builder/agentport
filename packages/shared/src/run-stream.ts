export const RUN_STREAM_MAXLEN = 1000;
export const RUN_CANCEL_PAYLOAD = '1';

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
  return { jobId, attempts: 2, backoff: { type: 'exponential', delay: 5_000 } };
}
