import type { ApiToolApprovalMode, ToolApprovalMethod } from '@agentport/shared';
import { apiToolApprovalModeSchema, toolApprovalMethodSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { apiTools, servers } from './servers.js';

export const toolApprovalPolicies = pgTable(
  'tool_approval_policies',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    serverId: text('server_id').references(() => servers.id, { onDelete: 'cascade' }),
    toolId: text('tool_id').references(() => apiTools.id, { onDelete: 'cascade' }),
    role: text('role'),
    httpMethod: text('http_method', {
      enum: toolApprovalMethodSchema.options as [ToolApprovalMethod, ...ToolApprovalMethod[]],
    }),
    pathTemplate: text('path_template'),
    approvalMode: text('approval_mode', {
      enum: apiToolApprovalModeSchema.options as [ApiToolApprovalMode, ...ApiToolApprovalMode[]],
    }).notNull(),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tool_approval_policies_lookup_idx').on(t.enabled, t.serverId, t.agentId),
    check(
      'tool_approval_policies_approval_mode_check',
      sql`${t.approvalMode} in (${sql.raw(apiToolApprovalModeSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'tool_approval_policies_role_check',
      sql`${t.role} is null or ${t.role} ~ '^(platform:[A-Za-z0-9_]+|agent:(owner|maintainer|user)|channel:(owner|admin|member|viewer)|service:(system|mcp))$'`,
    ),
  ],
);
