import {
  businessIdSchema,
  dataDomainApprovalDecisionSchema,
  dataDomainConnectionTestInputSchema,
  dataDomainConnectionTestResultSchema,
  dataDomainEnrichInputSchema,
  dataDomainEnrichmentProposalDetailSchema,
  dataDomainEnrichmentProposalSchema,
  dataDomainIdentityInputSchema,
  dataDomainIdentitySchema,
  dataDomainInputSchema,
  dataDomainListQuerySchema,
  dataDomainListSchema,
  dataDomainOnlineVersionInputSchema,
  dataDomainPatchSchema,
  dataDomainProposalDecisionResultSchema,
  dataDomainProposalDecisionSchema,
  dataDomainQueryApprovalListQuerySchema,
  dataDomainQueryApprovalListSchema,
  dataDomainQueryApprovalSchema,
  dataDomainQueryLogListQuerySchema,
  dataDomainQueryLogListSchema,
  dataDomainSchema,
  dataDomainVersionDetailSchema,
  dataDomainVersionInputSchema,
  dataDomainVersionSchema,
  idParams,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';
import { domainErrors } from './errors.js';

const dataDomainsProcedure = contractProcedure.errors(domainErrors('BUDGET_EXCEEDED'));

const identityParams = idParams.extend({ businessId: businessIdSchema });
const approvalParams = idParams.extend({ approvalId: z.string().min(1) });
const versionParams = idParams.extend({ versionId: z.string().min(1) });
const proposalParams = idParams.extend({ proposalId: z.string().min(1) });

const read = dataDomainsProcedure.meta({
  access: { kind: 'permission', permissionId: 'data_domains.read' },
});

export const dataDomainsContract = {
  list: read
    .route({ method: 'GET', path: '/data-domains' })
    .input(z.object({ query: dataDomainListQuerySchema }))
    .output(dataDomainListSchema),
  create: dataDomainsProcedure
    .errors(domainErrors('CONFLICT'))
    .route({ method: 'POST', path: '/data-domains', successStatus: 201 })
    .input(z.object({ body: dataDomainInputSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.create' } }),
  testConnection: dataDomainsProcedure
    .route({ method: 'POST', path: '/data-domains/test-connection' })
    .input(z.object({ body: dataDomainConnectionTestInputSchema }))
    .output(dataDomainConnectionTestResultSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.create' } }),
  detail: read
    .route({ method: 'GET', path: '/data-domains/{id}' })
    .input(z.object({ params: idParams }))
    .output(dataDomainSchema),
  update: dataDomainsProcedure
    .errors(domainErrors('CONFLICT'))
    .route({ method: 'PATCH', path: '/data-domains/{id}' })
    .input(z.object({ params: idParams, body: dataDomainPatchSchema }))
    .output(dataDomainSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  remove: dataDomainsProcedure
    .errors(domainErrors('CONFLICT'))
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
  createVersion: dataDomainsProcedure
    .route({ method: 'POST', path: '/data-domains/{id}/versions', successStatus: 202 })
    .input(z.object({ params: idParams, body: dataDomainVersionInputSchema }))
    .output(dataDomainVersionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
  generateMdl: dataDomainsProcedure
    .route({ method: 'POST', path: '/data-domains/{id}/generate-mdl', successStatus: 202 })
    .input(z.object({ params: idParams }))
    .output(dataDomainVersionSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
  publish: dataDomainsProcedure
    .errors(domainErrors('CONFLICT'))
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
  decideApproval: dataDomainsProcedure
    .errors(domainErrors('CONFLICT'))
    .route({ method: 'POST', path: '/data-domains/{id}/approvals/{approvalId}/decision' })
    .input(z.object({ params: approvalParams, body: dataDomainApprovalDecisionSchema }))
    .output(dataDomainQueryApprovalSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  upsertIdentity: dataDomainsProcedure
    .route({ method: 'PUT', path: '/data-domains/{id}/identities/{businessId}' })
    .input(z.object({ params: identityParams, body: dataDomainIdentityInputSchema }))
    .output(dataDomainIdentitySchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  removeIdentity: dataDomainsProcedure
    .route({
      method: 'DELETE',
      path: '/data-domains/{id}/identities/{businessId}',
      successStatus: 204,
    })
    .input(z.object({ params: identityParams }))
    .output(z.void())
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.update' } }),
  enrich: dataDomainsProcedure
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
  decideProposal: dataDomainsProcedure
    .errors(domainErrors('CONFLICT'))
    .route({
      method: 'POST',
      path: '/data-domains/{id}/proposals/{proposalId}/decision',
    })
    .input(z.object({ params: proposalParams, body: dataDomainProposalDecisionSchema }))
    .output(dataDomainProposalDecisionResultSchema)
    .meta({ access: { kind: 'permission', permissionId: 'data_domains.build' } }),
};
