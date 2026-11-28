import type { repo } from '@agentport/db';
import type { AuditActorKind, AuditStatus } from '@agentport/shared';

export function toItem(row: repo.audit.AuditEntry) {
  return {
    id: row.id,
    actor: row.actor,
    actorKind: row.actorKind,
    subjectBusinessId: row.subjectBusinessId,
    action: row.action,
    target: row.target,
    status: row.status,
    durationMs: row.durationMs,
    requestId: row.requestId,
    inputDigest: row.inputDigest,
    detail: row.detail,
    detailType: row.detailType,
    createdAt: row.createdAt.toISOString(),
  };
}

type AuditQueryParams = {
  action?: string | undefined;
  status?: AuditStatus | undefined;
  target?: string | undefined;
  actor?: string | undefined;
  actorKind?: AuditActorKind | undefined;
  since?: string | undefined;
  limit?: number | undefined;
  before?: string | undefined;
  cursor?: string | undefined;
};

export function auditOptions(query: AuditQueryParams): repo.audit.AuditQuery {
  const { action, status, target, actor, actorKind, since, limit, before, cursor } = query;
  return {
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(target ? { target } : {}),
    ...(actor ? { actor } : {}),
    ...(actorKind ? { actorKind } : {}),
    ...(since === undefined ? {} : { since: new Date(since) }),
    ...(limit === undefined ? {} : { limit }),
    ...(before === undefined ? {} : { before: new Date(before) }),
    ...(cursor === undefined ? {} : { beforeId: cursor }),
  };
}
