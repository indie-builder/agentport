import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { auditLog } from '../schema.js';

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditQuery {
  /** 动作前缀，例如 `auth.login`。 */
  action?: string;
  status?: AuditStatus;
  limit?: number;
  /** 只取该时间之前的事件，用于「加载更多」。 */
  before?: Date;
}

export interface AuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  status: string;
  durationMs: number | null;
  requestId: string | null;
  inputDigest: string | null;
  createdAt: Date;
}

// 选择字段而不是 select()：输入只以 digest 存在，这里更不会把任何原文带出去。
const columns = {
  id: auditLog.id,
  actor: auditLog.actor,
  action: auditLog.action,
  target: auditLog.target,
  status: auditLog.status,
  durationMs: auditLog.durationMs,
  requestId: auditLog.requestId,
  inputDigest: auditLog.inputDigest,
  createdAt: auditLog.createdAt,
};

export async function listAudit(db: Database, query: AuditQuery = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200);
  const filters: SQL[] = [];
  if (query.action) {
    // 转义 LIKE 通配符，保持「前缀」语义。
    const prefix = query.action.replaceAll(/[%_\\]/g, '\\$&');
    filters.push(like(auditLog.action, `${prefix}%`));
  }
  if (query.status) filters.push(eq(auditLog.status, query.status));
  // 游标用严格小于：同一毫秒内的多条事件可能被跳过，审计页可接受。
  // shortcut: 时间戳游标不处理并列，需要精确分页时改成 (created_at, id) 游标。
  if (query.before) filters.push(lt(auditLog.createdAt, query.before));

  return db
    .select(columns)
    .from(auditLog)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}
