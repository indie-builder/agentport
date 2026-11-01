import { fail } from '@agentport/core';
import type { ChannelRole } from '@agentport/shared';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from '../id.js';
import {
  agents,
  authUsers,
  channelAgentBindings,
  channelMembers,
  channelMessages,
  channels,
} from '../schema.js';

/** 频道权限只来自真实成员关系；平台范围不能替代成员身份。 */
export type ChannelSubject = { businessId: string };

export type ChannelRow = typeof channels.$inferSelect;
export type ChannelMemberRow = typeof channelMembers.$inferSelect;
export type ChannelAgentBindingRow = typeof channelAgentBindings.$inferSelect;
export type ChannelMessageRow = typeof channelMessages.$inferSelect;

export type ChannelListItemRow = ChannelRow & {
  role: ChannelRole | null;
  lastReadSeq: number;
  unreadCount: number;
  lastMessage: {
    id: string;
    seq: number;
    kind: ChannelMessageRow['kind'];
    body: string;
    authorBusinessId: string | null;
    agentId: string | null;
    createdAt: Date;
  } | null;
};

export type ChannelDetail = {
  channel: ChannelRow;
  members: ChannelMemberRow[];
  agentBindings: ChannelAgentBindingRow[];
};

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type DbHandle = Database | Tx;

type NotFound = { kind: 'not_found'; target: 'channel' | 'member' | 'account' | 'agent' };

function allows(role: ChannelRole | null, action: 'read' | 'post' | 'manage') {
  if (role === null) return false;
  if (action === 'read') return true;
  if (action === 'post') return role !== 'viewer';
  return role === 'owner' || role === 'admin';
}

export async function channelMemberRole(
  db: DbHandle,
  channelId: string,
  businessId: string,
): Promise<ChannelRole | null> {
  const [row] = await db
    .select({ role: channelMembers.role })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.businessId, businessId)))
    .limit(1);
  return row?.role ?? null;
}

export async function listChannels(
  db: Database,
  subject: ChannelSubject,
): Promise<ChannelListItemRow[]> {
  const last = db
    .select({
      id: channelMessages.id,
      seq: channelMessages.seq,
      kind: channelMessages.kind,
      body: sql<string>`left(${channelMessages.body}, 200)`.as('body'),
      authorBusinessId: channelMessages.authorBusinessId,
      agentId: channelMessages.agentId,
      createdAt: channelMessages.createdAt,
    })
    .from(channelMessages)
    .where(eq(channelMessages.channelId, channels.id))
    .orderBy(desc(channelMessages.seq))
    .limit(1)
    .as('last_message');

  const rows = await db
    .select({
      id: channels.id,
      name: channels.name,
      description: channels.description,
      createdBy: channels.createdBy,
      archivedAt: channels.archivedAt,
      createdAt: channels.createdAt,
      updatedAt: channels.updatedAt,
      role: channelMembers.role,
      lastReadSeq: channelMembers.lastReadSeq,
      unreadCount: sql<number>`(
        select count(*)::int from ${channelMessages} m
        where m.channel_id = ${channels.id}
          and m.seq > coalesce(${channelMembers.lastReadSeq}, 0)
          and m.author_business_id is distinct from ${subject.businessId}
      )`,
      lastId: last.id,
      lastSeq: last.seq,
      lastKind: last.kind,
      lastBody: last.body,
      lastAuthorBusinessId: last.authorBusinessId,
      lastAgentId: last.agentId,
      lastCreatedAt: last.createdAt,
    })
    .from(channels)
    .leftJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, channels.id),
        eq(channelMembers.businessId, subject.businessId),
      ),
    )
    .leftJoinLateral(last, sql`true`)
    .where(isNotNull(channelMembers.businessId))
    .orderBy(desc(channels.updatedAt), desc(channels.id));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    createdBy: row.createdBy,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    role: row.role,
    lastReadSeq: row.lastReadSeq ?? 0,
    unreadCount: row.unreadCount,
    lastMessage:
      row.lastId === null || row.lastSeq === null || row.lastKind === null
        ? null
        : {
            id: row.lastId,
            seq: row.lastSeq,
            kind: row.lastKind,
            body: row.lastBody ?? '',
            authorBusinessId: row.lastAuthorBusinessId,
            agentId: row.lastAgentId,
            createdAt: row.lastCreatedAt ?? row.createdAt,
          },
  }));
}

/** 建频道与 owner 成员同一事务：任何一步失败都不留下半条频道。 */
export async function createChannel(
  db: Database,
  input: {
    id: string;
    name: string;
    description: string | null;
    createdBy: string;
  },
): Promise<ChannelRow> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .insert(channels)
      .values({
        id: input.id,
        name: input.name,
        description: input.description,
        createdBy: input.createdBy,
      })
      .returning();
    if (!channel) throw new Error('channel insert returned no row');
    await tx.insert(channelMembers).values({
      channelId: channel.id,
      businessId: input.createdBy,
      role: 'owner',
    });
    return channel;
  });
}

