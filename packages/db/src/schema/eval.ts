import { eq, sql } from 'drizzle-orm';
import {
  boolean,
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

export const evalCases = pgTable(
  'eval_cases',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    expectation: text('expectation').notNull().default(''),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('eval_cases_agent_idx').on(t.agentId)],
);

/** 评估用例快照：源用例删除后，历史跑批仍能展示当时测了什么。 */
export type EvalCaseSnapshot = {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
};

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['running', 'succeeded', 'failed', 'cancelled'] })
      .notNull()
      .default('running'),
    total: integer('total').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    error: text('error'),
    caseSnapshot: jsonb('case_snapshot').$type<EvalCaseSnapshot[]>(),
    /** 评估执行主体就是创建人；worker 触发时重新校验其权限。 */
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** 认领时刻：BullMQ 重复投递时，只有抢到认领的 worker 才执行。 */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    // 分页按 (created_at, id) 倒序取前 N 行；升序索引即可反向扫描，避免 DESC NULLS LAST 与查询排序不匹配。
    index('eval_runs_agent_created_idx').on(t.agentId, t.createdAt, t.id),
    index('eval_runs_created_idx').on(t.createdAt, t.id),
    check(
      'eval_runs_status_check',
      sql`${t.status} in ('running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'eval_runs_counts_check',
      sql`${t.total} >= 0 and ${t.passed} >= 0 and ${t.passed} <= ${t.total}`,
    ),
    // 同一智能体同时最多一个在跑的评估；DB 层兜底 API 的 409 检查并发竞态。
    uniqueIndex('eval_runs_agent_running_idx').on(t.agentId).where(eq(t.status, 'running')),
  ],
);

export const evalResults = pgTable(
  'eval_results',
  {
    id: text('id').primaryKey(),
    evalRunId: text('eval_run_id')
      .notNull()
      .references(() => evalRuns.id, { onDelete: 'cascade' }),
    caseId: text('case_id').references(() => evalCases.id, { onDelete: 'set null' }),
    caseSnapshot: jsonb('case_snapshot').$type<EvalCaseSnapshot>(),
    runId: text('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    passed: boolean('passed').notNull(),
    output: text('output').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('eval_results_run_idx').on(t.evalRunId),
    // 重复投递的 eval job 会重写同一 run/case 的结果，唯一键让写入幂等。
    uniqueIndex('eval_results_run_case_idx').on(t.evalRunId, t.caseId),
  ],
);
