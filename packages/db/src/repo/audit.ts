import { createHash } from 'node:crypto';
import { canonicalJson, sha256Hex } from '@agentport/core';
import type { AuditActorKind } from '@agentport/shared';
import { and, asc, desc, eq, gt, gte, isNotNull, like, lt, type SQL, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import { auditLog } from '../schema.js';
import { escapeLike } from './knowledge/shared.js';
import { keysetBound, keysetPage } from './pagination.js';

export type AuditStatus = 'ok' | 'error' | 'denied';

export interface AuditEvent {
  actor?: string;
  actorKind?: AuditActorKind;
  subjectBusinessId?: string;
  action: string;
  target?: string;
  input?: unknown;
  detail?: unknown;
  status: AuditStatus;
  durationMs?: number;
  requestId?: string;
  /**
   * 幂等键：同一业务事件被重试时应写入同一行。
   * 省略时每次生成新的 TypeID（普通请求的默认行为）。
   */
  dedupeKey?: string;
}

interface WarnLogger {
  warn: (obj: object, msg: string) => void;
}

function digest(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  try {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 32);
  } catch {
    return null;
  }
}

function detailValue(value: unknown): Record<string, string | null> | null {
  if (value === null || value === undefined) return null;
  const parsed: unknown = JSON.parse(JSON.stringify(value) ?? 'null');
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const values = Object.values(parsed);
  if (!values.every((entry) => typeof entry === 'string' || entry === null)) return null;
  return parsed as Record<string, string | null>;
}

interface AuditHashMaterial {
  prevHash: string | null;
  id: string;
  actor: string;
  actorKind: string;
  subjectBusinessId: string | null;
  action: string;
  target: string | null;
  inputDigest: string | null;
  status: string;
  durationMs: number | null;
  requestId: string | null;
  createdAt: Date;
  detail?: unknown;
}

function chainHash(row: AuditHashMaterial): string {
  const base = [
    row.prevHash,
    row.id,
    row.actor,
    row.actorKind,
    row.subjectBusinessId,
    row.action,
    row.target,
    row.inputDigest,
    row.status,
    row.durationMs,
    row.requestId,
    row.createdAt.toISOString(),
  ];
  return sha256Hex(
    JSON.stringify(row.detail == null ? base : [2, ...base, canonicalJson(row.detail)]),
  );
}

export async function writeAuditInTx(tx: Transaction, event: AuditEvent): Promise<void> {
  const row = {
    id: event.dedupeKey ?? newId('audit'),
    actor: event.actor ?? 'system',
    actorKind: event.actorKind ?? (event.actor && event.actor !== 'system' ? 'user' : 'service'),
    subjectBusinessId: event.subjectBusinessId ?? null,
    action: event.action,
    target: event.target ?? null,
    inputDigest: digest(event.input),
    detail: detailValue(event.detail),
    status: event.status,
    durationMs: event.durationMs ?? null,
    requestId: event.requestId ?? null,
    createdAt: new Date(),
  };
  await tx.execute(sql`select pg_advisory_xact_lock(781236)`);
  const [last] = await tx
    .select({ hash: auditLog.hash })
    .from(auditLog)
    .where(isNotNull(auditLog.hash))
    .orderBy(desc(auditLog.chainSeq))
    .limit(1);
  const chained = { ...row, prevHash: last?.hash ?? null };
  const values = { ...chained, hash: chainHash(chained) };
  await (event.dedupeKey
    ? tx.insert(auditLog).values(values).onConflictDoNothing()
    : tx.insert(auditLog).values(values));
}

/**
 * 审计写入失败不能影响主流程：业务已经成功，丢一条审计比返回 500 更好。
 * 失败只记日志。API 与 worker 共用这一处，ID 统一走 TypeID。
 */
export async function writeAudit(
  db: DbHandle,
  logger: WarnLogger,
  event: AuditEvent,
): Promise<void> {
  try {
    await db.transaction((tx) => writeAuditInTx(tx, event));
  } catch (err) {
    logger.warn({ err, action: event.action }, 'audit write failed');
  }
}

export interface AuditChainVerification {
  ok: boolean;
  checked: number;
  brokenSeq: string | null;
  nextAfterSeq: number | null;
  complete: boolean;
}

