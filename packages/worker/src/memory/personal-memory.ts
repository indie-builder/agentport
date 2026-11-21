import { writePersonalMemoryProjection } from '@agentport/core';
import { type Database, repo } from '@agentport/db';
import type { ExecutionSubject, MemoryPolicy } from '@agentport/shared';
import type { SQL } from 'bun';

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
