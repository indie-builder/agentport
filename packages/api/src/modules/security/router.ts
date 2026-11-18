import { securityContract } from '@agentport/contract/security';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { ContentPolicy, PolicyApproval, PolicyEvent, ViolationCase } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { toIso } from '../../lib/iso.js';

const security = repo.security;
const os = implement(securityContract).$context<RequestContext>();

async function audit(context: RequestContext, action: string, target: string, input?: unknown) {
  await repo.audit.writeAudit(context.db, context.log, {
    actor: actorOf(context),
    action: `security.${action}`,
    target,
    input,
    status: 'ok',
    requestId: context.requestId,
  });
}

function toPolicy(row: repo.security.ContentPolicyRow): ContentPolicy {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    direction: row.direction,
    action: row.action,
    matchType: row.matchType,
    pattern: row.pattern,
    caseSensitive: row.caseSensitive,
    agentId: row.agentId,
    priority: row.priority,
    enabled: row.enabled,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toEvent(row: repo.security.PolicyEventRow): PolicyEvent {
  return {
    id: row.id,
    policyId: row.policyId,
    policyName: row.policyName,
    policyVersion: row.policyVersion,
    direction: row.direction,
    action: row.action,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    runId: row.runId,
    channelId: row.channelId,
    actor: row.actor,
    snippet: row.snippet,
    destination: row.destination,
    createdAt: row.createdAt.toISOString(),
  };
}

function toApproval(row: repo.security.PolicyApprovalRow): PolicyApproval {
  return {
    id: row.id,
    policyId: row.policyId,
    policyName: row.policyName,
    policyVersion: row.policyVersion,
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    runId: row.runId,
    channelId: row.channelId,
    payloadHash: row.payloadHash,
    destination: row.destination,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: toIso(row.decidedAt),
    expiresAt: row.expiresAt.toISOString(),
    note: row.note,
    consumedAt: toIso(row.consumedAt),
  };
}

function toViolation(row: repo.security.ViolationCaseRow): ViolationCase {
  return {
    id: row.id,
    policyId: row.policyId,
    policyName: row.policyName,
    eventId: row.eventId,
    runId: row.runId,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    severity: row.severity,
    status: row.status,
    assigneeBusinessId: row.assigneeBusinessId,
    summary: row.summary,
    resolution: row.resolution,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const securityRouter = os.router({
  policies: {
    list: os.policies.list.handler(async ({ context }) =>
      (await security.listContentPolicies(context.db)).map(toPolicy),
    ),
    create: os.policies.create.handler(async ({ input, context }) => {
      const row = await security.createContentPolicy(
        context.db,
        input.body,
        requireUser(context).businessId,
      );
      await audit(context, 'policy.created', row.id, {
        matchType: row.matchType,
        direction: row.direction,
        action: row.action,
      });
      return toPolicy(row);
    }),
    update: os.policies.update.handler(async ({ input, context }) => {
      const row = await security.updateContentPolicy(context.db, input.params.id, input.body);
      if (row === null) fail('NOT_FOUND', '内容策略不存在');
      await audit(context, 'policy.updated', row.id, {
        matchType: row.matchType,
        direction: row.direction,
        action: row.action,
      });
      return toPolicy(row);
    }),
    remove: os.policies.remove.handler(async ({ input, context }) => {
      const removed = await security.deleteContentPolicy(context.db, input.params.id);
      if (!removed) fail('NOT_FOUND', '内容策略不存在');
      await audit(context, 'policy.deleted', input.params.id);
    }),
  },
  events: {
    list: os.events.list.handler(async ({ input, context }) => {
      const query = input.query;
      const page = await security.listPolicyEvents(context.db, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.sourceKind === undefined ? {} : { sourceKind: query.sourceKind }),
        ...(query.action === undefined ? {} : { action: query.action }),
      });
      if (page === null) fail('NOT_FOUND', '安全事件游标无效，请刷新后重试');
      return { items: page.items.map(toEvent), nextCursor: page.nextCursor };
    }),
  },
  approvals: {
    list: os.approvals.list.handler(async ({ input, context }) => {
      const query = input.query;
      const page = await security.listPolicyApprovals(context.db, {
        status: query.status,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      if (page === null) fail('NOT_FOUND', '审批游标无效，请刷新后重试');
      return { items: page.items.map(toApproval), nextCursor: page.nextCursor };
    }),
    decide: os.approvals.decide.handler(async ({ input, context }) => {
      const principal = requireUser(context);
      const row = await context.db.transaction(async (tx) => {
        const approval = await security.decidePolicyApproval(tx, {
          id: input.params.id,
          decision: input.body.decision,
          decidedBy: principal.businessId,
          ...(input.body.note === undefined ? {} : { note: input.body.note }),
        });
        if (approval === null) return null;
        await repo.audit.writeAuditInTx(tx, {
          actor: actorOf(context),
          action: 'security.approval.decided',
          target: approval.id,
          input: { decision: input.body.decision },
          status: 'ok',
          requestId: context.requestId,
        });
        return approval;
      });
      if (row === null) fail('CONFLICT', '审批已处理或已过期');
      await repo.notifications.createNotification(context.db, {
        businessId: row.requestedBy,
        kind: 'policy_approval',
        title: input.body.decision === 'approve' ? '内容外发已批准' : '内容外发已驳回',
        body: `策略「${row.policyName}」的审批已处理`,
        link: '/security?tab=approvals',
        sourceId: `policy-approval-decision:${row.id}`,
      });
      return toApproval(row);
    }),
  },
  violations: {
    list: os.violations.list.handler(async ({ input, context }) => {
      const query = input.query;
      const page = await security.listViolationCases(context.db, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.status === undefined ? {} : { status: query.status }),
      });
      if (page === null) fail('NOT_FOUND', '违规工单游标无效，请刷新后重试');
      return { items: page.items.map(toViolation), nextCursor: page.nextCursor };
    }),
    update: os.violations.update.handler(async ({ input, context }) => {
      const row = await security.updateViolationCase(context.db, input.params.id, input.body);
      if (row === null) fail('NOT_FOUND', '违规工单不存在');
      await audit(context, 'violation.updated', row.id, { status: row.status });
      return toViolation(row);
    }),
  },
});
