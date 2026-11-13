import { repo } from '@agentport/db';
import type { SQL } from 'bun';
import { closeSessionSandboxes } from '../../queue/session-cleanup.js';

const { AGENT_BINDINGS_LOCK_KEY, withAdvisoryLock } = repo.locks;

/** 删除持锁总预算：tx A + 10s ACK + tx B + unlock。 */
const DELETION_HOLD_TIMEOUT_MS = 40_000;

/**
 * 同一个绑定锁内完成 A → 事务外关闭确认 → B；db 不参与网络等待，
 * 所有 repo 调用都复用回调交付的同一连接。
 */
export async function deleteAgentWithSandboxes(input: {
  client: SQL;
  redisUrl: string;
  deletion: repo.agents.AgentDeletionInput;
}): Promise<repo.agents.AgentDeletionSnapshot | null> {
  return withAdvisoryLock(
    input.client,
    AGENT_BINDINGS_LOCK_KEY,
    async (lockedDb) => {
      const snapshot = await repo.agents.prepareAgentDeletion(lockedDb, input.deletion);
      if (snapshot === null) return null;
      // 事务外等待全部目标关闭；失败直接结束，不进入 tx B。
      await closeSessionSandboxes({ redisUrl: input.redisUrl, targets: snapshot.targets });
      const deleted = await repo.agents.deleteAgent(lockedDb, {
        ...input.deletion,
        expected: snapshot,
      });
      return deleted ? snapshot : null;
    },
    DELETION_HOLD_TIMEOUT_MS,
  );
}

export async function deleteConversationWithSandboxes(input: {
  client: SQL;
  redisUrl: string;
  deletion: repo.chat.ConversationDeletionInput;
}): Promise<repo.chat.ConversationDeletionSnapshot | null> {
  return withAdvisoryLock(
    input.client,
    AGENT_BINDINGS_LOCK_KEY,
    async (lockedDb) => {
      const snapshot = await repo.chat.prepareConversationDeletion(lockedDb, input.deletion);
      if (snapshot === null) return null;
      await closeSessionSandboxes({ redisUrl: input.redisUrl, targets: snapshot.targets });
      const deleted = await repo.chat.deleteConversation(lockedDb, {
        ...input.deletion,
        expected: snapshot,
      });
      return deleted ? snapshot : null;
    },
    DELETION_HOLD_TIMEOUT_MS,
  );
}
