import {
  businessIdSchema,
  dataDomainQueryApprovalModeSchema,
  idParams,
  slugSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

const connectionSchema = z.record(z.string().min(1).max(128), z.string().max(4096));

const dataDomainSlugSchema = slugSchema.max(61);

const dataDomainListQuerySchema = z.object({
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

export const dataDomainConnectionTestInputSchema = z.object({
  datasource: z.string().trim().min(1).max(64),
  connection: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写连接配置'),
});

export const dataDomainConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

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

export const dataDomainListSchema = z.object({
  items: z.array(dataDomainSchema),
  nextCursor: z.string().nullable(),
});

export const dataDomainVersionSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  status: z.enum(['queued', 'building', 'ready', 'failed']),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const dataDomainVersionDetailSchema = z.object({
  id: z.string(),
  dataDomainId: z.string(),
  status: z.enum(['queued', 'building', 'ready', 'failed']),
  logTail: z.string(),
  logTruncated: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

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

export const dataDomainIdentityInputSchema = z.object({
  properties: connectionSchema.refine((value) => Object.keys(value).length > 0, '请填写属性'),
});

export const dataDomainQueryLogSchema = z.object({
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

export const dataDomainQueryLogListSchema = z.object({
  items: z.array(dataDomainQueryLogSchema),
  nextCursor: z.string().nullable(),
});

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

export const dataDomainQueryApprovalListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
});

export const dataDomainQueryApprovalListSchema = z.object({
  items: z.array(dataDomainQueryApprovalSchema),
  nextCursor: z.string().nullable(),
});

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

export const dataDomainProposalChangeSchema = z.object({
  path: z.string(),
  status: z.enum(['added', 'modified', 'removed']),
});

export const dataDomainEnrichmentProposalDetailSchema = dataDomainEnrichmentProposalSchema.extend({
  projectFiles: z.record(z.string(), z.string()),
  changedFiles: z.array(dataDomainProposalChangeSchema),
});

export const dataDomainEnrichInputSchema = z.object({
  sourceVersionId: z.string().min(1),
  instruction: z.string().trim().min(1).max(4000),
});

export const dataDomainProposalDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject']),
});

export const dataDomainProposalDecisionResultSchema = z.object({
  proposal: dataDomainEnrichmentProposalSchema,
  version: dataDomainVersionSchema.nullable(),
});

const identityParams = idParams.extend({ businessId: businessIdSchema });
const approvalParams = idParams.extend({ approvalId: z.string().min(1) });
const versionParams = idParams.extend({ versionId: z.string().min(1) });
const proposalParams = idParams.extend({ proposalId: z.string().min(1) });

const read = contractProcedure.meta({
  access: { kind: 'permission', permissionId: 'data_domains.read' },
});

export const dataDomainsContract = {
  list: read
    .route({ method: 'GET', path: '/data-domains' })
    .input(z.object({ query: dataDomainListQuerySchema }))
    .output(dataDomainListSchema),
  create: contractProcedure
    .route({ method: 'POST', path: '/data-domains', successStatus: 201 })
    .input(z.object({ body: dataDomainInputSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.create' } }),
  testConnection: contractProcedure
    .route({ method: 'POST', path: '/data-domains/test-connection' })
    .input(z.object({ body: dataDomainConnectionTestInputSchema }))
    .output(dataDomainConnectionTestResultSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.create' } }),
  detail: read
    .route({ method: 'GET', path: '/data-domains/{id}' })
    .input(z.object({ params: idParams }))
    .output(dataDomainSchema),
  update: contractProcedure
    .route({ method: 'PATCH', path: '/data-domains/{id}' })
    .input(z.object({ params: idParams, body: dataDomainPatchSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  remove: contractProcedure
    .route({ method: 'DELETE', path: '/data-domains/{id}', successStatus: 204 })
    .input(z.object({ params: idParams }))
    .output(z.void())
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.delete' } }),
  versions: read
    .route({ method: 'GET', path: '/data-domains/{id}/versions' })
    .input(z.object({ params: idParams }))
    .output(z.array(dataDomainVersionSchema)),
  versionDetail: read
    .route({ method: 'GET', path: '/data-domains/{id}/versions/{versionId}' })
    .input(z.object({ params: versionParams }))
    .output(dataDomainVersionDetailSchema),
  createVersion: contractProcedure
    .route({ method: 'POST', path: '/data-domains/{id}/versions', successStatus: 202 })
    .input(z.object({ params: idParams, body: dataDomainVersionInputSchema }))
    .output(dataDomainVersionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
  generateMdl: contractProcedure
    .route({ method: 'POST', path: '/data-domains/{id}/generate-mdl', successStatus: 202 })
    .input(z.object({ params: idParams }))
    .output(dataDomainVersionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
  publish: contractProcedure
    .route({ method: 'PUT', path: '/data-domains/{id}/online-version' })
    .input(z.object({ params: idParams, body: dataDomainOnlineVersionInputSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.publish' } }),
  identities: read
    .route({ method: 'GET', path: '/data-domains/{id}/identities' })
    .input(z.object({ params: idParams }))
    .output(z.array(dataDomainIdentitySchema)),
  queryLogs: read
    .route({ method: 'GET', path: '/data-domains/{id}/query-logs' })
    .input(z.object({ params: idParams, query: dataDomainQueryLogListQuerySchema }))
    .output(dataDomainQueryLogListSchema),
  approvals: read
    .route({ method: 'GET', path: '/data-domains/{id}/approvals' })
    .input(z.object({ params: idParams, query: dataDomainQueryApprovalListQuerySchema }))
    .output(dataDomainQueryApprovalListSchema),
  decideApproval: contractProcedure
    .route({ method: 'POST', path: '/data-domains/{id}/approvals/{approvalId}/decision' })
    .input(z.object({ params: approvalParams, body: dataDomainApprovalDecisionSchema }))
    .output(dataDomainQueryApprovalSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  upsertIdentity: contractProcedure
    .route({ method: 'PUT', path: '/data-domains/{id}/identities/{businessId}' })
    .input(z.object({ params: identityParams, body: dataDomainIdentityInputSchema }))
    .output(dataDomainIdentitySchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  removeIdentity: contractProcedure
    .route({
      method: 'DELETE',
      path: '/data-domains/{id}/identities/{businessId}',
      successStatus: 204,
    })
    .input(z.object({ params: identityParams }))
    .output(z.void())
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  enrich: contractProcedure
    .route({ method: 'POST', path: '/data-domains/{id}/enrich', successStatus: 202 })
    .input(z.object({ params: idParams, body: dataDomainEnrichInputSchema }))
    .output(dataDomainEnrichmentProposalSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
  proposals: read
    .route({ method: 'GET', path: '/data-domains/{id}/proposals' })
    .input(z.object({ params: idParams }))
    .output(z.array(dataDomainEnrichmentProposalSchema)),
  proposalDetail: read
    .route({ method: 'GET', path: '/data-domains/{id}/proposals/{proposalId}' })
    .input(z.object({ params: proposalParams }))
    .output(dataDomainEnrichmentProposalDetailSchema),
  decideProposal: contractProcedure
    .route({
      method: 'POST',
      path: '/data-domains/{id}/proposals/{proposalId}/decision',
    })
    .input(z.object({ params: proposalParams, body: dataDomainProposalDecisionSchema }))
    .output(dataDomainProposalDecisionResultSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
};
