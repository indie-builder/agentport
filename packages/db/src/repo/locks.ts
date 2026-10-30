import { sql } from 'drizzle-orm';
import type { Database, DbPool } from '../client.js';

/**
 * 记忆写入的统一目标锁：个人记忆按用户，专家记忆与规则共用该专家一把锁。
 * 同一专家只取一个锁，避免多个写入口交叉持锁。
 */
export function memoryTargetLockKey(
  target: { kind: 'personal' } | { kind: 'agent_memory' | 'agent_rule'; agentId: string },
  userId: string,
): string {
  return target.kind === 'personal' ? `user:${userId}` : `agent:${target.agentId}`;
}

export function agentMemoryLockKey(agentId: string): string {
  return `agent:${agentId}`;
}

/** 事务级 advisory lock，事务结束自动释放；调用方必须在事务里使用。 */
export async function lockMemoryKey(db: Database, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * 会话级 advisory lock 覆盖整个记忆操作：DB 事务提交/回滚由 fn 自己完成，
 * 锁一直持有到 fn 返回，文件投影与数据库写入之间不再留空窗。
 * 与 admitChatRun 的事务级锁共用同一 key 空间，两个方向互相阻塞。
 */
export async function withAdvisoryLock<T>(
  pool: DbPool,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    // 等锁可能超过连接默认的 statement_timeout。
    await client.query('set statement_timeout = 0');
    await client.query('select pg_advisory_lock(hashtext($1))', [key]);
    try {
      return await fn();
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [key]);
      // 连接回到池里时恢复连接默认的 statement_timeout。
      await client.query('reset statement_timeout');
    }
  } finally {
    // 连接断开会由 PostgreSQL 释放会话锁。
    client.release();
  }
}
