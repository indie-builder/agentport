import { writePersonalMemoryProjection } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import type { ExecutionSubject, MemoryPolicy } from '@agentport/shared';
import type { SQL } from 'bun';

/**
 * 只有「私有用户 run + 策略允许」才返回要投影的个人记忆 businessId。
 * 频道 run 是共享执行上下文，服务主体没有个人记忆；策略不得放宽这两条既有边界。
 */
export function personalMemoryBusinessIdForRun(input: {
  subject: ExecutionSubject;
  channelId: string | null;
  policy: MemoryPolicy;
}): string | undefined {
  if (input.subject.kind !== 'user') return undefined;
  if (input.channelId !== null) return undefined;
  if (!input.policy.injectPersonalMemory) return undefined;
  return input.subject.businessId;
}

/**
 * 每轮用户聊天运行前按 DB 最新个人偏好重写该用户的 `CLAUDE.md`。
 * businessId 必传：服务主体没有个人记忆，也不存在默认管理员回退。
 * 与 API 保存共用 user:<businessId> 会话锁：worker 不会读到旧值后又覆盖 API 新投影。
 * 投影写入失败必须中止本轮运行。
 */
export async function projectPersonalMemory(
  db: Database,
  client: SQL,
  workspacesDir: string,
  businessId: string,
): Promise<void> {
  await repo.locks.withAdvisoryLock(
    client,
    repo.locks.memoryTargetLockKey({ kind: 'personal' }, businessId),
    async () => {
      const row = await repo.userPreferences.get(db, businessId);
      await writePersonalMemoryProjection(workspacesDir, businessId, row?.content ?? '');
    },
  );
}
