import { type Database, repo, schema } from '@agentport/db';
import {
  agentPermissionAllows,
  type ExecutionSubject,
  type PermissionGrant,
} from '@agentport/shared';
import { and, eq } from 'drizzle-orm';

export type RunAccessDenial = {
  reason: 'account_inactive' | 'permission_denied' | 'invalid_subject';
  message: string;
};

/** run 行里的主体字段 → 公共主体；用户与服务各只保留一种，非法组合不猜。 */
export function runExecutionSubject(row: {
  subjectKind: string;
  initiatedBy: string | null;
  serviceId: string | null;
}): ExecutionSubject | null {
  if (row.subjectKind === 'user' && row.initiatedBy !== null && row.serviceId === null) {
    return { kind: 'user', businessId: row.initiatedBy };
  }
  if (
    row.subjectKind === 'service' &&
    row.initiatedBy === null &&
    (row.serviceId === 'system' || row.serviceId === 'mcp')
  ) {
    return { kind: 'service', serviceId: row.serviceId };
  }
  return null;
}

export async function loadUserAgentAccess(
  db: Database,
  input: {
    businessId: string;
    agentId: string;
    permissions: ReadonlyArray<PermissionGrant['permissionId']>;
  },
): Promise<{ denial: RunAccessDenial | null; grants: PermissionGrant[] }> {
  const identity = await repo.accounts.getIdentity(db, input.businessId);
  if (!identity?.accountActive) {
    return {
      denial: { reason: 'account_inactive', message: '账户已停用或不存在，运行未启动' },
      grants: [],
    };
  }
  const access = await repo.access.getUserAccess(db, input.businessId);
  const relation = await repo.access.getAgentRelation(db, input.agentId, input.businessId);
  for (const permissionId of input.permissions) {
    if (!agentPermissionAllows(access.grants, permissionId, relation, input.businessId)) {
      return {
        denial: {
          reason: 'permission_denied',
          message: '当前账户没有该操作的专家权限，运行未启动',
        },
        grants: access.grants,
      };
    }
  }
  return { denial: null, grants: access.grants };
}

export async function checkUserAgentAccess(
  db: Database,
  input: {
    businessId: string;
    agentId: string;
    permissions: ReadonlyArray<PermissionGrant['permissionId']>;
  },
): Promise<RunAccessDenial | null> {
  return (await loadUserAgentAccess(db, input)).denial;
}

function objectPermissionAllows(
  grants: readonly PermissionGrant[],
  permissionId: PermissionGrant['permissionId'],
  ownerBusinessId: string | null,
  businessId: string,
): boolean {
  return grants.some((grant) => {
    if (grant.permissionId !== permissionId) return false;
    return (
      grant.scope === 'platform' || (grant.scope === 'own_data' && ownerBusinessId === businessId)
    );
  });
}

export async function checkQueuedAgentActive(
  db: Database,
  agentId: string,
): Promise<RunAccessDenial | null> {
  const [agent] = await db
    .select({ archivedAt: schema.agents.archivedAt, deletedAt: schema.agents.deletedAt })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  if (!agent) {
    return { reason: 'invalid_subject', message: '专家不存在，运行未启动' };
  }
  if (repo.agentLifecycle.isAgentInactive(agent)) {
    return { reason: 'permission_denied', message: '该专家已归档或删除，运行未启动' };
  }
  return null;
}

const QUEUED_DENIED = '当前账户没有该操作的权限，运行未启动';
const QUEUED_SOURCE_MISMATCH = '运行来源与数据库记录不一致，未启动';