export async function getChannelDetail(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
): Promise<ChannelDetail | NotFound> {
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  if (!channel) return { kind: 'not_found', target: 'channel' };
  if ((await channelMemberRole(db, channelId, subject.businessId)) === null) {
    return { kind: 'not_found', target: 'channel' };
  }
  const [members, agentBindings] = await Promise.all([
    db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channelId))
      .orderBy(asc(channelMembers.createdAt), asc(channelMembers.businessId)),
    db
      .select()
      .from(channelAgentBindings)
      .where(eq(channelAgentBindings.channelId, channelId))
      .orderBy(asc(channelAgentBindings.createdAt), asc(channelAgentBindings.agentId)),
  ]);
  return { channel, members, agentBindings };
}

export async function updateChannel(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  patch: { name?: string | undefined; description?: string | null | undefined },
): Promise<
  { kind: 'ok'; channel: ChannelRow } | NotFound | { kind: 'forbidden'; reason: 'channel_role' }
> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select()
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, subject.businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'manage')) {
      return { kind: 'forbidden', reason: 'channel_role' };
    }
    const [updated] = await tx
      .update(channels)
      .set({
        ...(patch.name === undefined ? {} : { name: patch.name }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        updatedAt: new Date(),
      })
      .where(eq(channels.id, channelId))
      .returning();
    if (!updated) throw new Error('channel update returned no row');
    return { kind: 'ok', channel: updated };
  });
}

export async function addMember(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  input: { businessId: string; role: ChannelRole },
): Promise<
  | { kind: 'ok'; member: ChannelMemberRow }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' | 'owner_only' | 'account_disabled' }
  | { kind: 'conflict'; reason: 'member_exists' }
> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, subject.businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'manage')) {
      return { kind: 'forbidden', reason: 'channel_role' };
    }
    // owner 授予只看频道 owner；admin 不能借 manage 提升自己人。
    if (input.role === 'owner' && role !== 'owner') {
      return { kind: 'forbidden', reason: 'owner_only' };
    }
    const [account] = await tx
      .select({ disabled: authUsers.disabled })
      .from(authUsers)
      .where(eq(authUsers.businessId, input.businessId))
      .limit(1);
    if (!account) return { kind: 'not_found', target: 'account' };
    if (account.disabled) return { kind: 'forbidden', reason: 'account_disabled' };
    const existing = await channelMemberRole(tx, channelId, input.businessId);
    if (existing !== null) return { kind: 'conflict', reason: 'member_exists' };
    const [member] = await tx
      .insert(channelMembers)
      .values({ channelId, businessId: input.businessId, role: input.role })
      .returning();
    if (!member) throw new Error('channel member insert returned no row');
    return { kind: 'ok', member };
  });
}

export async function removeMember(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  businessId: string,
): Promise<
  | { kind: 'ok' }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' | 'owner_only' }
  | { kind: 'conflict'; reason: 'last_owner' }
> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, subject.businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'manage')) {
      return { kind: 'forbidden', reason: 'channel_role' };
    }
    const targetRole = await channelMemberRole(tx, channelId, businessId);
    if (targetRole === null) return { kind: 'not_found', target: 'member' };
    if (targetRole === 'owner' && role !== 'owner') {
      return { kind: 'forbidden', reason: 'owner_only' };
    }
    if (targetRole === 'owner') {
      const [owners] = await tx
        .select({ total: count() })
        .from(channelMembers)
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.role, 'owner')));
      if ((owners?.total ?? 0) <= 1) return { kind: 'conflict', reason: 'last_owner' };
    }
    await tx
      .delete(channelMembers)
      .where(
        and(eq(channelMembers.channelId, channelId), eq(channelMembers.businessId, businessId)),
      );
    return { kind: 'ok' };
  });
}

// 先检查频道身份再查 agent 权限，写入时仍在频道行锁内复核。
export async function getChannelManageAccess(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
): Promise<{ kind: 'ok' } | NotFound | { kind: 'forbidden'; reason: 'channel_role' }> {
  const [row] = await db
    .select({ role: channelMembers.role })
    .from(channels)
    .leftJoin(
      channelMembers,
      and(
        eq(channelMembers.channelId, channels.id),
        eq(channelMembers.businessId, subject.businessId),
      ),
    )
    .where(eq(channels.id, channelId))
    .limit(1);
  if (!row) return { kind: 'not_found', target: 'channel' };
  if (row.role === null) return { kind: 'not_found', target: 'channel' };
  if (!allows(row.role, 'manage')) {
    return { kind: 'forbidden', reason: 'channel_role' };
  }
  return { kind: 'ok' };
}

