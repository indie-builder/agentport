import { z } from 'zod';
import { businessIdSchema, resourceKindSchema } from './access.js';

export const departmentMemberSchema = z.object({
  businessId: businessIdSchema,
  name: z.string(),
  accountActive: z.boolean(),
  isManager: z.boolean(),
});
export type DepartmentMember = z.infer<typeof departmentMemberSchema>;

export const governanceIdentitySchema = z.object({
  businessId: businessIdSchema,
  name: z.string(),
  accountActive: z.boolean(),
});
export type GovernanceIdentity = z.infer<typeof governanceIdentitySchema>;

export const departmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  members: z.array(departmentMemberSchema),
});
export type Department = z.infer<typeof departmentSchema>;

export const departmentInputSchema = z.object({ name: z.string().trim().min(1).max(128) }).strict();
export type DepartmentInput = z.infer<typeof departmentInputSchema>;

export const departmentMembersInputSchema = z
  .object({
    members: z.array(z.object({ businessId: businessIdSchema, isManager: z.boolean() }).strict()),
  })
  .strict();
export type DepartmentMembersInput = z.infer<typeof departmentMembersInputSchema>;

export const budgetScopeKindSchema = z.enum([
  'user',
  'department',
  'agent',
  'knowledge_base',
  'data_domain',
]);
export type BudgetScopeKind = z.infer<typeof budgetScopeKindSchema>;
export const budgetMetricSchema = z.enum(['cost_usd_month', 'documents', 'queries_month']);
export type BudgetMetric = z.infer<typeof budgetMetricSchema>;

export const budgetInputSchema = z
  .object({
    scopeKind: budgetScopeKindSchema,
    scopeId: z.string().min(1),
    metric: budgetMetricSchema,
    limitValue: z.number().nonnegative(),
    alertRatio: z.number().min(0).max(1).default(0.8),
    enabled: z.boolean().default(true),
  })
  .strict();
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export const budgetStatusSchema = z.object({
  id: z.string(),
  scopeKind: budgetScopeKindSchema,
  scopeId: z.string(),
  scopeName: z.string(),
  metric: budgetMetricSchema,
  limitValue: z.number(),
  alertRatio: z.number(),
  enabled: z.boolean(),
  used: z.number(),
  updatedAt: z.string(),
});
export type BudgetStatus = z.infer<typeof budgetStatusSchema>;

export const resourceGrantSchema = z.object({
  resourceKind: resourceKindSchema,
  resourceId: z.string(),
  businessId: businessIdSchema,
  name: z.string(),
  accountActive: z.boolean(),
  canUse: z.boolean(),
  canManage: z.boolean(),
});
export type ResourceGrant = z.infer<typeof resourceGrantSchema>;

export const resourceGrantInputSchema = z
  .object({
    resourceKind: resourceKindSchema,
    resourceId: z.string().min(1),
    businessId: businessIdSchema,
    canUse: z.boolean(),
    canManage: z.boolean(),
  })
  .strict()
  .refine((input) => input.canUse || input.canManage, { message: '至少授予使用或管理权限' });
export type ResourceGrantInput = z.infer<typeof resourceGrantInputSchema>;

export const governanceResourceSchema = z.object({
  resourceKind: resourceKindSchema,
  id: z.string(),
  name: z.string(),
  ownerBusinessId: businessIdSchema.nullable(),
  ownerName: z.string().nullable(),
});
export type GovernanceResource = z.infer<typeof governanceResourceSchema>;

export const handoverItemSchema = z.object({ id: z.string(), name: z.string() });
export type HandoverItem = z.infer<typeof handoverItemSchema>;
export const handoverScheduleItemSchema = handoverItemSchema.extend({
  agentName: z.string(),
  agentId: z.string(),
});
export type HandoverScheduleItem = z.infer<typeof handoverScheduleItemSchema>;

export const handoverChecklistSchema = z.object({
  businessId: businessIdSchema,
  name: z.string(),
  status: z.enum(['active', 'disabled', 'deleted']),
  counts: z.object({
    agents: z.number().int().nonnegative(),
    knowledgeBases: z.number().int().nonnegative(),
    dataDomains: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
    servers: z.number().int().nonnegative(),
    plugins: z.number().int().nonnegative(),
    runtimeEnvironments: z.number().int().nonnegative(),
    schedules: z.number().int().nonnegative(),
  }),
  items: z.object({
    agents: z.array(handoverItemSchema),
    knowledgeBases: z.array(handoverItemSchema),
    dataDomains: z.array(handoverItemSchema),
    skills: z.array(handoverItemSchema),
    servers: z.array(handoverItemSchema),
    plugins: z.array(handoverItemSchema),
    runtimeEnvironments: z.array(handoverItemSchema),
    schedules: z.array(handoverScheduleItemSchema),
  }),
  departments: z.array(z.object({ id: z.string(), name: z.string(), isManager: z.boolean() })),
});
export type HandoverChecklist = z.infer<typeof handoverChecklistSchema>;

export const handoverResourceKindSchema = z.enum([
  'agent',
  'schedule',
  'knowledge_base',
  'data_domain',
  'skill',
  'server',
  'plugin',
  'runtime_environment',
]);
export type HandoverResourceKind = z.infer<typeof handoverResourceKindSchema>;
export const handoverTransferInputSchema = z.object({ toBusinessId: businessIdSchema }).strict();
export type HandoverTransferInput = z.infer<typeof handoverTransferInputSchema>;
export const handoverTransferResultSchema = z.object({
  transferred: z.array(
    z.object({ resourceKind: handoverResourceKindSchema, count: z.number().int().nonnegative() }),
  ),
  total: z.number().int().nonnegative(),
});
export type HandoverTransferResult = z.infer<typeof handoverTransferResultSchema>;

export const costGroupBySchema = z.enum(['user', 'department', 'model']);
export type CostGroupBy = z.infer<typeof costGroupBySchema>;
export const costSummarySchema = z.object({
  days: z.number().int().positive(),
  since: z.string(),
  groupBy: costGroupBySchema,
  groups: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      runs: z.number().int().nonnegative(),
      costUsd: z.number(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    }),
  ),
});
export type CostSummary = z.infer<typeof costSummarySchema>;

export const alertSettingsSchema = z.object({
  runFailures: z.object({
    enabled: z.boolean(),
    threshold: z.number().int().positive(),
    windowMinutes: z.number().int().positive(),
  }),
  queueFailed: z.object({ enabled: z.boolean(), threshold: z.number().int().positive() }),
  queueWaiting: z.object({ enabled: z.boolean(), threshold: z.number().int().positive() }),
  updatedAt: z.string(),
});
export type AlertSettings = z.infer<typeof alertSettingsSchema>;