export async function checkQueuedRunAccess(
  db: Database,
  run: {
    runId: string;
    trigger: 'chat' | 'mcp' | 'schedule' | 'event' | 'review' | 'channel';
    agentId: string;
    conversationId: string;
    businessId: string;
    channelId: string | null;
    evalRunId: string | null;
  },
): Promise<RunAccessDenial | null> {
  const identity = await repo.accounts.getIdentity(db, run.businessId);
  if (!identity?.accountActive) {
    return { reason: 'account_inactive', message: '账户已停用或不存在，运行未启动' };
  }
  const access = await repo.access.getUserAccess(db, run.businessId);
  const relation = await repo.access.getAgentRelation(db, run.agentId, run.businessId);
  const denied = (): RunAccessDenial => ({
    reason: 'permission_denied',
    message: QUEUED_DENIED,
  });
  if (relation.inactive) return denied();
  if (
    run.trigger !== 'channel' &&
    !agentPermissionAllows(access.grants, 'agents.use', relation, run.businessId)
  ) {
    return denied();
  }

  switch (run.trigger) {
    case 'channel': {
      if (run.channelId === null) {
        return { reason: 'invalid_subject', message: QUEUED_SOURCE_MISMATCH };
      }
      const lane = await repo.channels.getRunChannelAccess(db, {
        channelId: run.channelId,
        agentId: run.agentId,
        conversationId: run.conversationId,
        businessId: run.businessId,
      });
      if (
        !lane ||
        lane.conversationChannelId !== run.channelId ||
        lane.conversationAgentId !== run.agentId
      ) {
        return { reason: 'invalid_subject', message: QUEUED_SOURCE_MISMATCH };
      }
      if (
        lane.archivedAt !== null ||
        lane.role === null ||
        lane.role === 'viewer' ||
        lane.bindingStatus !== 'active'
      ) {
        return denied();
      }
      return null;
    }
    case 'chat': {
      const [conversation] = await db
        .select({ createdBy: schema.conversations.createdBy })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, run.conversationId))
        .limit(1);
      if (
        !conversation ||
        !objectPermissionAllows(
          access.grants,
          'conversations.create',
          conversation.createdBy,
          run.businessId,
        )
      ) {
        return denied();
      }
      return null;
    }
    case 'schedule': {
      const [schedule] = await db
        .select({ id: schema.agentSchedules.id })
        .from(schema.agentSchedules)
        .where(
          and(
            eq(schema.agentSchedules.agentId, run.agentId),
            eq(schema.agentSchedules.executeAsBusinessId, run.businessId),
          ),
        )
        .limit(1);
      if (
        !schedule ||
        !agentPermissionAllows(access.grants, 'schedules.manage', relation, run.businessId)
      ) {
        return denied();
      }
      return null;
    }
    case 'event': {
      if (run.evalRunId !== null) {
        const [evalRun] = await db
          .select({
            agentId: schema.evalRuns.agentId,
            createdBy: schema.evalRuns.createdBy,
            status: schema.evalRuns.status,
          })
          .from(schema.evalRuns)
          .where(eq(schema.evalRuns.id, run.evalRunId))
          .limit(1);
        if (!evalRun || evalRun.agentId !== run.agentId || evalRun.createdBy !== run.businessId) {
          return { reason: 'invalid_subject', message: QUEUED_SOURCE_MISMATCH };
        }
        if (evalRun.status !== 'running') return denied();
        return agentPermissionAllows(access.grants, 'eval.execute', relation, run.businessId)
          ? null
          : denied();
      }
      const [conversation] = await db
        .select({ createdBy: schema.conversations.createdBy })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, run.conversationId))
        .limit(1);
      if (!conversation) {
        return { reason: 'invalid_subject', message: QUEUED_SOURCE_MISMATCH };
      }
      return objectPermissionAllows(
        access.grants,
        'conversations.update',
        conversation.createdBy,
        run.businessId,
      )
        ? null
        : denied();
    }
    case 'review': {
      const [review] = await db
        .select({
          businessId: schema.memoryReviews.businessId,
          modelAgentId: schema.memoryReviews.modelAgentId,
          decision: schema.memoryReviews.decision,
        })
        .from(schema.memoryReviews)
        .where(eq(schema.memoryReviews.runId, run.runId))
        .limit(1);
      if (!review || review.businessId !== run.businessId || review.modelAgentId !== run.agentId) {
        return { reason: 'invalid_subject', message: QUEUED_SOURCE_MISMATCH };
      }
      if (review.decision !== 'pending') {
        return { reason: 'permission_denied', message: '审核已拒绝，未执行' };
      }
      if (
        !objectPermissionAllows(
          access.grants,
          'personal_memory.review',
          run.businessId,
          run.businessId,
        )
      ) {
        return denied();
      }
      return null;
    }
    default:
      return { reason: 'invalid_subject', message: QUEUED_SOURCE_MISMATCH };
  }
}
