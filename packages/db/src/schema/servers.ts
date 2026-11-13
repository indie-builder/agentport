import type { ResolvedRuntimeEnvironment } from '@agentport/shared';
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
    kind: text('kind', { enum: ['stdio', 'http', 'generated', 'knowledge'] }).notNull(),
    description: text('description').notNull().default(''),
    // command / args / url / headers 等非敏感字段
    config: jsonb('config').$type<Record<string, unknown>>().notNull(),
    // AES-256-GCM 加密后的 env / headers
    secretsEncrypted: text('secrets_encrypted'),
    /** 最近一次「测试连接」的结果快照；刷新后仍能显示连接健康度。 */
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastToolCount: integer('last_tool_count'),
    /** 最近一次试连实际解析到的环境版本身份；不能把一次成功当成其他环境也成功。 */
    lastTestRuntimeEnvironment: jsonb(
      'last_test_runtime_environment',
    ).$type<ResolvedRuntimeEnvironment>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('servers_name_idx').on(t.name),
    check('servers_kind_check', sql`${t.kind} in ('stdio', 'http', 'generated', 'knowledge')`),
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
    /** MCP outputSchema；导入时来自 OpenAPI 响应结构，未声明为 null。 */
    outputSchema: jsonb('output_schema').$type<Record<string, unknown>>(),
    paramsIn: text('params_in', { enum: ['query', 'body'] })
      .notNull()
      .default('query'),
    enabled: boolean('enabled').notNull().default(true),
    approvalMode: text('approval_mode', { enum: ['allow', 'ask', 'deny'] })
      .notNull()
      .default('allow'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('api_tools_server_name_idx').on(t.serverId, t.name)],
);
