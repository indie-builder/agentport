import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import {
  agentRuns,
  channelAgentBindings,
  channelMessages,
  channels,
  channelWakes,
} from '../schema.js';

export type ChannelWakeRow = typeof channelWakes.$inferSelect;

export async function createChannelWakes(
  tx: DbHandle,
  input: { channelId: string; channelMessageId: string; agentIds: string[] },
): Promise<void> {
  if (input.agentIds.length === 0) return;
  await tx
    .insert(channelWakes)
    .values(
      input.agentIds.map((agentId) => ({
        id: `${input.channelMessageId}:${agentId}`,
        channelId: input.channelId,
        channelMessageId: input.channelMessageId,
        agentId,
      })),
    )
    .onConflictDoNothing();
}

export async function claimChannelWakes(
  db: Database,
  input: { limit: number; minAgeMs: number; leaseMs: number; channelMessageId?: string },
): Promise<ChannelWakeRow[]> {
  return db.transaction(async (tx) => {
    const now = Date.now();
    const rows = await tx
      .select()
      .from(channelWakes)
      .where(
        and(
          input.channelMessageId === undefined
            ? undefined
            : eq(channelWakes.channelMessageId, input.channelMessageId),
          or(
            and(
              eq(channelWakes.status, 'pending'),
              sql`${channelWakes.nextAttemptAt} <= now()`,
              sql`${channelWakes.createdAt} <= now() - make_interval(secs => ${input.minAgeMs}::double precision / 1000)`,
            ),
            and(
              eq(channelWakes.status, 'dispatching'),
              sql`${channelWakes.claimedAt} < now() - make_interval(secs => ${input.leaseMs}::double precision / 1000)`,
            ),
          ),
        ),
      )
      .orderBy(asc(channelWakes.createdAt))
      .limit(input.limit)
      .for('update', { skipLocked: true });
    if (rows.length === 0) return [];
    return tx
      .update(channelWakes)
      .set({
        status: 'dispatching',
        claimedAt: new Date(now),
        attempts: sql`${channelWakes.attempts} + 1`,
        updatedAt: new Date(now),
      })
      .where(
        inArray(
          channelWakes.id,
          rows.map((row) => row.id),
        ),
      )
      .returning();
  });
}

async function updateClaimedWake(
  db: Database,
  id: string,
  claimedAt: Date,
  patch: Partial<typeof channelWakes.$inferInsert>,
): Promise<boolean> {
  const [updated] = await db
    .update(channelWakes)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(channelWakes.id, id),
        eq(channelWakes.status, 'dispatching'),
        eq(channelWakes.claimedAt, claimedAt),
      ),
    )
    .returning({ id: channelWakes.id });
  return updated !== undefined;
}

export async function markChannelWakeEnqueued(
  db: Database,
  input: { id: string; claimedAt: Date },
): Promise<boolean> {
  return updateClaimedWake(db, input.id, input.claimedAt, { status: 'enqueued' });
}

export async function markChannelWakeSkipped(
  db: Database,
  input: { id: string; claimedAt: Date },
): Promise<boolean> {
  return updateClaimedWake(db, input.id, input.claimedAt, { status: 'skipped' });
}

export async function markChannelWakeFailed(
  db: Database,
  input: { id: string; claimedAt: Date; lastError?: string },
): Promise<boolean> {
  return updateClaimedWake(db, input.id, input.claimedAt, {
    status: 'failed',
    lastError: input.lastError ?? null,
  });
}

export async function markChannelWakeRetry(
  db: Database,
  input: { id: string; claimedAt: Date; lastError: string; nextAttemptAt: Date },
): Promise<boolean> {
  return updateClaimedWake(db, input.id, input.claimedAt, {
    status: 'pending',
    claimedAt: null,
    lastError: input.lastError,
    nextAttemptAt: input.nextAttemptAt,
  });
}

export async function findChannelRunByTrigger(
  db: Database,
  input: { channelId: string; channelMessageId: string; agentId: string },
): Promise<{ id: string; status: string; conversationId: string } | null> {
  const [run] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      conversationId: agentRuns.conversationId,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.channelId, input.channelId),
        eq(agentRuns.channelTriggerMessageId, input.channelMessageId),
        eq(agentRuns.agentId, input.agentId),
      ),
    )
    .limit(1);
  return run ?? null;
}

export async function getChannelWakeBindingStatus(
  db: Database,
  input: { channelId: string; agentId: string },
): Promise<{ status: typeof channelAgentBindings.$inferSelect.status } | null> {
  const [binding] = await db
    .select({ status: channelAgentBindings.status })
    .from(channelAgentBindings)
    .where(
      and(
        eq(channelAgentBindings.channelId, input.channelId),
        eq(channelAgentBindings.agentId, input.agentId),
      ),
    )
    .limit(1);
  return binding ?? null;
}

export async function getChannelWakeMessage(
  db: Database,
  channelMessageId: string,
): Promise<{
  id: string;
  channelId: string;
  body: string;
  authorBusinessId: string | null;
  channelArchivedAt: Date | null;
} | null> {
  const [message] = await db
    .select({
      id: channelMessages.id,
      channelId: channelMessages.channelId,
      body: channelMessages.body,
      authorBusinessId: channelMessages.authorBusinessId,
      channelArchivedAt: channels.archivedAt,
    })
    .from(channelMessages)
    .innerJoin(channels, eq(channels.id, channelMessages.channelId))
    .where(eq(channelMessages.id, channelMessageId))
    .limit(1);
  return message ?? null;
}
