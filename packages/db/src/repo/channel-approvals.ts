import { ACTIVE_RUN_STATUSES, isActiveRunStatus } from '@agentport/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { Database } from '../client.js';
import { agentRuns, approvalRequests, servers } from '../schema.js';
import { allows, channelMemberRole } from './channels.js';
import { applyApprovalDecision, lockRunForApproval, type RecheckApproval } from './runs.js';

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

export async function listChannelApprovals(
  db: Database,
  input: { channelId: string; businessId: string },
): Promise<{ kind: 'ok'; items: ChannelApprovalItem[] } | NotFound> {
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
        isNull(approvalRequests.supersededAt),
        isNotNull(approvalRequests.decisionHash),
        or(isNull(approvalRequests.expiresAt), gt(approvalRequests.expiresAt, new Date())),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt), asc(approvalRequests.id));

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
  | { kind: 'conflict'; reason: 'decided' | 'expired' | 'run_inactive' | 'decision_changed' };

type DenyDecision =
  | { kind: 'ok'; approval: DeniedChannelApproval }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' }
  | { kind: 'conflict'; reason: 'decided' | 'expired' | 'run_inactive' | 'decision_changed' };

type ChannelDecision =
  | { kind: 'ok'; approval: ChannelApprovalItem; decidedByBusinessId: string }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' }
  | { kind: 'conflict'; reason: 'decided' | 'expired' | 'run_inactive' | 'decision_changed' };

async function decideChannelApproval(
  db: Database,
  input: { channelId: string; approvalId: string; businessId: string },
  decision: 'approve' | 'deny',
  recheck: RecheckApproval,
): Promise<ChannelDecision> {
  return db.transaction(async (tx) => {
    const role = await channelMemberRole(tx, input.channelId, input.businessId);
    if (role === null) return { kind: 'not_found' };
    if (!allows(role, 'post')) return { kind: 'forbidden', reason: 'channel_role' };

    const [approval] = await tx
      .select({
        runId: approvalRequests.runId,
        serverId: approvalRequests.serverId,
        serverName: servers.name,
        toolName: approvalRequests.toolName,
        argumentsSummary: approvalRequests.argumentsSummary,
        decisionHash: approvalRequests.decisionHash,
        supersededAt: approvalRequests.supersededAt,
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

    const run = await lockRunForApproval(tx, approval.runId);
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

    const result = await applyApprovalDecision(
      tx,
      {
        approvalId: input.approvalId,
        runId: approval.runId,
        serverId: approval.serverId,
        toolName: approval.toolName,
        decisionHash: approval.decisionHash,
        supersededAt: approval.supersededAt,
        decision,
        businessId: input.businessId,
        scopeWhere: eq(approvalRequests.channelId, input.channelId),
      },
      recheck,
    );
    if (result.kind === 'decision_changed') {
      return { kind: 'conflict', reason: 'decision_changed' };
    }
    if (result.kind !== 'ok') {
      return { kind: 'conflict', reason: 'decided' };
    }
    const decided = result.approval;
    const decidedByBusinessId =
      decision === 'approve' ? decided.approvedByBusinessId : decided.deniedByBusinessId;
    if (decided.runId === null || decidedByBusinessId == null) {
      return { kind: 'conflict', reason: 'decided' };
    }
    return {
      kind: 'ok',
      approval: {
        id: decided.id,
        channelId: decided.channelId ?? input.channelId,
        runId: decided.runId,
        serverId: decided.serverId,
        serverName: approval.serverName,
        toolName: decided.toolName,
        argumentsSummary: decided.argumentsSummary,
        createdAt: decided.createdAt,
        approvedAt: decided.approvedAt,
        deniedAt: decided.deniedAt,
        expiresAt: decided.expiresAt,
      },
      decidedByBusinessId,
    };
  });
}

export async function approveChannelApproval(
  db: Database,
  input: { channelId: string; approvalId: string; businessId: string },
  recheck: RecheckApproval,
): Promise<Decision> {
  const result = await decideChannelApproval(db, input, 'approve', recheck);
  if (result.kind !== 'ok') return result;
  return {
    kind: 'ok',
    approval: { ...result.approval, approvedByBusinessId: result.decidedByBusinessId },
  };
}

export async function denyChannelApproval(
  db: Database,
  input: { channelId: string; approvalId: string; businessId: string },
  recheck: RecheckApproval,
): Promise<DenyDecision> {
  const result = await decideChannelApproval(db, input, 'deny', recheck);
  if (result.kind !== 'ok') return result;
  return {
    kind: 'ok',
    approval: { ...result.approval, deniedByBusinessId: result.decidedByBusinessId },
  };
}
