import type {
  ApiToolApprovalMode,
  ApiToolParamsIn,
  ResolvedRuntimeEnvironment,
  ServerKind,
} from '@agentport/shared';
import {
  apiToolApprovalModeSchema,
  apiToolParamsInSchema,
  serverKindSchema,
} from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const servers = pgTable(
  'servers',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', {
      enum: serverKindSchema.options as [ServerKind, ...ServerKind[]],
    }).notNull(),
    description: text('description').notNull().default(''),
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    secretsEncrypted: text('secrets_encrypted'),
    ownerBusinessId: text('owner_business_id'),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastToolCount: integer('last_tool_count'),
    lastTestRuntimeEnvironment: jsonb(
      'last_test_runtime_environment',
    ).$type<ResolvedRuntimeEnvironment>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('servers_name_idx').on(t.name),
    check(
      'servers_kind_check',
      sql`${t.kind} in (${sql.raw(serverKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const apiTools = pgTable(
  'api_tools',
  {
    id: text('id').primaryKey(),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    method: text('method').notNull(),
    pathTemplate: text('path_template').notNull(),
    inputSchema: jsonb('input_schema').$type<Record<string, unknown>>().notNull(),
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    paramsIn: text('params_in', {
      enum: apiToolParamsInSchema.options as [ApiToolParamsIn, ...ApiToolParamsIn[]],
    })
      .notNull()
      .default('query'),
    enabled: boolean('enabled').notNull().default(true),
    approvalMode: text('approval_mode', {
      enum: apiToolApprovalModeSchema.options as [ApiToolApprovalMode, ...ApiToolApprovalMode[]],
    })
      .notNull()
      .default('allow'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_tools_server_name_idx').on(t.serverId, t.name)],
);
