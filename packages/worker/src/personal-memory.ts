import { writePersonalMemoryProjection } from '@agentport/core';
import { type Database, type DbPool, repo } from '@agentport/db';

/**
 * 每轮用户聊天运行前按 DB 最新个人偏好重写该用户的 `CLAUDE.md`。
 * businessId 必传：服务主体没有个人记忆，也不存在默认管理员回退。
 * 与 API 保存共用 user:<businessId> 会话锁：worker 不会读到旧值后又覆盖 API 新投影。
 * 投影写入失败必须中止本轮运行。
 */
export async function projectPersonalMemory(
  db: Database,
  pool: DbPool,
  workspacesDir: string,
  businessId: string,
): Promise<void> {
  await repo.locks.withAdvisoryLock(
    pool,
    repo.locks.memoryTargetLockKey({ kind: 'personal' }, businessId),
    async () => {
      const row = await repo.userPreferences.get(db, businessId);
      await writePersonalMemoryProjection(workspacesDir, businessId, row?.content ?? '');
    },
  );
}
