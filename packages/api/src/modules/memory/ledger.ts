import { type Database, repo } from '@agentport/db';

export async function recordMemoryChange(
  db: Database,
  insert: Parameters<typeof repo.memoryChanges.insert>[1],
): Promise<repo.memoryChanges.MemoryChangeRow> {
  const change = await repo.memoryChanges.insert(db, insert);
  if (change.sourceReviewRunId) {
    const decided = await repo.memoryReviews.updateDecisionIfPending(
      db,
      change.sourceReviewRunId,
      'applied',
      change.id,
    );
    if (!decided) throw new Error('review decision changed under memory lock');
  }
  return change;
}
