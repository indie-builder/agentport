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
    // 锁内不应再有人改决定；走到这里说明数据被外部改写，回滚整个事务。
    if (!decided) throw new Error('review decision changed under memory lock');
  }
  return change;
}
