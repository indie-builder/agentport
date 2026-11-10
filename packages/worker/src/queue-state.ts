export async function queueState(
  queue: { getJob: (id: string) => Promise<{ getState: () => Promise<string> } | undefined> },
  id: string,
): Promise<string | null> {
  const job = await queue.getJob(id);
  return job ? job.getState() : null;
}
