import type { ChannelRole } from '@agentport/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../client.js';
import { agentRuns, channelAgentBindings, channelMembers, channels } from '../schema.js';
import { channelMemberRole } from './channels.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type DbHandle = Database | Tx;

export type ChannelRunRow = typeof agentRuns.$inferSelect;
export type ChannelRunStatus = ChannelRunRow['status'];

/** 控制面只关心活动状态；终态 run 不再占用 lane。 */
const ACTIVE_STATUSES = ['queued', 'running'] as const;

export type ControlRun = Pick<
  ChannelRunRow,
  'id' | 'agentId' | 'status' | 'initiatedBy' | 'startedAt'
>;

type NotFound = { kind: 'not_found'; target: 'channel' | 'run' | 'agent' };
type Forbidden = { kind: 'forbidden'; reason: 'channel_role' | 'run_owner' | 'owner_only' };

/** 控制端点一律要求真实频道成员，平台管理员不是成员时同样 404。 */
async function memberRole(
  db: DbHandle,
  channelId: string,
  businessId: string,
): Promise<ChannelRole | null> {
  return channelMemberRole(db, channelId, businessId);
}

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
        inArray(agentRuns.status, ACTIVE_STATUSES),
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
  if ((await memberRole(db, channelId, businessId)) === null) {
    return { kind: 'not_found', target: 'channel' };
  }
  return { kind: 'ok', runs: await activeRuns(db, channelId) };
}

/** 与发消息/准入共用频道行锁：close 与 stop 不会在锁外看到旧归属。 */
export async function stopRun(
  db: Database,
  businessId: string,
  channelId: string,
  runId: string,
): Promise<{ kind: 'ok'; run: ControlRun } | NotFound | Forbidden> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await memberRole(tx, channelId, businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (role === 'viewer') return { kind: 'forbidden', reason: 'channel_role' };

    const [run] = await tx
      .select(runColumns())
      .from(agentRuns)
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.channelId, channelId)))
      .for('update');
    if (!run) return { kind: 'not_found', target: 'run' };
    // 普通成员只能停自己触发的那条；owner/admin 可停任意 run。
    if (role === 'member' && run.initiatedBy !== businessId) {
      return { kind: 'forbidden', reason: 'run_owner' };
    }
    return { kind: 'ok', run };
  });
}

/**
 * 断开 agent lane 并取回它的活动 run。
 * 断开是频道级管理动作，只允许 owner/admin；member 只能停自己触发的 run（见 stopRun）。
 */
export async function disconnectAgent(
  db: Database,
  businessId: string,
  channelId: string,
  agentId: string,
): Promise<{ kind: 'ok'; runs: ControlRun[] } | NotFound | Forbidden> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await memberRole(tx, channelId, businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (role !== 'owner' && role !== 'admin') return { kind: 'forbidden', reason: 'channel_role' };

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

/** 关闭只允许 owner；重复关闭幂等返回同一 archivedAt。 */
export async function closeChannel(
  db: Database,
  businessId: string,
  channelId: string,
): Promise<{ kind: 'ok'; archivedAt: Date; runs: ControlRun[] } | NotFound | Forbidden> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id, archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await memberRole(tx, channelId, businessId);
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

/** SSE 每次轮询都走这里：成员关系在事务外实时复核，撤权后立即停流。 */
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
