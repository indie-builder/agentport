import type {
  RuntimeEnvironment,
  RuntimeEnvironmentVersion,
  RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export const runtimeEnvironmentsQuery = queryOptions<RuntimeEnvironment[]>({
  queryKey: ['runtime-environments'],
  queryFn: api.runtimeEnvironments,
});

export function runtimeEnvironmentQuery(id: string) {
  return queryOptions<RuntimeEnvironment>({
    queryKey: ['runtime-environments', id],
    queryFn: () => api.runtimeEnvironment(id),
  });
}

/** 只在使用中版本离开终态后继续轮询；全部结束就停止。 */
export function buildShouldPoll(
  versions: Array<Pick<RuntimeEnvironmentVersionSummary, 'status'>> | undefined,
): boolean {
  return (
    versions?.some((version) => version.status === 'queued' || version.status === 'building') ??
    false
  );
}

export function runtimeEnvironmentVersionsQuery(id: string) {
  return queryOptions<RuntimeEnvironmentVersionSummary[]>({
    queryKey: ['runtime-environments', id, 'versions'],
    queryFn: () => api.runtimeEnvironmentVersions(id),
    refetchInterval: (query) => (buildShouldPoll(query.state.data) ? 2_000 : false),
  });
}

export function runtimeEnvironmentVersionQuery(id: string, versionId: string) {
  return queryOptions<RuntimeEnvironmentVersion>({
    queryKey: ['runtime-environments', id, 'versions', versionId],
    queryFn: () => api.runtimeEnvironmentVersion(id, versionId),
    enabled: Boolean(versionId),
    refetchInterval: (query) =>
      buildShouldPoll(query.state.data ? [query.state.data] : undefined) ? 2_000 : false,
  });
}

export function useRuntimeEnvironments(enabled = true) {
  return useQuery({ ...runtimeEnvironmentsQuery, enabled });
}

export function useRuntimeEnvironment(id: string) {
  return useQuery(runtimeEnvironmentQuery(id));
}

export function useRuntimeEnvironmentVersions(id: string) {
  return useQuery(runtimeEnvironmentVersionsQuery(id));
}

export function useRuntimeEnvironmentVersion(id: string, versionId: string) {
  return useQuery(runtimeEnvironmentVersionQuery(id, versionId));
}

export function useCreateRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createRuntimeEnvironment,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function useUpdateRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Parameters<typeof api.updateRuntimeEnvironment>[1] }) =>
      api.updateRuntimeEnvironment(vars.id, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function useDeleteRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRuntimeEnvironment(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function useBuildRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.buildRuntimeEnvironment,
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}

export function usePublishRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; versionId: string }) =>
      api.publishRuntimeEnvironment(vars.id, vars.versionId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['runtime-environments'] }),
  });
}
