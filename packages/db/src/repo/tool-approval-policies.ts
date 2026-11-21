import type {
  ToolApprovalMethod,
  ToolApprovalPolicyCreate,
  ToolApprovalPolicyUpdate,
} from '@agentport/shared';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { toolApprovalPolicies } from '../schema.js';

export type ToolApprovalPolicyRow = typeof toolApprovalPolicies.$inferSelect;

export interface ToolLookup {
  serverId: string;
  agentId: string | null;
  toolId: string;
  method: ToolApprovalMethod;
  pathTemplate: string;
}

export async function listToolApprovalPolicies(db: Database) {
  return db
    .select()
    .from(toolApprovalPolicies)
    .orderBy(asc(toolApprovalPolicies.createdAt), asc(toolApprovalPolicies.id));
}

export async function listEnabledForTool(db: Database, input: ToolLookup) {
  return db
    .select()
    .from(toolApprovalPolicies)
    .where(
      and(
        eq(toolApprovalPolicies.enabled, true),
        or(
          isNull(toolApprovalPolicies.serverId),
          eq(toolApprovalPolicies.serverId, input.serverId),
        ),
        input.agentId === null
          ? isNull(toolApprovalPolicies.agentId)
          : or(
              isNull(toolApprovalPolicies.agentId),
              eq(toolApprovalPolicies.agentId, input.agentId),
            ),
        or(isNull(toolApprovalPolicies.toolId), eq(toolApprovalPolicies.toolId, input.toolId)),
        or(
          isNull(toolApprovalPolicies.httpMethod),
          eq(toolApprovalPolicies.httpMethod, input.method),
        ),
        or(
          isNull(toolApprovalPolicies.pathTemplate),
          eq(toolApprovalPolicies.pathTemplate, input.pathTemplate),
        ),
      ),
    )
    .orderBy(asc(toolApprovalPolicies.id));
}

export async function getToolApprovalPolicy(db: DbHandle, id: string) {
  const [row] = await db
    .select()
    .from(toolApprovalPolicies)
    .where(eq(toolApprovalPolicies.id, id))
    .limit(1);
  return row ?? null;
}

export async function createToolApprovalPolicy(
  db: Database,
  input: ToolApprovalPolicyCreate,
  actor: string,
) {
  const [row] = await db
    .insert(toolApprovalPolicies)
    .values({
      id: newId('toolApprovalPolicy'),
      ...input,
      createdBy: actor,
      updatedBy: actor,
    })
    .returning();
  if (!row) throw new Error('tool approval policy insert returned no row');
  return row;
}

export async function updateToolApprovalPolicy(
  db: Database,
  id: string,
  patch: ToolApprovalPolicyUpdate,
  actor: string,
) {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(toolApprovalPolicies)
      .where(eq(toolApprovalPolicies.id, id))
      .for('update');
    if (previous === undefined) return null;
    const [updated] = await tx
      .update(toolApprovalPolicies)
      .set({
        ...patch,
        updatedBy: actor,
        version: sql`${toolApprovalPolicies.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(toolApprovalPolicies.id, id))
      .returning();
    return updated === undefined ? null : { previous, updated };
  });
}

export async function deleteToolApprovalPolicy(db: Database, id: string) {
  const [row] = await db
    .delete(toolApprovalPolicies)
    .where(eq(toolApprovalPolicies.id, id))
    .returning();
  return row ?? null;
}
