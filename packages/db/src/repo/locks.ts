import { and, asc, eq, sql } from 'drizzle-orm';
import type { Database, DbPool } from '../client.js';
import { agents } from '../schema.js';

/** 事务或连接都可用的最小查询面，避免调用方为了加锁反复 cast。 */
type LockDb = Pick<Database, 'execute' | 'select'>;

/**
 * 委派关系、运行准入与记忆写入共用的绑定锁。凡是会读「发起专家 + enabled 子级」
 * 或改变这层关系的写事务，都必须先拿它；拿锁顺序固定为 绑定锁 → 记忆锁 → 行锁。
 */
export async function lockAgentBindings(db: LockDb): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('agentport.subagent-bindings'))`);
}

/** 事务级 advisory lock，事务结束自动释放；调用方必须在事务里使用。 */
export async function lockMemoryKey(db: LockDb, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * 一次运行占用的资源集合 = 发起专家 + 其 enabled 直接子智能体。
 * 集合在运行期间固定：先拿绑定锁再读子级，然后按 agentId 排序取记忆锁。
 * 调用方必须在插入 queued 运行的同一事务里调用。
 */
export async function lockRunResources(db: LockDb, agentId: string): Promise<void> {
  await lockAgentBindings(db);
  const children = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.parentId, agentId), eq(agents.enabled, true)))
    .orderBy(asc(agents.id));
  const ids = [...new Set([agentId, ...children.map((row) => row.id)])].sort();
  for (const id of ids) await lockMemoryKey(db, agentMemoryLockKey(id));
}

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
