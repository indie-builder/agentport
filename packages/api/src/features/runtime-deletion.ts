import { type DbPool, repo } from '@agentport/db';
import * as agentsRepo from '@agentport/db/repo/agents.js';
import * as chatRepo from '@agentport/db/repo/chat.js';
import { closeSessionSandboxes } from '../queue/session-cleanup.js';

const { AGENT_BINDINGS_LOCK_KEY, withAdvisoryLock } = repo.locks;

/** 删除持锁总预算：tx A + 10s ACK + tx B + unlock。 */
const DELETION_HOLD_TIMEOUT_MS = 40_000;

/**
 * 同一个绑定锁内完成 A → 事务外关闭确认 → B；db 不参与网络等待，
 * 所有 repo 调用都复用回调交付的同一连接。
 */
export async function deleteAgentWithSandboxes(input: {
  pool: DbPool;
  redisUrl: string;
  deletion: agentsRepo.AgentDeletionInput;
}): Promise<agentsRepo.AgentDeletionSnapshot | null> {
  return withAdvisoryLock(
    input.pool,
    AGENT_BINDINGS_LOCK_KEY,
    async (lockedDb) => {
      const snapshot = await agentsRepo.prepareAgentDeletion(lockedDb, input.deletion);
      if (snapshot === null) return null;
      // 事务外等待全部目标关闭；失败直接结束，不进入 tx B。
      await closeSessionSandboxes({ redisUrl: input.redisUrl, targets: snapshot.targets });
      const deleted = await agentsRepo.deleteAgent(lockedDb, {
        ...input.deletion,
        expected: snapshot,
      });
      return deleted ? snapshot : null;
    },
    DELETION_HOLD_TIMEOUT_MS,
  );
}

export async function deleteConversationWithSandboxes(input: {
  pool: DbPool;
  redisUrl: string;
  deletion: chatRepo.ConversationDeletionInput;
}): Promise<chatRepo.ConversationDeletionSnapshot | null> {
  return withAdvisoryLock(
    input.pool,
    AGENT_BINDINGS_LOCK_KEY,
    async (lockedDb) => {
      const snapshot = await chatRepo.prepareConversationDeletion(lockedDb, input.deletion);
      if (snapshot === null) return null;
      await closeSessionSandboxes({ redisUrl: input.redisUrl, targets: snapshot.targets });
      const deleted = await chatRepo.deleteConversation(lockedDb, {
        ...input.deletion,
        expected: snapshot,
      });
      return deleted ? snapshot : null;
    },
    DELETION_HOLD_TIMEOUT_MS,
  );
}
