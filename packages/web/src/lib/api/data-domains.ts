import type {
  dataDomainConnectionTestResultSchema,
  dataDomainEnrichInputSchema,
  dataDomainEnrichmentProposalDetailSchema,
  dataDomainEnrichmentProposalSchema,
  dataDomainIdentitySchema,
  dataDomainInputSchema,
  dataDomainListSchema,
  dataDomainPatchSchema,
  dataDomainProposalDecisionResultSchema,
  dataDomainQueryApprovalListSchema,
  dataDomainQueryApprovalSchema,
  dataDomainQueryLogListSchema,
  dataDomainQueryLogSchema,
  dataDomainSchema,
  dataDomainVersionDetailSchema,
  dataDomainVersionSchema,
} from '@agentport/contract/data-domains';
import type { z } from 'zod';
import { rpc } from '../orpc.js';

export type DataDomain = z.infer<typeof dataDomainSchema>;
export type DataDomainInput = z.infer<typeof dataDomainInputSchema>;
export type DataDomainPatch = z.infer<typeof dataDomainPatchSchema>;
export type DataDomainVersion = z.infer<typeof dataDomainVersionSchema>;
export type DataDomainVersionDetail = z.infer<typeof dataDomainVersionDetailSchema>;
export type DataDomainConnectionTestResult = z.infer<typeof dataDomainConnectionTestResultSchema>;
export type DataDomainPage = z.infer<typeof dataDomainListSchema>;
export type DataDomainEnrichInput = z.infer<typeof dataDomainEnrichInputSchema>;
export type DataDomainEnrichmentProposal = z.infer<typeof dataDomainEnrichmentProposalSchema>;
export type DataDomainEnrichmentProposalDetail = z.infer<
  typeof dataDomainEnrichmentProposalDetailSchema
>;
export type DataDomainProposalDecisionResult = z.infer<
  typeof dataDomainProposalDecisionResultSchema
>;
export type DataDomainIdentity = z.infer<typeof dataDomainIdentitySchema>;
export type DataDomainQueryLog = z.infer<typeof dataDomainQueryLogSchema>;
export type DataDomainQueryLogPage = z.infer<typeof dataDomainQueryLogListSchema>;
export interface DataDomainQueryLogQuery {
  cursor?: string;
  limit?: number;
  status?: 'ok' | 'error';
  runId?: string;
}
export type DataDomainQueryApproval = z.infer<typeof dataDomainQueryApprovalSchema>;
export type DataDomainQueryApprovalPage = z.infer<typeof dataDomainQueryApprovalListSchema>;
export interface DataDomainQueryApprovalQuery {
  cursor?: string;
  limit?: number;
  status?: 'pending' | 'approved' | 'rejected';
}

export default {
  dataDomainPage: (cursor?: string | null): Promise<DataDomainPage> =>
    rpc.dataDomains.list({ query: cursor ? { cursor } : {} }),
  dataDomains: async (query?: { cursor?: string; limit?: number }): Promise<DataDomain[]> =>
    (await rpc.dataDomains.list({ query: query ?? {} })).items,
  dataDomain: (id: string): Promise<DataDomain> => rpc.dataDomains.detail({ params: { id } }),
  createDataDomain: (input: DataDomainInput): Promise<DataDomain> =>
    rpc.dataDomains.create({ body: input }),
  updateDataDomain: (id: string, patch: DataDomainPatch): Promise<DataDomain> =>
    rpc.dataDomains.update({ params: { id }, body: patch }),
  deleteDataDomain: (id: string): Promise<void> => rpc.dataDomains.remove({ params: { id } }),
  dataDomainVersions: (id: string): Promise<DataDomainVersion[]> =>
    rpc.dataDomains.versions({ params: { id } }),
  dataDomainVersion: (id: string, versionId: string): Promise<DataDomainVersionDetail> =>
    rpc.dataDomains.versionDetail({ params: { id, versionId } }),
  createDataDomainVersion: (
    id: string,
    projectFiles: Record<string, string>,
  ): Promise<DataDomainVersion> =>
    rpc.dataDomains.createVersion({ params: { id }, body: { projectFiles } }),
  generateDataDomainMdl: (id: string): Promise<DataDomainVersion> =>
    rpc.dataDomains.generateMdl({ params: { id } }),
  publishDataDomain: (id: string, versionId: string): Promise<DataDomain> =>
    rpc.dataDomains.publish({ params: { id }, body: { versionId } }),
  testDataDomainConnection: (
    datasource: string,
    connection: Record<string, string>,
  ): Promise<DataDomainConnectionTestResult> =>
    rpc.dataDomains.testConnection({ body: { datasource, connection } }),
  dataDomainIdentities: (id: string): Promise<DataDomainIdentity[]> =>
    rpc.dataDomains.identities({ params: { id } }),
  upsertDataDomainIdentity: (
    id: string,
    businessId: string,
    properties: Record<string, string>,
  ): Promise<DataDomainIdentity> =>
    rpc.dataDomains.upsertIdentity({ params: { id, businessId }, body: { properties } }),
  removeDataDomainIdentity: (id: string, businessId: string): Promise<void> =>
    rpc.dataDomains.removeIdentity({ params: { id, businessId } }),
  dataDomainQueryLogs: (
    id: string,
    query: DataDomainQueryLogQuery,
  ): Promise<DataDomainQueryLogPage> => rpc.dataDomains.queryLogs({ params: { id }, query }),
  dataDomainQueryApprovals: (
    id: string,
    query: DataDomainQueryApprovalQuery,
  ): Promise<DataDomainQueryApprovalPage> => rpc.dataDomains.approvals({ params: { id }, query }),
  decideDataDomainApproval: (
    id: string,
    approvalId: string,
    decision: 'approve' | 'reject',
    note: string,
  ): Promise<DataDomainQueryApproval> =>
    rpc.dataDomains.decideApproval({
      params: { id, approvalId },
      body: { decision, note },
    }),
  enrichDataDomain: (
    id: string,
    input: { sourceVersionId: string; instruction: string },
  ): Promise<DataDomainEnrichmentProposal> =>
    rpc.dataDomains.enrich({ params: { id }, body: input }),
  dataDomainEnrichmentProposals: (id: string): Promise<DataDomainEnrichmentProposal[]> =>
    rpc.dataDomains.proposals({ params: { id } }),
  dataDomainEnrichmentProposal: (
    id: string,
    proposalId: string,
  ): Promise<DataDomainEnrichmentProposalDetail> =>
    rpc.dataDomains.proposalDetail({ params: { id, proposalId } }),
  decideDataDomainEnrichmentProposal: (
    id: string,
    proposalId: string,
    decision: 'approve' | 'reject',
  ): Promise<DataDomainProposalDecisionResult> =>
    rpc.dataDomains.decideProposal({ params: { id, proposalId }, body: { decision } }),
};
