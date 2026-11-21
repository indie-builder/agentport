import type { AgentLifecycleStatus } from '@agentport/shared';
import { type SQL, sql } from 'drizzle-orm';
import { agents } from '../schema.js';

export const activeAgentWhere = sql`${agents.archivedAt} is null and ${agents.deletedAt} is null`;

export function agentLifecycleWhere(status: AgentLifecycleStatus): SQL {
  return status === 'deleted'
    ? sql`${agents.deletedAt} is not null`
    : status === 'archived'
      ? sql`${agents.archivedAt} is not null and ${agents.deletedAt} is null`
      : activeAgentWhere;
}

export function isAgentInactive(row: { archivedAt: Date | null; deletedAt: Date | null }): boolean {
  return row.archivedAt !== null || row.deletedAt !== null;
}
