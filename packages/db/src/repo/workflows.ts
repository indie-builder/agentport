import { AppError } from '@agentport/core';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database, DbHandle } from '../client.js';
import { newId } from '../id.js';
import { agentWorkflows } from '../schema.js';
import { notStale, touchUpdatedAt } from './freshness.js';

export type AgentWorkflowRow = typeof agentWorkflows.$inferSelect;

export interface WorkflowWrite {
  slug: string;
  name: string;
  description: string;
  content: string;
}

export async function listWorkflows(db: Database, agentId: string): Promise<AgentWorkflowRow[]> {
  return db
    .select()
    .from(agentWorkflows)
    .where(eq(agentWorkflows.agentId, agentId))
    .orderBy(asc(agentWorkflows.slug));
}

export async function listAgentIdsWithWorkflows(
  db: DbHandle,
  agentIds: string[],
): Promise<Set<string>> {
  if (agentIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ agentId: agentWorkflows.agentId })
    .from(agentWorkflows)
    .where(inArray(agentWorkflows.agentId, agentIds));
  return new Set(rows.map((row) => row.agentId));
}

export async function getWorkflow(
  db: Database,
  agentId: string,
  id: string,
): Promise<AgentWorkflowRow | null> {
  const [row] = await db
    .select()
    .from(agentWorkflows)
    .where(and(eq(agentWorkflows.agentId, agentId), eq(agentWorkflows.id, id)))
    .limit(1);
  return row ?? null;
}

export async function createWorkflow(
  db: Database,
  agentId: string,
  input: WorkflowWrite,
): Promise<AgentWorkflowRow> {
  const [row] = await db
    .insert(agentWorkflows)
    .values({ id: newId('agentWorkflow'), agentId, ...input })
    .returning();
  if (!row) throw new Error('workflow insert returned no row');
  return row;
}

export async function updateWorkflow(
  db: Database,
  agentId: string,
  id: string,
  patch: Partial<WorkflowWrite>,
  expectedUpdatedAt?: Date,
): Promise<AgentWorkflowRow | null> {
  const [row] = await db
    .update(agentWorkflows)
    .set({ ...patch, updatedAt: touchUpdatedAt(agentWorkflows.updatedAt) })
    .where(
      expectedUpdatedAt === undefined
        ? and(eq(agentWorkflows.agentId, agentId), eq(agentWorkflows.id, id))
        : and(
            eq(agentWorkflows.agentId, agentId),
            eq(agentWorkflows.id, id),
            notStale(agentWorkflows.updatedAt, expectedUpdatedAt),
          ),
    )
    .returning();
  if (!row && expectedUpdatedAt !== undefined && (await getWorkflow(db, agentId, id))) {
    throw new AppError('CONFLICT_STALE', '工作流已被修改，请刷新后重试');
  }
  return row ?? null;
}

export async function deleteWorkflow(db: Database, agentId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(agentWorkflows)
    .where(and(eq(agentWorkflows.agentId, agentId), eq(agentWorkflows.id, id)))
    .returning({ id: agentWorkflows.id });
  return rows.length > 0;
}
