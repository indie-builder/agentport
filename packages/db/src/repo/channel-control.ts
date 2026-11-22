import { ACTIVE_RUN_STATUSES, type ChannelRole } from '@agentport/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { agentRuns, channelAgentBindings, channelMembers, channels } from '../schema.js';
import {
  allows,
  type ChannelActiveRunRow,
  channelMemberRole,
  lockChannel,
  lockChannelRow,
} from './channels.js';

export type ChannelRunRow = typeof agentRuns.$inferSelect;

export type ControlRun = ChannelActiveRunRow;

type NotFound = { kind: 'not_found'; target: 'channel' | 'run' | 'agent' };
type Forbidden = { kind: 'forbidden'; reason: 'channel_role' | 'run_owner' | 'owner_only' };

function runColumns() {
  return {
    id: agentRuns.id,
    agentId: agentRuns.agentId,
    status: agentRuns.status,
    initiatedBy: agentRuns.initiatedBy,
    startedAt: agentRuns.startedAt,
  };
}

function activeRuns(
  db: DbHandle,
  channelId: string,
  options: { agentId?: string } = {},
): Promise<ControlRun[]> {
  return db
    .select(runColumns())
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.channelId, channelId),
        inArray(agentRuns.status, [...ACTIVE_RUN_STATUSES]),
        ...(options.agentId === undefined ? [] : [eq(agentRuns.agentId, options.agentId)]),
      ),
    )
    .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));
}

export async function listActiveRuns(
  db: Database,
  businessId: string,
  channelId: string,
): Promise<{ kind: 'ok'; runs: ControlRun[] } | NotFound> {
  if ((await channelMemberRole(db, channelId, businessId)) === null) {
    return { kind: 'not_found', target: 'channel' };
  }
  return { kind: 'ok', runs: await activeRuns(db, channelId) };
}

export async function stopRun(
  db: Database,
  businessId: string,
  channelId: string,
  runId: string,
): Promise<{ kind: 'ok'; run: ControlRun } | NotFound | Forbidden> {
  return db.transaction(async (tx) => {
    if (!(await lockChannel(tx, channelId))) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'post')) return { kind: 'forbidden', reason: 'channel_role' };

    const [run] = await tx
      .select(runColumns())
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.channelId, channelId)))
      .for('update');
    if (!run) return { kind: 'not_found', target: 'run' };
    if (role === 'member' && run.initiatedBy !== businessId) {
      return { kind: 'forbidden', reason: 'run_owner' };
    }
    return { kind: 'ok', run };
  });
}

export async function disconnectAgent(
  db: Database,
  businessId: string,
  channelId: string,
  agentId: string,
): Promise<{ kind: 'ok'; runs: ControlRun[] } | NotFound | Forbidden> {
  return db.transaction(async (tx) => {
    if (!(await lockChannel(tx, channelId))) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'manage')) return { kind: 'forbidden', reason: 'channel_role' };

    const [binding] = await tx
      .select({ agentId: channelAgentBindings.agentId })
      .from(channelAgentBindings)
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.agentId, agentId),
        ),
      )
      .for('update');
    if (!binding) return { kind: 'not_found', target: 'agent' };

    const runs = await activeRuns(tx, channelId, { agentId });

    await tx
      .update(channelAgentBindings)
      .set({ status: 'disconnected' })
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.agentId, agentId),
        ),
      );
    return { kind: 'ok', runs };
  });
}

export async function closeChannel(
  db: Database,
  businessId: string,
  channelId: string,
): Promise<{ kind: 'ok'; archivedAt: Date; runs: ControlRun[] } | NotFound | Forbidden> {
  return db.transaction(async (tx) => {
    const channel = await lockChannelRow(tx, channelId);
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (role !== 'owner') return { kind: 'forbidden', reason: 'owner_only' };

    const archivedAt = channel.archivedAt ?? new Date();
    if (channel.archivedAt === null) {
      await tx
        .update(channels)
        .set({ archivedAt, updatedAt: new Date() })
        .where(eq(channels.id, channelId));
    }
    return { kind: 'ok', archivedAt, runs: await activeRuns(tx, channelId) };
  });
}

export async function getChannelRunForMember(
  db: Database,
  businessId: string,
  channelId: string,
  runId: string,
): Promise<{ role: ChannelRole; run: ChannelRunRow } | undefined> {
  const [row] = await db
    .select({ role: channelMembers.role, run: agentRuns })
    .from(agentRuns)
    .innerJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, agentRuns.channelId),
        eq(channelMembers.businessId, businessId),
      ),
    )
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.channelId, channelId)))
    .limit(1);
  return row;
}
