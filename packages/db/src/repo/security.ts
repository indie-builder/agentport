import { fail } from '@agentport/core';
import type {
  ContentPolicyAction,
  ContentPolicyCreate,
  ContentPolicyUpdate,
  PolicyApprovalStatus,
  PolicySourceKind,
  ViolationCaseStatus,
  ViolationCaseUpdate,
} from '@agentport/shared';
import { and, count, desc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database, DbHandle, Transaction } from '../client.js';
import { newId } from '../id.js';
import {
  agentRuns,
  contentPolicies,
  conversations,
  policyApprovals,
  policyEvents,
  violationCases,
} from '../schema.js';
import { listAlertRecipientBusinessIds } from './governance/reporting.js';
import { lockPolicyApproval } from './locks.js';
import { createNotification } from './notifications.js';
import { keysetPage } from './pagination.js';

export type ContentPolicyRow = typeof contentPolicies.$inferSelect;
export type PolicyEventRow = typeof policyEvents.$inferSelect;
export type PolicyApprovalRow = typeof policyApprovals.$inferSelect;
export type ViolationCaseRow = typeof violationCases.$inferSelect;

export type PolicyEventInput = Omit<typeof policyEvents.$inferInsert, 'id' | 'createdAt'>;
export type PolicyApprovalInput = Omit<
  typeof policyApprovals.$inferInsert,
  'id' | 'status' | 'requestedAt' | 'decidedBy' | 'decidedAt' | 'note' | 'consumedAt'
>;
export type ViolationCaseInput = Omit<
  typeof violationCases.$inferInsert,
  'id' | 'status' | 'createdAt' | 'updatedAt'
>;

export async function listContentPolicies(db: DbHandle) {
  return db.select().from(contentPolicies).orderBy(contentPolicies.priority, contentPolicies.id);
}

function validatePolicyFields({
  direction,
  action,
  matchType,
  pattern,
}: Pick<ContentPolicyCreate, 'direction' | 'action' | 'matchType' | 'pattern'>) {
  if (direction === 'outbound' && action === 'require_approval') {
    fail('INVALID_INPUT', '出站策略只支持拦截或脱敏', { path: '/body/action' });
  }
  if (matchType !== 'regex') return;
  try {
    new RegExp(pattern);
  } catch {
    fail('INVALID_INPUT', '正则表达式无效', { path: '/body/pattern' });
  }
}

export async function createContentPolicy(
  db: Database,
  input: ContentPolicyCreate,
  createdBy: string,
) {
  validatePolicyFields(input);
  const [row] = await db
    .insert(contentPolicies)
    .values({ id: newId('contentPolicy'), ...input, createdBy })
    .returning();
  if (!row) throw new Error('content policy insert returned no row');
  return row;
}

export async function updateContentPolicy(db: Database, id: string, patch: ContentPolicyUpdate) {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select({
        direction: contentPolicies.direction,
        action: contentPolicies.action,
        matchType: contentPolicies.matchType,
        pattern: contentPolicies.pattern,
      })
      .from(contentPolicies)
      .where(eq(contentPolicies.id, id))
      .for('update');
    if (current === undefined) return null;
    validatePolicyFields({
      direction: patch.direction ?? current.direction,
      action: patch.action ?? current.action,
      matchType: patch.matchType ?? current.matchType,
      pattern: patch.pattern ?? current.pattern,
    });
    const [row] = await tx
      .update(contentPolicies)
      .set({ ...patch, version: sql`${contentPolicies.version} + 1`, updatedAt: new Date() })
      .where(eq(contentPolicies.id, id))
      .returning();
    return row ?? null;
  });
}

export async function deleteContentPolicy(db: Database, id: string) {
  const rows = await db
    .delete(contentPolicies)
    .where(eq(contentPolicies.id, id))
    .returning({ id: contentPolicies.id });
  return rows.length > 0;
}

export async function listEnabledContentPolicies(db: DbHandle, agentId: string | null) {
  return db
    .select()
    .from(contentPolicies)
    .where(
      and(
        eq(contentPolicies.enabled, true),
        agentId === null
          ? isNull(contentPolicies.agentId)
          : or(isNull(contentPolicies.agentId), eq(contentPolicies.agentId, agentId)),
      ),
    )
    .orderBy(desc(contentPolicies.direction), contentPolicies.priority, contentPolicies.id);
}

export async function createPolicyEvent(db: DbHandle, input: PolicyEventInput) {
  const [row] = await db
    .insert(policyEvents)
    .values({ id: newId('policyEvent'), ...input })
    .returning();
  if (!row) throw new Error('policy event insert returned no row');
  return row;
}

