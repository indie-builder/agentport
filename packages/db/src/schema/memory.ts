import type {
  MemoryContentSnapshot,
  MemoryReviewProposal,
  MemoryReviewSource,
  MemoryReviewTarget,
} from '@agentport/shared';
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

/** 个人记忆：唯一一行文本，revision 做乐观并发控制；空内容时行可以不存在。 */
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

/**
 * 记忆审核：一次审核对应一条运行（runId 即主键），提案由模型生成、用户决定是否采纳。
 * userId + requestKey 唯一让重复提交幂等。
 */
export const memoryReviews = pgTable(
  'memory_reviews',
  {
    runId: text('run_id')
      .primaryKey()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    businessId: text('business_id').notNull(),
    requestKey: text('request_key').notNull(),
    requestHash: text('request_hash').notNull(),
    /** 执行审核的专家；运行与模型配置都取自它。 */
    modelAgentId: text('model_agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'restrict' }),
    target: jsonb('target').$type<MemoryReviewTarget>().notNull(),
    sources: jsonb('sources').$type<MemoryReviewSource[]>().notNull(),
    instruction: text('instruction').notNull().default(''),
    before: jsonb('before').$type<MemoryContentSnapshot>().notNull(),
    proposal: jsonb('proposal').$type<MemoryReviewProposal>(),
    decision: text('decision', { enum: ['pending', 'applied', 'rejected'] })
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

/** 记忆变更账本：采纳提案或撤销时各写一行，before/after 保留完整快照。 */
export const memoryChanges = pgTable(
  'memory_changes',
  {
    id: text('id').primaryKey(),
    businessId: text('business_id').notNull(),
    /** 个人记忆为 null；专家记忆/规则记录归属的智能体。 */
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'cascade' }),
    target: jsonb('target').$type<MemoryReviewTarget>().notNull(),
    before: jsonb('before').$type<MemoryContentSnapshot>().notNull(),
    after: jsonb('after').$type<MemoryContentSnapshot>().notNull(),
    sourceReviewRunId: text('source_review_run_id').references(() => agentRuns.id, {
      onDelete: 'set null',
    }),
    reversesChangeId: text('reverses_change_id'),
    state: text('state', { enum: ['applied'] })
      .notNull()
      .default('applied'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('memory_changes_business_created_idx').on(t.businessId, t.createdAt),
    index('memory_changes_agent_created_idx').on(t.agentId, t.createdAt),
  ],
);
