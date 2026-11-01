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
  createdAt: Date;
  approvedAt: Date | null;
  expiresAt: Date | null;
}

export interface ApprovedChannelApproval extends ChannelApprovalItem {
  approvedByBusinessId: string;
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
      createdAt: approvalRequests.createdAt,
      approvedAt: approvalRequests.approvedAt,
      expiresAt: approvalRequests.expiresAt,
    })
    .from(approvalRequests)
    .innerJoin(agentRuns, eq(agentRuns.id, approvalRequests.runId))
    .leftJoin(servers, eq(servers.id, approvalRequests.serverId))
    .where(
      and(
        eq(approvalRequests.channelId, input.channelId),
        eq(agentRuns.channelId, input.channelId),
        inArray(agentRuns.status, ['queued', 'running']),
        isNull(approvalRequests.approvedAt),
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

/**
 * 频道工具审批：owner/admin，或触发该 run 的 member 可以批准；viewer 与其余成员拒绝。
 * 先锁 run 行再 CAS 审批行：并发批准只有一个赢家，输家明确返回 conflict。
 */
export async function approveChannelApproval(
  db: Database,
  input: { channelId: string; approvalId: string; businessId: string },
): Promise<Decision> {
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
        createdAt: approvalRequests.createdAt,
        approvedAt: approvalRequests.approvedAt,
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
    if (run.status !== 'queued' && run.status !== 'running') {
      return { kind: 'conflict', reason: 'run_inactive' };
    }
    if (approval.approvedAt !== null) return { kind: 'conflict', reason: 'decided' };
    if (approval.expiresAt !== null && approval.expiresAt.getTime() <= Date.now()) {
      return { kind: 'conflict', reason: 'expired' };
    }

    const [approved] = await tx
      .update(approvalRequests)
      .set({ approvedAt: sql`now()`, approvedByBusinessId: input.businessId })
      .where(
        and(
          eq(approvalRequests.id, input.approvalId),
          eq(approvalRequests.channelId, input.channelId),
          isNull(approvalRequests.approvedAt),
        ),
      )
      .returning({
        id: approvalRequests.id,
        channelId: approvalRequests.channelId,
        runId: approvalRequests.runId,
        serverId: approvalRequests.serverId,
        toolName: approvalRequests.toolName,
        createdAt: approvalRequests.createdAt,
        approvedAt: approvalRequests.approvedAt,
        approvedByBusinessId: approvalRequests.approvedByBusinessId,
        expiresAt: approvalRequests.expiresAt,
      });
    // 锁 run 后仍可能读到旧快照：CAS 落空说明另一事务已决定，按输家处理。
    if (!approved || approved.runId === null || approved.approvedByBusinessId === null) {
      return { kind: 'conflict', reason: 'decided' };
    }
    return {
      kind: 'ok',
      approval: {
        ...approved,
        runId: approved.runId,
        channelId: approved.channelId ?? input.channelId,
        serverName: approval.serverName,
        approvedByBusinessId: approved.approvedByBusinessId,
      },
    };
  });
}