export async function linkPolicyEventToRun(db: DbHandle, id: string, runId: string) {
  await db.update(policyEvents).set({ runId }).where(eq(policyEvents.id, id));
}

export async function listPolicyEvents(
  db: Database,
  input: {
    limit: number;
    cursor?: string;
    sourceKind?: PolicySourceKind;
    action?: ContentPolicyAction;
  },
) {
  const filters = [
    ...(input.sourceKind === undefined ? [] : [eq(policyEvents.sourceKind, input.sourceKind)]),
    ...(input.action === undefined ? [] : [eq(policyEvents.action, input.action)]),
  ];
  return keysetPage(db, {
    table: policyEvents,
    cursor: input.cursor,
    limit: input.limit,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(policyEvents)
        .where(where)
        .orderBy(desc(policyEvents.createdAt), desc(policyEvents.id))
        .limit(limit),
  });
}

export async function listPolicyApprovals(
  db: Database,
  input: { status: PolicyApprovalStatus; limit: number; cursor?: string },
) {
  const filters = [approvalStatusFilter(input.status)];
  const page = await keysetPage(db, {
    table: policyApprovals,
    cursor: input.cursor,
    limit: input.limit,
    column: policyApprovals.requestedAt,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(policyApprovals)
        .where(where)
        .orderBy(desc(policyApprovals.requestedAt), desc(policyApprovals.id))
        .limit(limit),
  });
  if (page === null || input.status !== 'expired') return page;
  return {
    items: page.items.map((row) => ({ ...row, status: 'expired' as const })),
    nextCursor: page.nextCursor,
  };
}

export async function getPolicyApproval(db: DbHandle, id: string) {
  const [row] = await db.select().from(policyApprovals).where(eq(policyApprovals.id, id)).limit(1);
  return row ?? null;
}

export async function linkPolicyApprovalToRun(tx: Transaction, approvalId: string, runId: string) {
  const [run] = await tx
    .select({ conversationId: agentRuns.conversationId })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  const previous = run && (await getApprovedPolicyApprovalForConversation(tx, run.conversationId));
  const [approval] = await tx
    .update(policyApprovals)
    .set({ runId })
    .where(eq(policyApprovals.id, approvalId))
    .returning({ destination: policyApprovals.destination });
  if (!run || !approval?.destination) return;

  if (previous?.destination != null && previous.destination !== approval.destination) {
    fail('CONTENT_APPROVAL_REQUIRED', '审批目标与当前会话不一致，请重新发起');
  }
  const [locked] = await tx
    .update(conversations)
    .set({ providerDestination: approval.destination })
    .where(
      and(
        eq(conversations.id, run.conversationId),
        or(
          isNull(conversations.providerDestination),
          eq(conversations.providerDestination, approval.destination),
        ),
      ),
    )
    .returning({ id: conversations.id });
  if (locked === undefined)
    fail('CONTENT_APPROVAL_REQUIRED', '审批目标与当前会话不一致，请重新发起');
}

export async function getApprovedPolicyApprovalForRun(db: DbHandle, runId: string) {
  const [row] = await db
    .select()
    .from(policyApprovals)
    .where(
      and(
        eq(policyApprovals.runId, runId),
        eq(policyApprovals.status, 'approved'),
        isNotNull(policyApprovals.consumedAt),
      ),
    )
    .orderBy(desc(policyApprovals.consumedAt), desc(policyApprovals.id))
    .limit(1);
  return row ?? null;
}

export async function getApprovedPolicyApprovalForConversation(
  db: DbHandle,
  conversationId: string,
) {
  const [conversation] = await db
    .select({ destination: conversations.providerDestination })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  if (conversation?.destination != null) return conversation;

  const [row] = await db
    .select({ destination: policyApprovals.destination })
    .from(policyApprovals)
    .innerJoin(agentRuns, eq(agentRuns.id, policyApprovals.runId))
    .where(
      and(
        eq(agentRuns.conversationId, conversationId),
        eq(policyApprovals.status, 'approved'),
        isNotNull(policyApprovals.consumedAt),
      ),
    )
    .orderBy(desc(policyApprovals.consumedAt), desc(policyApprovals.id))
    .limit(1);
  return row ?? null;
}

