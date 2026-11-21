import type { QueueCounts } from '@agentport/shared';

const JOB_STATES = ['waiting', 'active', 'completed', 'failed', 'delayed'] as const;

interface QueueLike {
  getJobCounts: (...states: (typeof JOB_STATES)[number][]) => Promise<Record<string, number>>;
  getWaiting: (start: number, end: number) => Promise<{ timestamp: number }[]>;
}

export async function jobCounts(
  queue: QueueLike,
  options: { waitingTimeoutMs?: number } = {},
): Promise<QueueCounts> {
  let timer: NodeJS.Timeout | undefined;
  const [counts, waiting] = await Promise.all([
    queue.getJobCounts(...JOB_STATES),
    (options.waitingTimeoutMs === undefined
      ? queue.getWaiting(0, 0)
      : Promise.race([
          queue.getWaiting(0, 0),
          new Promise<{ timestamp: number }[]>((resolve) => {
            timer = setTimeout(() => resolve([]), options.waitingTimeoutMs).unref();
          }),
        ])
    )
      .catch(() => [] as { timestamp: number }[])
      .finally(() => clearTimeout(timer)),
  ]);
  return {
    waiting: counts.waiting ?? 0,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    failed: counts.failed ?? 0,
    delayed: counts.delayed ?? 0,
    oldestWaitingMs:
      waiting[0] === undefined ? null : Math.max(0, Date.now() - waiting[0].timestamp),
  };
}