export async function addAgentBinding(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  input: { agentId: string; autoWakeOnAll: boolean },
): Promise<
  | { kind: 'ok'; binding: ChannelAgentBindingRow }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' }
  | { kind: 'conflict'; reason: 'binding_exists' }
> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, subject.businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'manage')) {
      return { kind: 'forbidden', reason: 'channel_role' };
    }
    const [agent] = await tx
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.agentId))
      .limit(1);
    if (!agent) return { kind: 'not_found', target: 'agent' };
    const [existing] = await tx
      .select({ agentId: channelAgentBindings.agentId })
      .from(channelAgentBindings)
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.agentId, input.agentId),
        ),
      )
      .limit(1);
    if (existing) return { kind: 'conflict', reason: 'binding_exists' };
    const [binding] = await tx
      .insert(channelAgentBindings)
      .values({
        channelId,
        agentId: input.agentId,
        autoWakeOnAll: input.autoWakeOnAll,
        addedBy: subject.businessId,
      })
      .returning();
    if (!binding) throw new Error('channel agent binding insert returned no row');
    return { kind: 'ok', binding };
  });
}

export async function removeAgentBinding(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  agentId: string,
): Promise<{ kind: 'ok' } | NotFound | { kind: 'forbidden'; reason: 'channel_role' }> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, subject.businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'manage')) {
      return { kind: 'forbidden', reason: 'channel_role' };
    }
    const [removed] = await tx
      .delete(channelAgentBindings)
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.agentId, agentId),
        ),
      )
      .returning({ agentId: channelAgentBindings.agentId });
    if (!removed) return { kind: 'not_found', target: 'agent' };
    return { kind: 'ok' };
  });
}

export async function getChannelReadAccess(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
): Promise<{ createdBy: string; maxSeq: number } | undefined> {
  const [channel] = await db
    .select({
      createdBy: channels.createdBy,
      maxSeq:
        sql<number>`coalesce((select max(m.seq) from ${channelMessages} m where m.channel_id = ${channelId}), 0)`.mapWith(
          Number,
        ),
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), readCondition(subject, channelId)))
    .limit(1);
  return channel;
}

function readCondition(subject: ChannelSubject, channelId: string) {
  return sql`exists (select 1 from ${channelMembers} where ${channelMembers.channelId} = ${channelId} and ${channelMembers.businessId} = ${subject.businessId})`;
}

export async function listMessages(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  options: { after: number; limit: number },
): Promise<
  { kind: 'ok'; items: ChannelMessageRow[]; createdBy: string; maxSeq: number } | NotFound
> {
  const channel = await getChannelReadAccess(db, subject, channelId);
  if (!channel) return { kind: 'not_found', target: 'channel' };
  const items = await db
    .select()
    .from(channelMessages)
    .where(
      and(
        eq(channelMessages.channelId, channelId),
        gt(channelMessages.seq, options.after),
        readCondition(subject, channelId),
      ),
    )
    .orderBy(asc(channelMessages.seq))
    .limit(options.limit);
  if (items.length === 0 && !(await getChannelReadAccess(db, subject, channelId))) {
    return { kind: 'not_found', target: 'channel' };
  }
  return { kind: 'ok', items, ...channel };
}

/** 显式 @ 任一无效返回 null 拒绝整条消息；@all 只补 autoWakeOnAll 且 agent 启用的绑定，结果去重。 */
async function resolveWakeAgents(
  tx: DbHandle,
  channelId: string,
  input: { mentions?: string[]; mentionAll?: boolean },
): Promise<string[] | null> {
  const wake = new Set<string>();
  const explicit = [...new Set(input.mentions ?? [])];
  if (explicit.length > 0) {
    const rows = await tx
      .select({ agentId: channelAgentBindings.agentId })
      .from(channelAgentBindings)
      .innerJoin(agents, eq(agents.id, channelAgentBindings.agentId))
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.status, 'active'),
          eq(agents.enabled, true),
          inArray(channelAgentBindings.agentId, explicit),
        ),
      );
    if (rows.length !== explicit.length) return null;
    for (const row of rows) wake.add(row.agentId);
  }
  if (input.mentionAll === true) {
    const rows = await tx
      .select({ agentId: channelAgentBindings.agentId })
      .from(channelAgentBindings)
      .innerJoin(agents, eq(agents.id, channelAgentBindings.agentId))
      .where(
        and(
          eq(channelAgentBindings.channelId, channelId),
          eq(channelAgentBindings.status, 'active'),
          eq(agents.enabled, true),
          eq(channelAgentBindings.autoWakeOnAll, true),
        ),
      );
    for (const row of rows) wake.add(row.agentId);
  }
  return [...wake];
}

