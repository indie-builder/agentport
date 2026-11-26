import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  DataDomain,
  DataDomainEnrichInput,
  DataDomainEnrichmentProposal,
  DataDomainEnrichmentProposalDetail,
  DataDomainIdentity,
  DataDomainQueryApproval,
  DataDomainQueryApprovalListQuery,
  DataDomainQueryApprovalPage,
  DataDomainQueryLogListQuery,
  DataDomainVersion,
  DataDomainVersionDetail,
} from '../api.js';
import { api } from '../api.js';
import { useCursorList } from './client.js';

export const dataDomainKeys = {
  all: ['data-domains'] as const,
  list: ['data-domains', 'list'] as const,
  detail: (id: string) => ['data-domains', id] as const,
  versions: (id: string) => ['data-domains', id, 'versions'] as const,
  version: (id: string, versionId: string) => ['data-domains', id, 'versions', versionId] as const,
  enrichmentProposals: (id: string) => ['data-domains', id, 'enrichment-proposals'] as const,
  enrichmentProposal: (id: string, proposalId: string) =>
    ['data-domains', id, 'enrichment-proposals', proposalId] as const,
  identities: (id: string) => ['data-domains', id, 'identities'] as const,
  queryLogs: (id: string, query: DataDomainQueryLogListQuery) =>
    ['data-domains', id, 'query-logs', query] as const,
  approvals: (id: string, query: DataDomainQueryApprovalListQuery) =>
    ['data-domains', id, 'approvals', query] as const,
  approvalsAll: (id: string) => ['data-domains', id, 'approvals'] as const,
};

export function useDataDomains() {
  return useCursorList({
    queryKey: dataDomainKeys.list,
    queryFn: (cursor) => api.dataDomainPage(cursor),
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

function dataDomainQuery(id: string) {
  return queryOptions<DataDomain>({
    queryKey: dataDomainKeys.detail(id),
    queryFn: () => api.dataDomain(id),
  });
}

export function dataDomainBuildShouldPoll(
  versions: Array<Pick<DataDomainVersion, 'status'>> | undefined,
): boolean {
  return (
    versions?.some((version) => version.status === 'queued' || version.status === 'building') ??
    false
  );
}

function dataDomainVersionsQuery(id: string) {
  return queryOptions<DataDomainVersion[]>({
    queryKey: dataDomainKeys.versions(id),
    queryFn: () => api.dataDomainVersions(id),
    refetchInterval: (query) => (dataDomainBuildShouldPoll(query.state.data) ? 2_000 : false),
  });
}

function dataDomainVersionQuery(id: string, versionId: string) {
  return queryOptions<DataDomainVersionDetail>({
    queryKey: dataDomainKeys.version(id, versionId),
    queryFn: () => api.dataDomainVersion(id, versionId),
    enabled: Boolean(versionId),
    refetchInterval: (query) =>
      dataDomainBuildShouldPoll(query.state.data ? [query.state.data] : undefined) ? 2_000 : false,
  });
}

function dataDomainEnrichmentProposalsQuery(id: string) {
  return queryOptions<DataDomainEnrichmentProposal[]>({
    queryKey: dataDomainKeys.enrichmentProposals(id),
    queryFn: () => api.dataDomainEnrichmentProposals(id),
    refetchInterval: (query) =>
      query.state.data?.some((proposal) => proposal.status === 'generating') ? 2_000 : false,
  });
}

function dataDomainEnrichmentProposalQuery(id: string, proposalId: string, enabled = true) {
  return queryOptions<DataDomainEnrichmentProposalDetail>({
    queryKey: dataDomainKeys.enrichmentProposal(id, proposalId),
    queryFn: () => api.dataDomainEnrichmentProposal(id, proposalId),
    enabled: Boolean(proposalId) && enabled,
  });
}

export function useDataDomain(id: string) {
  return useQuery(dataDomainQuery(id));
}

export function useDataDomainVersions(id: string) {
  return useQuery(dataDomainVersionsQuery(id));
}

export function useDataDomainVersion(id: string, versionId: string) {
  return useQuery(dataDomainVersionQuery(id, versionId));
}

export function useCreateDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createDataDomain,
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function useUpdateDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Parameters<typeof api.updateDataDomain>[1] }) =>
      api.updateDataDomain(vars.id, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function useDeleteDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteDataDomain,
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function useCreateDataDomainVersion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; projectFiles: Record<string, string> }) =>
      api.createDataDomainVersion(vars.id, vars.projectFiles),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function useGenerateDataDomainMdl() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.generateDataDomainMdl,
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function usePublishDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; versionId: string }) =>
      api.publishDataDomain(vars.id, vars.versionId),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function useTestDataDomainConnection() {
  return useMutation({
    mutationFn: (vars: { datasource: string; connection: Record<string, string> }) =>
      api.testDataDomainConnection(vars.datasource, vars.connection),
  });
}

