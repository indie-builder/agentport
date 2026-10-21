import { createHash } from 'node:crypto';
import { and, desc, eq, like, lt, type SQL } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import { auditLog } from '../schema.js';

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditEvent {
  actor?: string;
  action: string;
  target?: string;
  input?: unknown;
  status: AuditStatus;
  durationMs?: number;
  requestId?: string;
  /**
   * 幂等键：同一业务事件被重试时应写入同一行。
   * 省略时每次生成新的 TypeID（普通请求的默认行为）。
   */
  dedupeKey?: string;
}

/** API 传 FastifyBaseLogger，worker 传 pino Logger；两者结构上都满足。 */
interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

/** 只记录摘要，不落原文：审计表要长期保留，原文可能含用户数据。 */
function digest(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  try {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

/**
 * 审计写入失败不能影响主流程：业务已经成功，丢一条审计比返回 500 更好。
 * 失败只记日志。API 与 worker 共用这一处，ID 统一走 TypeID。
 */
export async function writeAudit(
  db: Database,
  logger: WarnLogger,
  event: AuditEvent,
): Promise<void> {
  try {
    const row = {
      id: event.dedupeKey ?? newId('audit'),
      actor: event.actor ?? 'system',
      action: event.action,
      target: event.target ?? null,
      inputDigest: digest(event.input),
      status: event.status,
      durationMs: event.durationMs ?? null,
      requestId: event.requestId ?? null,
    };
    // 有幂等键时不覆盖已有行：重试只是重复上报同一件事。
    await (event.dedupeKey
      ? db.insert(auditLog).values(row).onConflictDoNothing()
      : db.insert(auditLog).values(row));
  } catch (err) {
    logger.warn({ err, action: event.action }, 'audit write failed');
  }
}

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