export async function verifyAuditChain(
  db: Database,
  opts: { afterSeq?: number; limit?: number } = {},
): Promise<AuditChainVerification> {
  const limit = Math.min(Math.max(opts.limit ?? 1000, 1), 5000);
  const afterSeq = opts.afterSeq != null && opts.afterSeq > 0 ? opts.afterSeq : 0;
  let expectedPrev: string | null = null;
  let bound = gt(auditLog.chainSeq, afterSeq);
  if (afterSeq > 0) {
    const [cursor] = await db
      .select({ id: auditLog.id, hash: auditLog.hash })
      .from(auditLog)
      .where(and(eq(auditLog.chainSeq, afterSeq), isNotNull(auditLog.hash)))
      .orderBy(asc(auditLog.id))
      .limit(1);
    if (!cursor || cursor.hash === null) {
      return {
        ok: false,
        checked: 0,
        brokenSeq: String(afterSeq),
        nextAfterSeq: null,
        complete: false,
      };
    }
    expectedPrev = cursor.hash;
    bound = keysetBound(auditLog, cursor.id, auditLog.chainSeq, 'asc');
  }
  const rows = await db
    .select({
      chainSeq: auditLog.chainSeq,
      prevHash: auditLog.prevHash,
      hash: auditLog.hash,
      id: auditLog.id,
      actor: auditLog.actor,
      actorKind: auditLog.actorKind,
      subjectBusinessId: auditLog.subjectBusinessId,
      action: auditLog.action,
      target: auditLog.target,
      inputDigest: auditLog.inputDigest,
      detail: auditLog.detail,
      detailType: sql<string | null>`jsonb_typeof(${auditLog.detail})`,
      status: auditLog.status,
      durationMs: auditLog.durationMs,
      requestId: auditLog.requestId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(and(isNotNull(auditLog.hash), bound))
    .orderBy(asc(auditLog.chainSeq), asc(auditLog.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  let checked = 0;
  for (const row of page) {
    const detailOk = row.detailType === null || row.detailType === 'object';
    const detail = row.detailType === 'object' ? row.detail : null;
    if (!detailOk || row.prevHash !== expectedPrev || row.hash !== chainHash({ ...row, detail })) {
      return {
        ok: false,
        checked,
        brokenSeq: String(row.chainSeq),
        nextAfterSeq: null,
        complete: false,
      };
    }
    expectedPrev = row.hash;
    checked += 1;
  }
  const last = page.at(-1);
  return {
    ok: true,
    checked,
    brokenSeq: null,
    nextAfterSeq: hasMore && last ? last.chainSeq : null,
    complete: !hasMore,
  };
}

export interface AuditQuery {
  action?: string;
  status?: AuditStatus;
  target?: string;
  actor?: string;
  actorKind?: AuditActorKind;
  since?: Date;
  limit?: number;
  before?: Date;
  beforeId?: string;
  afterSeq?: number;
  order?: 'asc' | 'desc';
}

export interface AuditEntry {
  id: string;
  actor: string;
  actorKind: AuditActorKind;
  subjectBusinessId: string | null;
  action: string;
  target: string | null;
  status: string;
  durationMs: number | null;
  requestId: string | null;
  inputDigest: string | null;
  detail: Record<string, string | null> | null;
  detailType: string | null;
  createdAt: Date;
  chainSeq: number;
  prevHash: string | null;
  hash: string | null;
}

const columns = {
  id: auditLog.id,
  actor: auditLog.actor,
  actorKind: auditLog.actorKind,
  subjectBusinessId: auditLog.subjectBusinessId,
  action: auditLog.action,
  target: auditLog.target,
  status: auditLog.status,
  durationMs: auditLog.durationMs,
  requestId: auditLog.requestId,
  inputDigest: auditLog.inputDigest,
  detail: auditLog.detail,
  detailType: sql<string | null>`jsonb_typeof(${auditLog.detail})`,
  createdAt: auditLog.createdAt,
  chainSeq: auditLog.chainSeq,
  prevHash: auditLog.prevHash,
  hash: auditLog.hash,
};

function auditFilters(query: AuditQuery): SQL[] {
  const filters: SQL[] = [];
  if (query.action) filters.push(like(auditLog.action, `${escapeLike(query.action)}%`));
  if (query.status) filters.push(eq(auditLog.status, query.status));
  if (query.target) filters.push(eq(auditLog.target, query.target));
  if (query.actor) filters.push(eq(auditLog.actor, query.actor));
  if (query.actorKind) filters.push(eq(auditLog.actorKind, query.actorKind));
  if (query.since) filters.push(gte(auditLog.createdAt, query.since));
  return filters;
}

export function listAuditPage(db: Database, query: AuditQuery = {}) {
  const filters = auditFilters(query);
  if (query.before) filters.push(lt(auditLog.createdAt, query.before));
  return keysetPage(db, {
    table: auditLog,
    cursor: query.beforeId,
    limit: Math.min(Math.max(query.limit ?? 100, 1), 1001),
    where: filters,
    load: ({ where, limit }) =>
      db
        .select(columns)
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(limit),
  });
}

export async function listAudit(
  db: Database,
  query?: AuditQuery & { beforeId?: never; afterSeq?: never },
): Promise<AuditEntry[]>;
export async function listAudit(db: Database, query: AuditQuery): Promise<AuditEntry[] | null>;
export async function listAudit(
  db: Database,
  query: AuditQuery = {},
): Promise<AuditEntry[] | null> {
  if (query.beforeId !== undefined) return (await listAuditPage(db, query))?.items ?? null;

  const filters = auditFilters(query);
  if (query.before) filters.push(lt(auditLog.createdAt, query.before));
  if (query.afterSeq !== undefined && query.afterSeq > 0) {
    const [anchor] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(...filters, eq(auditLog.chainSeq, query.afterSeq)))
      .orderBy(asc(auditLog.id))
      .limit(1);
    if (!anchor) return null;
    filters.push(keysetBound(auditLog, anchor.id, auditLog.chainSeq, 'asc'));
  }
  return db
    .select(columns)
    .from(auditLog)
    .where(and(...filters))
    .orderBy(
      ...(query.order === 'asc'
        ? [asc(auditLog.chainSeq), asc(auditLog.id)]
        : [desc(auditLog.createdAt), desc(auditLog.id)]),
    )
    .limit(Math.min(Math.max(query.limit ?? 100, 1), 1001));
}
