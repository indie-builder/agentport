import type {
  ContentPolicyAction,
  ContentPolicyDirection,
  ContentPolicyMatchType,
  PolicyApprovalStatus,
  PolicySourceKind,
} from '@agentport/shared';
import {
  contentPolicyActionSchema,
  contentPolicyDirectionSchema,
  contentPolicyMatchTypeSchema,
  policyApprovalStatusSchema,
  policySourceKindSchema,
  violationCaseStatusSchema,
  violationSeveritySchema,
  violationSubjectKindSchema,
} from '@agentport/shared';
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const contentPolicies = pgTable(
  'content_policies',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    direction: text('direction', {
      enum: contentPolicyDirectionSchema.options as [
        ContentPolicyDirection,
        ...ContentPolicyDirection[],
      ],
    }).notNull(),
    action: text('action', {
      enum: contentPolicyActionSchema.options as [ContentPolicyAction, ...ContentPolicyAction[]],
    }).notNull(),
    matchType: text('match_type', {
      enum: contentPolicyMatchTypeSchema.options as [
        ContentPolicyMatchType,
        ...ContentPolicyMatchType[],
      ],
    }).notNull(),
    pattern: text('pattern').notNull(),
    caseSensitive: boolean('case_sensitive').notNull().default(false),
    agentId: text('agent_id'),
    priority: integer('priority').notNull().default(100),
    enabled: boolean('enabled').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('content_policies_direction_enabled_idx').on(t.direction, t.enabled, t.priority),
    check('content_policies_priority_check', sql`${t.priority} >= 0`),
    check('content_policies_version_check', sql`${t.version} >= 1`),
    check(
      'content_policies_direction_check',
      sql`${t.direction} in (${sql.raw(contentPolicyDirectionSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'content_policies_action_check',
      sql`${t.action} in (${sql.raw(contentPolicyActionSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'content_policies_match_type_check',
      sql`${t.matchType} in (${sql.raw(contentPolicyMatchTypeSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const policyEvents = pgTable(
  'policy_events',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id').references(() => contentPolicies.id, { onDelete: 'set null' }),
    policyName: text('policy_name').notNull(),
    policyVersion: integer('policy_version').notNull(),
    direction: text('direction', {
      enum: contentPolicyDirectionSchema.options as [
        ContentPolicyDirection,
        ...ContentPolicyDirection[],
      ],
    }).notNull(),
    action: text('action', {
      enum: contentPolicyActionSchema.options as [ContentPolicyAction, ...ContentPolicyAction[]],
    }).notNull(),
    sourceKind: text('source_kind', {
      enum: policySourceKindSchema.options as [PolicySourceKind, ...PolicySourceKind[]],
    }).notNull(),
    sourceId: text('source_id').notNull(),
    runId: text('run_id'),
    channelId: text('channel_id'),
    actor: text('actor'),
    matchDigest: text('match_digest').notNull(),
    snippet: text('snippet').notNull(),
    destination: text('destination'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('policy_events_created_idx').on(t.createdAt),
    index('policy_events_run_idx').on(t.runId),
    index('policy_events_policy_created_idx').on(t.policyId, t.createdAt),
    check(
      'policy_events_direction_check',
      sql`${t.direction} in (${sql.raw(contentPolicyDirectionSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'policy_events_action_check',
      sql`${t.action} in (${sql.raw(contentPolicyActionSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'policy_events_source_kind_check',
      sql`${t.sourceKind} in (${sql.raw(policySourceKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const policyApprovals = pgTable(
  'policy_approvals',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id').references(() => contentPolicies.id, { onDelete: 'set null' }),
    policyName: text('policy_name').notNull(),
    policyVersion: integer('policy_version').notNull(),
    sourceKind: text('source_kind', {
      enum: policySourceKindSchema.options as [PolicySourceKind, ...PolicySourceKind[]],
    }).notNull(),
    sourceId: text('source_id').notNull(),
    runId: text('run_id'),
    channelId: text('channel_id'),
    payloadHash: text('payload_hash').notNull(),
    destination: text('destination'),
    status: text('status', {
      enum: policyApprovalStatusSchema.options as [PolicyApprovalStatus, ...PolicyApprovalStatus[]],
    })
      .notNull()
      .default('pending'),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    note: text('note'),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    index('policy_approvals_status_expires_idx').on(t.status, t.expiresAt),
    index('policy_approvals_requester_hash_idx').on(t.requestedBy, t.payloadHash),
    check(
      'policy_approvals_status_check',
      sql`${t.status} in (${sql.raw(policyApprovalStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'policy_approvals_source_kind_check',
      sql`${t.sourceKind} in (${sql.raw(policySourceKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);

export const violationCases = pgTable(
  'violation_cases',
  {
    id: text('id').primaryKey(),
    policyId: text('policy_id').references(() => contentPolicies.id, { onDelete: 'set null' }),
    policyName: text('policy_name').notNull(),
    eventId: text('event_id'),
    runId: text('run_id'),
    subjectKind: text('subject_kind', {
      enum: violationSubjectKindSchema.options as [
        (typeof violationSubjectKindSchema.options)[number],
        ...(typeof violationSubjectKindSchema.options)[number][],
      ],
    }).notNull(),
    subjectId: text('subject_id').notNull(),
    severity: text('severity', {
      enum: violationSeveritySchema.options as [
        (typeof violationSeveritySchema.options)[number],
        ...(typeof violationSeveritySchema.options)[number][],
      ],
    }).notNull(),
    status: text('status', {
      enum: violationCaseStatusSchema.options as [
        (typeof violationCaseStatusSchema.options)[number],
        ...(typeof violationCaseStatusSchema.options)[number][],
      ],
    })
      .notNull()
      .default('open'),
    assigneeBusinessId: text('assignee_business_id'),
    summary: text('summary').notNull(),
    resolution: text('resolution'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('violation_cases_status_created_idx').on(t.status, t.createdAt),
    index('violation_cases_assignee_idx').on(t.assigneeBusinessId),
    check(
      'violation_cases_subject_kind_check',
      sql`${t.subjectKind} in (${sql.raw(violationSubjectKindSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'violation_cases_severity_check',
      sql`${t.severity} in (${sql.raw(violationSeveritySchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
    check(
      'violation_cases_status_check',
      sql`${t.status} in (${sql.raw(violationCaseStatusSchema.options.map((option) => `'${option}'`).join(', '))})`,
    ),
  ],
);
