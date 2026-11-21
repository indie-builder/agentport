import type {
  MemoryContentSnapshot,
  MemoryReviewDecision,
  MemoryReviewProposal,
  MemoryReviewSource,
  MemoryReviewTarget,
} from '@agentport/shared';
import { memoryChangeStateSchema, memoryReviewDecisionValueSchema } from '@agentport/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { agents } from './agents.js';
import { agentRuns } from './chat.js';

export const userPreferences = pgTable(
  'user_preferences',
  {
    businessId: text('business_id').primaryKey(),
    content: text('content').notNull().default(''),
    revision: integer('revision').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('user_preferences_revision_check', sql`${t.revision} >= 0`)],
);

export const memoryReviews = pgTable(
  'memory_reviews',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    modelAgentId: text('model_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    target: jsonb('target').$type<MemoryReviewTarget>().notNull(),
    sources: jsonb('sources').$type<MemoryReviewSource[]>().notNull(),
    instruction: text('instruction').notNull().default(''),
    before: jsonb('before').$type<MemoryContentSnapshot>().notNull(),
    proposal: jsonb('proposal').$type<MemoryReviewProposal>(),
    decision: text('decision', {
      enum: memoryReviewDecisionValueSchema.options as [
        MemoryReviewDecision,
        ...MemoryReviewDecision[],
      ],
    })
      .notNull()
      .default('pending'),
    appliedChangeId: text('applied_change_id').references(() => memoryChanges.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memory_reviews_business_request_idx').on(t.businessId, t.requestKey),
    check(
      'memory_reviews_applied_change_check',
      sql`(${t.decision} = 'applied') = (${t.appliedChangeId} is not null)`,
    ),
  ],
);

export const memoryChanges = pgTable(
  'memory_changes',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id').notNull(),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    target: jsonb('target').$type<MemoryReviewTarget>().notNull(),
    before: jsonb('before').$type<MemoryContentSnapshot>().notNull(),
    after: jsonb('after').$type<MemoryContentSnapshot>().notNull(),
    sourceReviewRunId: text('source_review_run_id').references(() => agentRuns.id, {
      onDelete: 'set null',
    }),
    reversesChangeId: text('reverses_change_id'),
    state: text('state', {
      enum: [memoryChangeStateSchema.value] as [typeof memoryChangeStateSchema.value],
    })
      .notNull()
      .default('applied'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memory_changes_business_created_idx').on(t.businessId, t.createdAt),
    index('memory_changes_agent_created_idx').on(t.agentId, t.createdAt),
  ],
);
