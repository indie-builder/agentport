import { z } from 'zod';

export const contentPolicyDirectionSchema = z.enum(['inbound', 'outbound']);
export type ContentPolicyDirection = z.infer<typeof contentPolicyDirectionSchema>;

export const contentPolicyActionSchema = z.enum(['block', 'redact', 'require_approval']);
export type ContentPolicyAction = z.infer<typeof contentPolicyActionSchema>;

export const contentPolicyMatchTypeSchema = z.enum(['keyword', 'regex', 'secret', 'pii']);
export type ContentPolicyMatchType = z.infer<typeof contentPolicyMatchTypeSchema>;

export const contentPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  direction: contentPolicyDirectionSchema,
  action: contentPolicyActionSchema,
  matchType: contentPolicyMatchTypeSchema,
  pattern: z.string(),
  caseSensitive: z.boolean(),
  agentId: z.string().nullable(),
  priority: z.number().int(),
  enabled: z.boolean(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ContentPolicy = z.infer<typeof contentPolicySchema>;

export const contentPolicyCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  direction: contentPolicyDirectionSchema,
  action: contentPolicyActionSchema,
  matchType: contentPolicyMatchTypeSchema,
  pattern: z.string().min(1).max(1000),
  caseSensitive: z.boolean().default(false),
  agentId: z.string().nullable().default(null),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
});
export type ContentPolicyCreate = z.infer<typeof contentPolicyCreateSchema>;

export const contentPolicyUpdateSchema = contentPolicyCreateSchema.partial().extend({
  description: z.string().max(500).optional(),
  caseSensitive: z.boolean().optional(),
  agentId: z.string().nullable().optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
});
export type ContentPolicyUpdate = z.infer<typeof contentPolicyUpdateSchema>;

export const policySourceKindSchema = z.enum([
  'run_prompt',
  'channel_message',
  'model_request',
  'assistant_output',
]);
export type PolicySourceKind = z.infer<typeof policySourceKindSchema>;

export const policyEventSchema = z.object({
  id: z.string(),
  policyId: z.string().nullable(),
  policyName: z.string(),
  policyVersion: z.number().int(),
  direction: contentPolicyDirectionSchema,
  action: contentPolicyActionSchema,
  sourceKind: policySourceKindSchema,
  sourceId: z.string(),
  runId: z.string().nullable(),
  channelId: z.string().nullable(),
  actor: z.string().nullable(),
  snippet: z.string(),
  destination: z.string().nullable(),
  createdAt: z.string(),
});
export type PolicyEvent = z.infer<typeof policyEventSchema>;

export const policyApprovalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type PolicyApprovalStatus = z.infer<typeof policyApprovalStatusSchema>;

export const policyApprovalSchema = z.object({
  id: z.string(),
  policyId: z.string().nullable(),
  policyName: z.string(),
  policyVersion: z.number().int(),
  sourceKind: policySourceKindSchema,
  sourceId: z.string(),
  runId: z.string().nullable(),
  channelId: z.string().nullable(),
  payloadHash: z.string(),
  destination: z.string().nullable(),
  status: policyApprovalStatusSchema,
  requestedBy: z.string(),
  requestedAt: z.string(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  expiresAt: z.string(),
  note: z.string().nullable(),
  consumedAt: z.string().nullable(),
});
export type PolicyApproval = z.infer<typeof policyApprovalSchema>;

export const policyApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().max(500).optional(),
});
export type PolicyApprovalDecision = z.infer<typeof policyApprovalDecisionSchema>;

export const violationCaseStatusSchema = z.enum(['open', 'investigating', 'resolved', 'dismissed']);
export type ViolationCaseStatus = z.infer<typeof violationCaseStatusSchema>;

export const violationSeveritySchema = z.enum(['low', 'medium', 'high']);

export const violationSubjectKindSchema = z.enum(['user', 'agent', 'channel']);
export type ViolationSeverity = z.infer<typeof violationSeveritySchema>;

export const violationCaseSchema = z.object({
  id: z.string(),
  policyId: z.string().nullable(),
  policyName: z.string(),
  eventId: z.string().nullable(),
  runId: z.string().nullable(),
  subjectKind: violationSubjectKindSchema,
  subjectId: z.string(),
  severity: violationSeveritySchema,
  status: violationCaseStatusSchema,
  assigneeBusinessId: z.string().nullable(),
  summary: z.string(),
  resolution: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ViolationCase = z.infer<typeof violationCaseSchema>;

export const violationCaseUpdateSchema = z.object({
  status: violationCaseStatusSchema.optional(),
  assigneeBusinessId: z.string().nullable().optional(),
  resolution: z.string().max(1000).nullable().optional(),
});
export type ViolationCaseUpdate = z.infer<typeof violationCaseUpdateSchema>;
