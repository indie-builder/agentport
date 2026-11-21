import type { WebhookEventType } from '@agentport/shared';
import { webhookEventTypeSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    scopes: text('scopes', { enum: ['runs.create', 'runs.read'] })
      .array()
      .notNull(),
    ownerBusinessId: text('owner_business_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_tokens_token_hash_idx').on(t.tokenHash),
    index('api_tokens_owner_idx').on(t.ownerBusinessId),
    check(
      'api_tokens_scopes_check',
      sql`cardinality(${t.scopes}) > 0 and ${t.scopes} <@ array['runs.create', 'runs.read']::text[]`,
    ),
  ],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    url: text('url'),
    secretEncrypted: text('secret_encrypted').notNull(),
    events: text('events', {
      enum: webhookEventTypeSchema.options as [WebhookEventType, ...WebhookEventType[]],
    })
      .array()
      .notNull()
      .default([]),
    enabled: boolean('enabled').notNull().default(true),
    ownerBusinessId: text('owner_business_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('webhook_endpoints_owner_idx').on(t.ownerBusinessId),
    index('webhook_endpoints_direction_idx').on(t.direction),
    check(
      'webhook_endpoints_events_check',
      sql`${t.events} <@ array[${sql.raw(webhookEventTypeSchema.options.map((option) => `'${option}'`).join(', '))}]::text[]`,
    ),
    check(
      'webhook_endpoints_direction_check',
      sql`(${t.direction} = 'inbound' and ${t.agentId} is not null and ${t.url} is null) or (${t.direction} = 'outbound' and ${t.agentId} is null and ${t.url} is not null and cardinality(${t.events}) > 0)`,
    ),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventType: text('event_type', {
      enum: webhookEventTypeSchema.options as [WebhookEventType, ...WebhookEventType[]],
    }).notNull(),
    sourceId: text('source_id').notNull(),
    payload: text('payload').notNull(),
    status: text('status', { enum: ['pending', 'delivering', 'succeeded', 'failed'] })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('webhook_deliveries_event_idx').on(t.endpointId, t.eventType, t.sourceId),
    index('webhook_deliveries_status_next_idx').on(t.status, t.nextAttemptAt),
    check(
      'webhook_deliveries_event_type_check',
      sql`${t.eventType} in (${sql.raw(webhookEventTypeSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'webhook_deliveries_status_check',
      sql`${t.status} in ('pending', 'delivering', 'succeeded', 'failed')`,
    ),
  ],
);

export const externalRequestKeys = pgTable(
  'external_request_keys',
  {
    id: text('id').primaryKey(),
    sourceKind: text('source_kind', { enum: ['api_token', 'webhook'] }).notNull(),
    sourceId: text('source_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    runId: text('run_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('external_request_keys_key_idx').on(t.sourceKind, t.sourceId, t.idempotencyKey),
    check(
      'external_request_keys_source_kind_check',
      sql`${t.sourceKind} in ('api_token', 'webhook')`,
    ),
  ],
);
