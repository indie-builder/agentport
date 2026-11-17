import { ACTIVE_RUN_STATUSES, isActiveRunStatus } from '@agentport/shared';
import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { agentRuns, approvalRequests, servers } from '../schema.js';
import { channelMemberRole } from './channels.js';

export interface ChannelApprovalItem {
  id: string;
  channelId: string;
  runId: string;
  serverId: string;
  serverName: string | null;
  toolName: string;
  argumentsSummary: Record<string, unknown> | null;
  createdAt: Date;
  approvedAt: Date | null;
  deniedAt: Date | null;
  expiresAt: Date | null;
}

export interface ApprovedChannelApproval extends ChannelApprovalItem {
  approvedByBusinessId: string;
}

export interface DeniedChannelApproval extends ChannelApprovalItem {
  deniedByBusinessId: string;
}

type NotFound = { kind: 'not_found' };

/** 未决审批：活动 run、尚未批准、未过期的频道行。 */
export async function listChannelApprovals(
  db: Database,
  input: { channelId: string; businessId: string },
): Promise<{ kind: 'ok'; items: ChannelApprovalItem[] } | NotFound> {
  // 频道审批只对真实成员开放；平台管理员非成员时同样按不存在处理。
  if ((await channelMemberRole(db, input.channelId, input.businessId)) === null) {
    return { kind: 'not_found' };
  }

  const rows = await db
    .select({
      id: approvalRequests.id,
      channelId: approvalRequests.channelId,
      runId: approvalRequests.runId,
      serverId: approvalRequests.serverId,
      serverName: servers.name,
      toolName: approvalRequests.toolName,
      argumentsSummary: approvalRequests.argumentsSummary,
      createdAt: approvalRequests.createdAt,
      approvedAt: approvalRequests.approvedAt,
      deniedAt: approvalRequests.deniedAt,
      expiresAt: approvalRequests.expiresAt,
    })
    .from(approvalRequests)
    .innerJoin(agentRuns, eq(agentRuns.id, approvalRequests.runId))
    .leftJoin(servers, eq(servers.id, approvalRequests.serverId))
    .where(
      and(
        eq(approvalRequests.channelId, input.channelId),
        eq(agentRuns.channelId, input.channelId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        isNull(approvalRequests.approvedAt),
        isNull(approvalRequests.deniedAt),
        or(isNull(approvalRequests.expiresAt), gt(approvalRequests.expiresAt, new Date())),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id));

  // where 已限定两个频道列相等；join 后 runId 也必然存在，这里只做类型收窄。
  return {
    kind: 'ok',
    items: rows.flatMap((row): ChannelApprovalItem[] =>
      row.channelId === null || row.runId === null
        ? []
        : [{ ...row, channelId: row.channelId, runId: row.runId }],
    ),
  };
}

type Decision =
  | { kind: 'ok'; approval: ApprovedChannelApproval }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' }
  | { kind: 'conflict'; reason: 'decided' | 'expired' | 'run_inactive' };

type DenyDecision =
  | { kind: 'ok'; approval: DeniedChannelApproval }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' }
  | { kind: 'conflict'; reason: 'decided' | 'expired' | 'run_inactive' };

type ChannelDecision =
  | { kind: 'ok'; approval: ChannelApprovalItem; decidedByBusinessId: string }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' }
  | { kind: 'conflict'; reason: 'decided' | 'expired' | 'run_inactive' };

async function decideChannelApproval(
  db: Database,
  input: { channelId: string; approvalId: string; businessId: string },
  decision: 'approve' | 'deny',
): Promise<ChannelDecision> {
  return db.transaction(async (tx) => {
    const role = await channelMemberRole(tx, input.channelId, input.businessId);
    if (role === null) return { kind: 'not_found' };
    if (role === 'viewer') return { kind: 'forbidden', reason: 'channel_role' };

    const [approval] = await tx
      .select({
        runId: approvalRequests.runId,
        serverId: approvalRequests.serverId,
        serverName: servers.name,
        toolName: approvalRequests.toolName,
        argumentsSummary: approvalRequests.argumentsSummary,
        createdAt: approvalRequests.createdAt,
        approvedAt: approvalRequests.approvedAt,
        deniedAt: approvalRequests.deniedAt,
        expiresAt: approvalRequests.expiresAt,
      })
      .from(approvalRequests)
      .leftJoin(servers, eq(servers.id, approvalRequests.serverId))
      .where(
        and(
          eq(approvalRequests.id, input.approvalId),
          eq(approvalRequests.channelId, input.channelId),
        ),
      )
      .limit(1);
    if (!approval || approval.runId === null) return { kind: 'not_found' };

    const [run] = await tx
      .select({
        channelId: agentRuns.channelId,
        status: agentRuns.status,
        initiatedBy: agentRuns.initiatedBy,
      })
      .from(agentRuns)
      .where(eq(agentRuns.id, approval.runId))
      .limit(1)
      .for('update');
    // 审批行与 run 必须同属本频道；跨频道 id 一律按不存在处理。
    if (!run || run.channelId !== input.channelId) return { kind: 'not_found' };
    if (role === 'member' && run.initiatedBy !== input.businessId) {
      return { kind: 'forbidden', reason: 'channel_role' };
    }
    if (!isActiveRunStatus(run.status)) {
      return { kind: 'conflict', reason: 'run_inactive' };
    }
    if (approval.approvedAt !== null || approval.deniedAt !== null) {
      return { kind: 'conflict', reason: 'decided' };
    }
    if (approval.expiresAt !== null && approval.expiresAt.getTime() <= Date.now()) {
      return { kind: 'conflict', reason: 'expired' };
    }

    const [decided] = await tx
      .update(approvalRequests)
      .set(
        decision === 'approve'
          ? { approvedAt: sql`now()`, approvedByBusinessId: input.businessId }
          : { deniedAt: sql`now()`, deniedByBusinessId: input.businessId },
      )
      .where(
        and(
          eq(approvalRequests.id, input.approvalId),
          eq(approvalRequests.channelId, input.channelId),
          isNull(approvalRequests.approvedAt),
          isNull(approvalRequests.deniedAt),
        ),
      )
      .returning({
        id: approvalRequests.id,
        channelId: approvalRequests.channelId,
        runId: approvalRequests.runId,
        serverId: approvalRequests.serverId,
        toolName: approvalRequests.toolName,
        argumentsSummary: approvalRequests.argumentsSummary,
        createdAt: approvalRequests.createdAt,
        approvedAt: approvalRequests.approvedAt,
        deniedAt: approvalRequests.deniedAt,
        approvedByBusinessId: approvalRequests.approvedByBusinessId,
        deniedByBusinessId: approvalRequests.deniedByBusinessId,
        expiresAt: approvalRequests.expiresAt,
      });
    const decidedByBusinessId =
      decision === 'approve' ? decided?.approvedByBusinessId : decided?.deniedByBusinessId;
    // 锁 run 后仍可能读到旧快照：CAS 落空说明另一事务已决定，按输家处理。
    if (!decided || decided.runId === null || decidedByBusinessId == null) {
      return { kind: 'conflict', reason: 'decided' };
    }
    return {
      kind: 'ok',
      approval: {
        ...decided,
        runId: decided.runId,
        channelId: decided.channelId ?? input.channelId,
        serverName: approval.serverName,
      },
      decidedByBusinessId,
    };
  });
}

export async function approveChannelApproval(
  db: Database,
  input: { channelId: string; approvalId: string; businessId: string },
): Promise<Decision> {
  const result = await decideChannelApproval(db, input, 'approve');
  if (result.kind !== 'ok') return result;
  return {
    kind: 'ok',
    approval: { ...result.approval, approvedByBusinessId: result.decidedByBusinessId },
  };
}

export async function denyChannelApproval(
  db: Database,
  input: { channelId: string; approvalId: string; businessId: string },
): Promise<DenyDecision> {
  const result = await decideChannelApproval(db, input, 'deny');
  if (result.kind !== 'ok') return result;
  return {
    kind: 'ok',
    approval: { ...result.approval, deniedByBusinessId: result.decidedByBusinessId },
  };
}
