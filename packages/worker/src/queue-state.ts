/** 队列里仍有工作（waiting/delayed/active/prioritized）就保留；job 消失或已终态才算丢失。 */
export const ACTIVE_STATES = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

export async function queueState(
  queue: { getJob: (id: string) => Promise<{ getState: () => Promise<string> } | undefined> },
  id: string,
): Promise<string | null> {
  const job = await queue.getJob(id);
  return job ? job.getState() : null;
}
