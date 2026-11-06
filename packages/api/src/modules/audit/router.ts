import { auditContract } from '@agentport/contract/audit';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import type { RequestContext } from '../../http/context.js';

const os = implement(auditContract).$context<RequestContext>();

type Row = Awaited<ReturnType<typeof repo.audit.listAudit>>[number];

function toItem(row: Row) {
  return {
    id: row.id,
    actor: row.actor,
    action: row.action,
    target: row.target,
    status: row.status,
    durationMs: row.durationMs,
    requestId: row.requestId,
    inputDigest: row.inputDigest,
    createdAt: row.createdAt.toISOString(),
  };
}

type Query = {
  action?: string | undefined;
  status?: 'ok' | 'error' | 'denied' | undefined;
  target?: string | undefined;
  limit?: number | undefined;
  before?: string | undefined;
  beforeId?: string | undefined;
};

function auditOptions(query: Query): repo.audit.AuditQuery {
  const { action, status, target, limit, before, beforeId } = query;
  return {
    ...(action ? { action } : {}),
    ...(status ? { status } : {}),
    ...(target ? { target } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(before === undefined ? {} : { before: new Date(before) }),
    ...(beforeId === undefined ? {} : { beforeId }),
  };
}

export const auditRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    const options = auditOptions(input.query);
    const rows = await repo.audit.listAudit(context.db, options);
    if (
      input.query.beforeId !== undefined &&
      rows.length === 0 &&
      !(await repo.audit.auditEntryExists(context.db, input.query.beforeId))
    ) {
      fail('INVALID_INPUT', '分页游标无效');
    }
    return { items: rows.map(toItem) };
  }),
});