export function useDataDomainEnrichmentProposals(id: string) {
  return useQuery(dataDomainEnrichmentProposalsQuery(id));
}

export function useDataDomainEnrichmentProposal(id: string, proposalId: string, enabled: boolean) {
  return useQuery(dataDomainEnrichmentProposalQuery(id, proposalId, enabled));
}

export function useEnrichDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: DataDomainEnrichInput }) =>
      api.enrichDataDomain(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function useDecideDataDomainEnrichmentProposal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; proposalId: string; decision: 'approve' | 'reject' }) =>
      api.decideDataDomainEnrichmentProposal(vars.id, vars.proposalId, vars.decision),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys.all }),
  });
}

export function useDataDomainIdentities(id: string) {
  return useQuery<DataDomainIdentity[]>({
    queryKey: dataDomainKeys.identities(id),
    queryFn: () => api.dataDomainIdentities(id),
  });
}

export function useUpsertDataDomainIdentity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; businessId: string; properties: Record<string, string> }) =>
      api.upsertDataDomainIdentity(vars.id, vars.businessId, vars.properties),
    onSuccess: (_, vars) =>
      void client.invalidateQueries({ queryKey: dataDomainKeys.identities(vars.id) }),
  });
}

export function useRemoveDataDomainIdentity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; businessId: string }) =>
      api.removeDataDomainIdentity(vars.id, vars.businessId),
    onSuccess: (_, vars) =>
      void client.invalidateQueries({ queryKey: dataDomainKeys.identities(vars.id) }),
  });
}

export function useDataDomainQueryLogs(id: string, query: DataDomainQueryLogListQuery) {
  return useCursorList({
    queryKey: dataDomainKeys.queryLogs(id, query),
    queryFn: (cursor) =>
      api.dataDomainQueryLogs(id, {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      }),
  });
}

export function dataDomainApprovalsShouldPoll(
  query: DataDomainQueryApprovalListQuery,
  pages: DataDomainQueryApprovalPage[] | undefined,
): boolean {
  return (
    query.status === 'pending' ||
    (pages?.some((page) => page.items.some((item) => item.status === 'pending')) ?? false)
  );
}

export function useDataDomainQueryApprovals(id: string, query: DataDomainQueryApprovalListQuery) {
  return useCursorList({
    queryKey: dataDomainKeys.approvals(id, query),
    queryFn: (cursor) =>
      api.dataDomainQueryApprovals(id, {
        ...query,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    refetchInterval: ({ state }) =>
      dataDomainApprovalsShouldPoll(query, state.data?.pages) ? 8_000 : false,
  });
}

export function useDecideDataDomainApproval() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      approvalId: string;
      decision: 'approve' | 'reject';
      note: string;
    }): Promise<DataDomainQueryApproval> =>
      api.decideDataDomainApproval(vars.id, vars.approvalId, vars.decision, vars.note),
    onSuccess: (_, vars) =>
      void client.invalidateQueries({ queryKey: dataDomainKeys.approvalsAll(vars.id) }),
  });
}
