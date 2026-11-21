import { securityContract } from '@agentport/contract/security';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type {
  ContentPolicy,
  PolicyApproval,
  PolicyEvent,
  ToolApprovalPolicy,
  ViolationCase,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { cursorOption, requireCursorPage } from '../../http/pagination.js';
import { toIso } from '../../lib/iso.js';

const security = repo.security;
const toolPolicies = repo.toolApprovalPolicies;
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

type ToolPolicyRow = repo.toolApprovalPolicies.ToolApprovalPolicyRow;

function toToolPolicy(row: ToolPolicyRow): ToolApprovalPolicy {
  return {
    id: row.id,
    agentId: row.agentId,
    serverId: row.serverId,
    toolId: row.toolId,
    role: row.role,
    httpMethod: row.httpMethod,
    pathTemplate: row.pathTemplate,
    approvalMode: row.approvalMode,
    enabled: row.enabled,
    version: row.version,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeToolPolicy(row: ToolPolicyRow): string {
  return JSON.stringify({
    id: row.id,
    serverId: row.serverId,
    agentId: row.agentId,
    toolId: row.toolId,
    role: row.role,
    httpMethod: row.httpMethod,
    approvalMode: row.approvalMode,
    enabled: row.enabled,
    version: row.version,
  });
}

async function validateToolPolicySelectors(
  context: RequestContext,
  selectors: {
    serverId: string | null;
    toolId: string | null;
    agentId: string | null;
    role: string | null;
  },
): Promise<void> {
  if (selectors.serverId !== null) {
    const server = await repo.servers.getServer(context.db, selectors.serverId);
    if (server === null || server.kind !== 'generated') {
      fail('INVALID_INPUT', '审批策略只能绑定生成的连接器', { path: '/body/serverId' });
    }
  }
  if (selectors.toolId !== null) {
    if (selectors.serverId === null) {
      fail('INVALID_INPUT', '指定工具时必须同时指定连接器', { path: '/body/toolId' });
    }
    const tool = await repo.servers.getApiTool(context.db, selectors.toolId);
    if (tool === null || tool.serverId !== selectors.serverId) {
      fail('INVALID_INPUT', '工具不属于该连接器', { path: '/body/toolId' });
    }
  }
  if (selectors.agentId !== null) {
    const agent = await repo.agents.getAgent(context.db, selectors.agentId);
    if (agent === null) fail('INVALID_INPUT', '专家不存在', { path: '/body/agentId' });
  }
  if (selectors.role?.startsWith('platform:')) {
    const roleId = selectors.role.slice('platform:'.length);
    if (!(await repo.access.roleExists(context.db, roleId))) {
      fail('INVALID_INPUT', '角色不存在', { path: '/body/role' });
    }
  }
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
      const page = requireCursorPage(
        await security.listPolicyEvents(context.db, {
          limit: query.limit,
          ...cursorOption(query.cursor),
          ...(query.sourceKind === undefined ? {} : { sourceKind: query.sourceKind }),
          ...(query.action === undefined ? {} : { action: query.action }),
        }),
      );

      return { items: page.items.map(toEvent), nextCursor: page.nextCursor };
    }),
  },
  approvals: {
    list: os.approvals.list.handler(async ({ input, context }) => {
      const query = input.query;
      const page = requireCursorPage(
        await security.listPolicyApprovals(context.db, {
          status: query.status,
          limit: query.limit,
          ...cursorOption(query.cursor),
        }),
      );

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
      const page = requireCursorPage(
        await security.listViolationCases(context.db, {
          limit: query.limit,
          ...cursorOption(query.cursor),
          ...(query.status === undefined ? {} : { status: query.status }),
        }),
      );

      return { items: page.items.map(toViolation), nextCursor: page.nextCursor };
    }),
    update: os.violations.update.handler(async ({ input, context }) => {
      const row = await security.updateViolationCase(context.db, input.params.id, input.body);
      if (row === null) fail('NOT_FOUND', '违规工单不存在');
      await audit(context, 'violation.updated', row.id, { status: row.status });
      return toViolation(row);
    }),
  },
  toolPolicies: {
    list: os.toolPolicies.list.handler(async ({ context }) =>
      (await toolPolicies.listToolApprovalPolicies(context.db)).map(toToolPolicy),
    ),
    create: os.toolPolicies.create.handler(async ({ input, context }) => {
      const actor = requireUser(context).businessId;
      await validateToolPolicySelectors(context, input.body);
      const row = await toolPolicies.create(context.db, input.body, actor);
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'security.tool_policy.created',
        target: row.id,
        detail: { policyId: row.id, to: serializeToolPolicy(row) },
        status: 'ok',
        requestId: context.requestId,
      });
      return toToolPolicy(row);
    }),
    update: os.toolPolicies.update.handler(async ({ input, context }) => {
      const actor = requireUser(context).businessId;
      const patch = input.body;
      const result = await toolPolicies.update(
        context.db,
        input.params.id,
        patch,
        actor,
        async (current) => {
          await validateToolPolicySelectors(context, {
            serverId: patch.serverId !== undefined ? patch.serverId : current.serverId,
            toolId: patch.toolId !== undefined ? patch.toolId : current.toolId,
            agentId: patch.agentId !== undefined ? patch.agentId : current.agentId,
            role: patch.role !== undefined ? patch.role : current.role,
          });
        },
      );
      if (result === null) fail('NOT_FOUND', '审批策略不存在');
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'security.tool_policy.updated',
        target: result.updated.id,
        detail: {
          policyId: result.updated.id,
          from: serializeToolPolicy(result.previous),
          to: serializeToolPolicy(result.updated),
        },
        status: 'ok',
        requestId: context.requestId,
      });
      return toToolPolicy(result.updated);
    }),
    remove: os.toolPolicies.remove.handler(async ({ input, context }) => {
      const row = await toolPolicies.delete(context.db, input.params.id);
      if (row === null) fail('NOT_FOUND', '审批策略不存在');
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'security.tool_policy.deleted',
        target: row.id,
        detail: { policyId: row.id, from: serializeToolPolicy(row), to: null },
        status: 'ok',
        requestId: context.requestId,
      });
    }),
  },
});
