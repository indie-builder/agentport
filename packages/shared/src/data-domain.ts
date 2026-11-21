import { z } from 'zod';
import { slugSchema } from './params.js';

export const DATA_DOMAIN_BUILDS_QUEUE = 'data-domain-builds';

export const dataDomainBuildJobSchema = z.object({
  dataDomainId: z.string().min(1),
  versionId: z.string().min(1),
});
export type DataDomainBuildJob = z.infer<typeof dataDomainBuildJobSchema>;

export function dataDomainBuildEnqueueOptions(versionId: string) {
  return {
    jobId: versionId,
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 200,
  };
}

export const DATA_DOMAIN_ENRICHMENTS_QUEUE = 'data-domain-enrichments';

export const dataDomainEnrichmentJobSchema = z.object({
  dataDomainId: z.string().min(1),
  proposalId: z.string().min(1),
});
export type DataDomainEnrichmentJob = z.infer<typeof dataDomainEnrichmentJobSchema>;

export function dataDomainEnrichmentEnqueueOptions(proposalId: string) {
  return { jobId: proposalId, attempts: 1, removeOnComplete: 100, removeOnFail: 200 };
}

export const dataDomainEnrichmentOutputSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  updatedFiles: z.record(z.string().min(1).max(512), z.string()),
  removedPaths: z.array(z.string().min(1).max(512)).default([]),
});
export type DataDomainEnrichmentOutput = z.infer<typeof dataDomainEnrichmentOutputSchema>;

export const dataDomainQueryApprovalModeSchema = z.enum(['off', 'all']);

export type DataDomainQueryApprovalMode = z.infer<typeof dataDomainQueryApprovalModeSchema>;

const connectionSchema = z.record(z.string().min(1).max(128), z.string().max(4096));

const dataDomainSlugSchema = slugSchema.max(61);

export const dataDomainListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const dataDomainInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  slug: dataDomainSlugSchema,
  description: z.string().trim().max(2000).default(''),
  datasource: z.string().trim().min(1).max(64),
  connection: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写连接配置'),
  queryApprovalMode: dataDomainQueryApprovalModeSchema.default('off'),
});
export type DataDomainInput = z.infer<typeof dataDomainInputSchema>;

export const dataDomainConnectionTestInputSchema = z.object({
  datasource: z.string().trim().min(1).max(64),
  connection: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写连接配置'),
});

export const dataDomainConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type DataDomainConnectionTestResult = z.infer<typeof dataDomainConnectionTestResultSchema>;

export const dataDomainPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    slug: dataDomainSlugSchema,
    description: z.string().trim().max(2000),
    datasource: z.string().trim().min(1).max(64),
    connection: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写连接配置'),
    queryApprovalMode: dataDomainQueryApprovalModeSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, { message: '至少需要修改一项' });
export type DataDomainPatch = z.infer<typeof dataDomainPatchSchema>;

export const dataDomainSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  datasource: z.string(),
  onlineVersionId: z.string().nullable(),
  queryApprovalMode: dataDomainQueryApprovalModeSchema,
  createdBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DataDomain = z.infer<typeof dataDomainSchema>;

export const dataDomainListSchema = z.object({
  items: z.array(dataDomainSchema),
  nextCursor: z.string().nullable(),
});
export type DataDomainList = z.infer<typeof dataDomainListSchema>;

export const dataDomainVersionSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  status: z.enum(['queued', 'building', 'ready', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DataDomainVersion = z.infer<typeof dataDomainVersionSchema>;

export const dataDomainVersionDetailSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  status: z.enum(['queued', 'building', 'ready', 'failed']),
  logTail: z.string(),
  logTruncated: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DataDomainVersionDetail = z.infer<typeof dataDomainVersionDetailSchema>;

export const dataDomainVersionInputSchema = z.object({
  projectFiles: z.record(z.string().min(1).max(512), z.string()),
});

export const dataDomainOnlineVersionInputSchema = z.object({
  versionId: z.string().min(1),
});

export const dataDomainIdentitySchema = z.object({
  businessId: z.string(),
  properties: connectionSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DataDomainIdentity = z.infer<typeof dataDomainIdentitySchema>;

export const dataDomainIdentityInputSchema = z.object({
  properties: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写属性'),
});

const dataDomainQueryLogSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  versionId: z.string().nullable(),
  serverId: z.string(),
  runId: z.string(),
  actorBusinessId: z.string().nullable(),
  sqlSummary: z.string(),
  rowCount: z.number().int().nullable(),
  status: z.enum(['ok', 'error']),
  durationMs: z.number().int(),
  createdAt: z.string(),
});

export const dataDomainQueryLogListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['ok', 'error']).optional(),
  runId: z.string().min(1).max(128).optional(),
});
export type DataDomainQueryLogListQuery = z.infer<typeof dataDomainQueryLogListQuerySchema>;

export const dataDomainQueryLogListSchema = z.object({
  items: z.array(dataDomainQueryLogSchema),
  nextCursor: z.string().nullable(),
});
export type DataDomainQueryLogList = z.infer<typeof dataDomainQueryLogListSchema>;

export const dataDomainQueryApprovalSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  serverId: z.string(),
  runId: z.string(),
  actorBusinessId: z.string().nullable(),
  sqlText: z.string(),
  sqlHash: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  decisionNote: z.string(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedByBusinessId: z.string().nullable(),
});
export type DataDomainQueryApproval = z.infer<typeof dataDomainQueryApprovalSchema>;

export const dataDomainQueryApprovalListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});
export type DataDomainQueryApprovalListQuery = z.infer<
  typeof dataDomainQueryApprovalListQuerySchema
>;

export const dataDomainQueryApprovalListSchema = z.object({
  items: z.array(dataDomainQueryApprovalSchema),
  nextCursor: z.string().nullable(),
});
export type DataDomainQueryApprovalList = z.infer<typeof dataDomainQueryApprovalListSchema>;

export const dataDomainApprovalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(2000).default(''),
});

export const dataDomainEnrichmentProposalSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  sourceVersionId: z.string(),
  status: z.enum(['generating', 'ready', 'approved', 'rejected', 'failed']),
  instruction: z.string(),
  summary: z.string(),
  error: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedByBusinessId: z.string().nullable(),
});
export type DataDomainEnrichmentProposal = z.infer<typeof dataDomainEnrichmentProposalSchema>;

const dataDomainProposalChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed']),
});

export const dataDomainEnrichmentProposalDetailSchema = dataDomainEnrichmentProposalSchema.extend({
  projectFiles: z.record(z.string(), z.string()),
  changedFiles: z.array(dataDomainProposalChangeSchema),
});
export type DataDomainEnrichmentProposalDetail = z.infer<
  typeof dataDomainEnrichmentProposalDetailSchema
>;

export const dataDomainEnrichInputSchema = z.object({
  sourceVersionId: z.string().min(1),
  instruction: z.string().trim().min(1).max(4000),
});
export type DataDomainEnrichInput = z.infer<typeof dataDomainEnrichInputSchema>;

export const dataDomainProposalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});

export const dataDomainProposalDecisionResultSchema = z.object({
  proposal: dataDomainEnrichmentProposalSchema,
  version: dataDomainVersionSchema.nullable(),
});
export type DataDomainProposalDecisionResult = z.infer<
  typeof dataDomainProposalDecisionResultSchema
>;
