import { auditContract } from '@agentport/contract/audit';
import { repo } from '@agentport/db';
import type { AuditActorKind } from '@agentport/shared';
import { implement } from '@orpc/server';
import type { RequestContext } from '../../http/context.js';
import { requireCursorPage } from '../../http/pagination.js';

const os = implement(auditContract).$context<RequestContext>();

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
  status?: 'ok' | 'error' | 'denied' | undefined;
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

export const auditRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    const page = requireCursorPage(
      await repo.audit.listAuditPage(context.db, auditOptions(input.query)),
    );
    return { items: page.items.map(toItem), nextCursor: page.nextCursor };
  }),
  verify: os.verify.handler(async ({ input, context }) =>
    repo.audit.verifyAuditChain(context.db, {
      ...(input.query.afterSeq === undefined ? {} : { afterSeq: input.query.afterSeq }),
      ...(input.query.limit === undefined ? {} : { limit: input.query.limit }),
    }),
  ),
});
