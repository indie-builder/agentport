import type { AgentDefinition, AgentResourceVersions } from '@agentport/shared';
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
    judgeMode: text('judge_mode', { enum: ['contains', 'llm'] })
      .notNull()
      .default('contains'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('eval_cases_agent_idx').on(t.agentId),
    check('eval_cases_judge_mode_check', sql`${t.judgeMode} in ('contains', 'llm')`),
  ],
);

export type EvalCaseSnapshot = {
  id: string;
  name: string;
  prompt: string;
  expectation: string;
  judgeMode: 'contains' | 'llm';
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
    agentVersion: integer('agent_version'),
    definitionSnapshot: jsonb('definition_snapshot').$type<AgentDefinition>(),
    resourceVersions: jsonb('resource_versions').$type<AgentResourceVersions>(),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
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
    judgeReason: text('judge_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('eval_results_run_idx').on(t.evalRunId),
    uniqueIndex('eval_results_run_case_idx').on(t.evalRunId, t.caseId),
  ],
);