/** 行锁串行化 bigserial seq 的分配与提交顺序，不靠 max(seq)+1。 */
export async function postMessage(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  input: {
    id: string;
    body: string;
    clientMessageId?: string;
    mentions?: string[];
    mentionAll?: boolean;
  },
): Promise<
  | { kind: 'ok'; message: ChannelMessageRow; duplicate: boolean; wakeAgentIds: string[] }
  | NotFound
  | { kind: 'forbidden'; reason: 'channel_role' }
  | { kind: 'invalid_mentions' }
> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id, archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, subject.businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    if (!allows(role, 'post')) {
      return { kind: 'forbidden', reason: 'channel_role' };
    }
    if (channel.archivedAt !== null) fail('CONFLICT', '频道已关闭，不能发送消息');
    // 唤醒会拉起 run：只有真实 owner/admin/member 可以带 @ 发言。
    let wakeAgentIds: string[] = [];
    if ((input.mentions?.length ?? 0) > 0 || input.mentionAll === true) {
      if (role === null) return { kind: 'not_found', target: 'channel' };
      if (role === 'viewer') return { kind: 'forbidden', reason: 'channel_role' };
      const resolved = await resolveWakeAgents(tx, channelId, input);
      if (resolved === null) return { kind: 'invalid_mentions' };
      wakeAgentIds = resolved;
    }
    const [inserted] = await tx
      .insert(channelMessages)
      .values({
        id: input.id,
        channelId,
        kind: 'human',
        authorBusinessId: subject.businessId,
        body: input.body,
        clientMessageId: input.clientMessageId ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      await tx.update(channels).set({ updatedAt: new Date() }).where(eq(channels.id, channelId));
      return { kind: 'ok', message: inserted, duplicate: false, wakeAgentIds };
    }
    if (input.clientMessageId === undefined) {
      throw new Error('channel message insert returned no row');
    }
    const [existing] = await tx
      .select()
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.channelId, channelId),
          eq(channelMessages.clientMessageId, input.clientMessageId),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('channel message conflict without existing row');
    // 同一个 clientMessageId 已唤醒过一次；重放不能再拉起 run。
    return { kind: 'ok', message: existing, duplicate: true, wakeAgentIds: [] };
  });
}

/** 忙碌提示等系统消息：与频道时间线共用 seq，并推进列表排序时间。关闭后返回 null，不写误提示。 */
export async function postSystemMessage(
  db: Database,
  input: { channelId: string; agentId: string; body: string },
): Promise<ChannelMessageRow | null> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id, archivedAt: channels.archivedAt })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .for('update');
    if (!channel) fail('NOT_FOUND', '频道不存在，可能已被删除');
    if (channel.archivedAt !== null) return null;
    const [inserted] = await tx
      .insert(channelMessages)
      .values({
        id: newId('channelMessage'),
        channelId: input.channelId,
        kind: 'system',
        agentId: input.agentId,
        body: input.body,
      })
      .returning();
    if (!inserted) throw new Error('channel system message insert returned no row');
    await tx
      .update(channels)
      .set({ updatedAt: new Date() })
      .where(eq(channels.id, input.channelId));
    return inserted;
  });
}

/** seq 夹到当前已提交的 max，避免伪造未来游标跳过后续消息。 */
export async function markRead(
  db: Database,
  subject: ChannelSubject,
  channelId: string,
  seq: number,
): Promise<{ kind: 'ok'; lastReadSeq: number } | NotFound> {
  return db.transaction(async (tx) => {
    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.id, channelId))
      .for('update');
    if (!channel) return { kind: 'not_found', target: 'channel' };
    const role = await channelMemberRole(tx, channelId, subject.businessId);
    if (role === null) return { kind: 'not_found', target: 'channel' };
    const [current] = await tx
      .select({ lastReadSeq: channelMembers.lastReadSeq })
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.businessId, subject.businessId),
        ),
      );
    if (!current) return { kind: 'not_found', target: 'channel' };
    const [latest] = await tx
      .select({ max: sql<string | number | null>`max(${channelMessages.seq})` })
      .from(channelMessages)
      .where(eq(channelMessages.channelId, channelId));
    const max = Number(latest?.max ?? 0);
    const lastReadSeq = Math.max(current.lastReadSeq, Math.min(seq, max));
    await tx
      .update(channelMembers)
      .set({ lastReadSeq })
      .where(
        and(
          eq(channelMembers.channelId, channelId),
          eq(channelMembers.businessId, subject.businessId),
        ),
      );
    return { kind: 'ok', lastReadSeq };
  });
}