export async function findOrCreatePolicyApproval(
  tx: Transaction,
  input: PolicyApprovalInput & { policyId: string; destination: string },
) {
  await lockPolicyApproval(tx, input.requestedBy, input.payloadHash, input.destination);
  const [row] = await tx
    .select()
    .from(policyApprovals)
    .where(
      and(
        or(eq(policyApprovals.status, 'approved'), eq(policyApprovals.status, 'pending')),
        isNull(policyApprovals.consumedAt),
        gt(policyApprovals.expiresAt, new Date()),
        eq(policyApprovals.requestedBy, input.requestedBy),
        eq(policyApprovals.payloadHash, input.payloadHash),
        eq(policyApprovals.destination, input.destination),
        eq(policyApprovals.policyId, input.policyId),
        eq(policyApprovals.policyVersion, input.policyVersion),
      ),
    )
    .orderBy(sql`${policyApprovals.decidedAt} desc nulls last`, desc(policyApprovals.requestedAt))
    .limit(1);
  if (row !== undefined) return { approval: row, created: false };
  const [approval] = await tx
    .insert(policyApprovals)
    .values({ id: newId('policyApproval'), ...input })
    .returning();
  if (!approval) throw new Error('policy approval insert returned no row');
  return { approval, created: true };
}

export const POLICY_APPROVAL_STALE_MESSAGE = '审批已失效，请重新发起';

export async function consumePolicyApproval(
  db: DbHandle,
  id: string,
  expectedDestination?: string,
) {
  const [row] = await db
    .update(policyApprovals)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(policyApprovals.id, id),
        eq(policyApprovals.status, 'approved'),
        isNull(policyApprovals.consumedAt),
        gt(policyApprovals.expiresAt, new Date()),
        expectedDestination === undefined
          ? undefined
          : eq(policyApprovals.destination, expectedDestination),
      ),
    )
    .returning();
  return row ?? null;
}

export async function decidePolicyApproval(
  db: DbHandle,
  input: { id: string; decision: 'approve' | 'reject'; decidedBy: string; note?: string },
) {
  const [row] = await db
    .update(policyApprovals)
    .set({
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      decidedBy: input.decidedBy,
      decidedAt: new Date(),
      note: input.note ?? null,
    })
    .where(
      and(
        eq(policyApprovals.id, input.id),
        eq(policyApprovals.status, 'pending'),
        gt(policyApprovals.expiresAt, new Date()),
      ),
    )
    .returning();
  return row ?? null;
}

export async function createViolationCase(db: DbHandle, input: ViolationCaseInput) {
  const [row] = await db
    .insert(violationCases)
    .values({ id: newId('violationCase'), ...input })
    .returning();
  if (!row) throw new Error('violation case insert returned no row');
  const recipients = await listAlertRecipientBusinessIds(db);
  await Promise.all(
    recipients.map((businessId) =>
      createNotification(db, {
        businessId,
        kind: 'policy_violation',
        title: '内容策略违规',
        body: `策略「${row.policyName}」已生成违规工单，请在安全运营中处理`,
        link: '/security?tab=violations',
        sourceId: `policy-violation:${row.id}`,
      }),
    ),
  );
  return row;
}

export async function listViolationCases(
  db: Database,
  input: { status?: ViolationCaseStatus; limit: number; cursor?: string },
) {
  const filters = input.status === undefined ? [] : [eq(violationCases.status, input.status)];
  return keysetPage(db, {
    table: violationCases,
    cursor: input.cursor,
    limit: input.limit,
    where: filters,
    load: ({ where, limit }) =>
      db
        .select()
        .from(violationCases)
        .where(where)
        .orderBy(desc(violationCases.createdAt), desc(violationCases.id))
        .limit(limit),
  });
}

export async function countViolationCasesByStatus(
  db: DbHandle,
  status: ViolationCaseStatus,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(violationCases)
    .where(eq(violationCases.status, status));
  return row?.total ?? 0;
}

function approvalStatusFilter(status: PolicyApprovalStatus) {
  if (status === 'expired') {
    return or(
      eq(policyApprovals.status, 'expired'),
      and(eq(policyApprovals.status, 'pending'), lte(policyApprovals.expiresAt, sql`now()`)),
    );
  }
  return and(
    eq(policyApprovals.status, status),
    status === 'pending' ? gt(policyApprovals.expiresAt, sql`now()`) : undefined,
  );
}

export async function countPolicyApprovalsByStatus(
  db: DbHandle,
  status: PolicyApprovalStatus,
): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(policyApprovals)
    .where(approvalStatusFilter(status));
  return row?.total ?? 0;
}

export async function updateViolationCase(db: Database, id: string, patch: ViolationCaseUpdate) {
  const [row] = await db
    .update(violationCases)
    .set({
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.assigneeBusinessId === undefined
        ? {}
        : { assigneeBusinessId: patch.assigneeBusinessId }),
      ...(patch.resolution === undefined ? {} : { resolution: patch.resolution }),
      updatedAt: new Date(),
    })
    .where(eq(violationCases.id, id))
    .returning();
  return row ?? null;
}
