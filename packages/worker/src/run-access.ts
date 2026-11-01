import { type Database, repo, schema } from '@agentport/db';
import type { ExecutionSubject, PermissionGrant } from '@agentport/shared';
import { and, eq } from 'drizzle-orm';
export type AgentRelation = {
  exists: boolean;
  ownerBusinessId: string | null;
  canUse: boolean;
  canMaintain: boolean;
};

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

/**
 * 与 shared 目录一致的单个 grant 范围判定：同一条授权必须同时匹配权限叶和对象范围，
 * 多角色结果不能拼接。平台范围也只对真实存在的对象生效。
 */
export function agentPermissionAllows(
  grants: readonly PermissionGrant[],
  permissionId: PermissionGrant['permissionId'],
  relation: AgentRelation,
  businessId: string,
): boolean {
  if (!relation.exists) return false;
  const owner = relation.ownerBusinessId === businessId;
  return grants.some((grant) => {
    if (grant.permissionId !== permissionId) return false;
    switch (grant.scope) {
      case 'platform':
        return true;
      case 'authorized_agents':
        return owner || relation.canUse;
      case 'maintained_agents':
        return owner || relation.canMaintain;
      case 'owned_agents':
        return owner;
      default:
        return false;
    }
  });
}

/**
 * worker 开跑前用 DB 实时数据重查：认证账户仍活跃，且每个所需权限叶都有匹配该专家的范围。
 * 不降级成 system/admin；服务主体不调用本函数。返回 grants 供调用方按同一组授权收紧查询。
 */
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

/**
 * own_data/platform 对象叶：只有对象归属本人或平台范围才通过。
 * 不能用 agentPermissionAllows：它按专家关系判定，而个人数据的对象拥有者是 businessId。
 */
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

const QUEUED_DENIED = '当前账户没有该操作的权限，运行未启动';
const QUEUED_SOURCE_MISMATCH = '运行来源与数据库记录不一致，未启动';

/**
 * 排队 run 启动前的实时复核：账户、agents.use 之外还要按 DB 里的 run.trigger 复核具体动作。
 * 来源与主体一律从 run 行及关联 DB 记录读取，不信任 job 字段，也不降级成 system/admin。
 */
export async function checkQueuedRunAccess(
  db: Database,
  run: {
    runId: string;
    trigger: 'chat' | 'mcp' | 'schedule' | 'event' | 'review' | 'channel';
    agentId: string;
    conversationId: string;
    businessId: string;
    channelId: string | null;
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
  // 频道成员资格就是频道 lane 的授权来源：不再要求平台的 agents.use 专家范围。
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
      const [lane] = await db
        .select({
          role: schema.channelMembers.role,
          bindingStatus: schema.channelAgentBindings.status,
          archivedAt: schema.channels.archivedAt,
          conversationChannelId: schema.conversations.channelId,
          conversationAgentId: schema.conversations.agentId,
        })
        .from(schema.channelAgentBindings)
        .innerJoin(schema.conversations, eq(schema.conversations.id, run.conversationId))
        .innerJoin(schema.channels, eq(schema.channels.id, run.channelId))
        .leftJoin(
          schema.channelMembers,
          and(
            eq(schema.channelMembers.channelId, run.channelId),
            eq(schema.channelMembers.businessId, run.businessId),
          ),
        )
        .where(
          and(
            eq(schema.channelAgentBindings.channelId, run.channelId),
            eq(schema.channelAgentBindings.agentId, run.agentId),
            eq(schema.channelAgentBindings.conversationId, run.conversationId),
          ),
        )
        .limit(1);
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
      // 没有 run→schedule 外键：用「专家 + DB 执行主体」确认这次触发确实来自该用户的定时任务。
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
      // 评估用例运行在 DB 标记为 event；必须仍有一场本人发起、同专家且在跑的评估。
      const [evalRun] = await db
        .select({ id: schema.evalRuns.id })
        .from(schema.evalRuns)
        .where(
          and(
            eq(schema.evalRuns.agentId, run.agentId),
            eq(schema.evalRuns.createdBy, run.businessId),
            eq(schema.evalRuns.status, 'running'),
          ),
        )
        .limit(1);
      if (
        !evalRun ||
        !agentPermissionAllows(access.grants, 'eval.execute', relation, run.businessId)
      ) {
        return denied();
      }
      return null;
    }
    case 'review': {
      const [review] = await db
        .select({
          businessId: schema.memoryReviews.businessId,
          modelAgentId: schema.memoryReviews.modelAgentId,
        })
        .from(schema.memoryReviews)
        .where(eq(schema.memoryReviews.runId, run.runId))
        .limit(1);
      if (!review || review.businessId !== run.businessId || review.modelAgentId !== run.agentId) {
        return { reason: 'invalid_subject', message: QUEUED_SOURCE_MISMATCH };
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
