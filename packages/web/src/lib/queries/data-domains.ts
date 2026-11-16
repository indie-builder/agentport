import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type { DataDomain, DataDomainVersion, DataDomainVersionDetail } from '../api.js';
import { api } from '../api.js';

const dataDomainKeys = ['data-domains'] as const;

export function useDataDomains() {
  return useInfiniteQuery({
    queryKey: [...dataDomainKeys, 'list'],
    queryFn: ({ pageParam }) => api.dataDomainPage(pageParam ?? undefined),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function dataDomainQuery(id: string) {
  return queryOptions<DataDomain>({
    queryKey: [...dataDomainKeys, id],
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

export function dataDomainVersionsQuery(id: string) {
  return queryOptions<DataDomainVersion[]>({
    queryKey: [...dataDomainKeys, id, 'versions'],
    queryFn: () => api.dataDomainVersions(id),
    refetchInterval: (query) => (dataDomainBuildShouldPoll(query.state.data) ? 2_000 : false),
  });
}

export function dataDomainVersionQuery(id: string, versionId: string) {
  return queryOptions<DataDomainVersionDetail>({
    queryKey: [...dataDomainKeys, id, 'versions', versionId],
    queryFn: () => api.dataDomainVersion(id, versionId),
    enabled: Boolean(versionId),
    refetchInterval: (query) =>
      dataDomainBuildShouldPoll(query.state.data ? [query.state.data] : undefined) ? 2_000 : false,
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
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys }),
  });
}

export function useUpdateDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Parameters<typeof api.updateDataDomain>[1] }) =>
      api.updateDataDomain(vars.id, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys }),
  });
}

export function useDeleteDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.deleteDataDomain,
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys }),
  });
}

export function useCreateDataDomainVersion() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; projectFiles: Record<string, string> }) =>
      api.createDataDomainVersion(vars.id, vars.projectFiles),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys }),
  });
}

export function usePublishDataDomain() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; versionId: string }) =>
      api.publishDataDomain(vars.id, vars.versionId),
    onSuccess: () => void client.invalidateQueries({ queryKey: dataDomainKeys }),
  });
}

export function useTestDataDomainConnection() {
  return useMutation({
    mutationFn: (vars: { datasource: string; connection: Record<string, string> }) =>
      api.testDataDomainConnection(vars.datasource, vars.connection),
  });
}
