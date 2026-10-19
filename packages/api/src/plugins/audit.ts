import { createHash } from 'node:crypto';
import type { Database } from '@agentport/db';
import { schema } from '@agentport/db';
import type { FastifyBaseLogger } from 'fastify';
import { typeid } from 'typeid-js';

export const auditPrefix = 'aud';

export function auditId(): string {
  return typeid(auditPrefix).toString();
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

export interface AuditEvent {
  actor?: string;
  action: string;
  target?: string;
  input?: unknown;
  status: 'ok' | 'error' | 'denied';
  durationMs?: number;
  requestId?: string;
}

/**
 * 审计写入失败不能影响主流程：业务已经成功，丢一条审计比返回 500 更好。
 * 失败只记日志。
 */
export async function writeAudit(
  db: Database,
  logger: FastifyBaseLogger,
  event: AuditEvent,
): Promise<void> {
  try {
    await db.insert(schema.auditLog).values({
      id: auditId(),
      actor: event.actor ?? 'system',
      action: event.action,
      target: event.target ?? null,
      inputDigest: digest(event.input),
      status: event.status,
      durationMs: event.durationMs ?? null,
      requestId: event.requestId ?? null,
    });
  } catch (err) {
    logger.warn({ err, action: event.action }, 'audit write failed');
  }
}
