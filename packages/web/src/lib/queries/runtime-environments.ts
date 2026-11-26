import type {
  RuntimeEnvironment,
  RuntimeEnvironmentVersion,
  RuntimeEnvironmentVersionSummary,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { useCursorList } from './client.js';

export const runtimeEnvironmentKeys = {
  all: ['runtime-environments'] as const,
  detail: (id: string) => ['runtime-environments', id] as const,
  versions: (id: string) => ['runtime-environments', id, 'versions'] as const,
  version: (id: string, versionId: string) =>
    ['runtime-environments', id, 'versions', versionId] as const,
};

function runtimeEnvironmentQuery(id: string) {
  return queryOptions<RuntimeEnvironment>({
    queryKey: runtimeEnvironmentKeys.detail(id),
    queryFn: () => api.runtimeEnvironment(id),
  });
}

export function buildShouldPoll(
  versions: Array<Pick<RuntimeEnvironmentVersionSummary, 'status'>> | undefined,
): boolean {
  return (
    versions?.some((version) => version.status === 'queued' || version.status === 'building') ??
    false
  );
}

function runtimeEnvironmentVersionsQuery(id: string) {
  return queryOptions<RuntimeEnvironmentVersionSummary[]>({
    queryKey: runtimeEnvironmentKeys.versions(id),
    queryFn: () => api.runtimeEnvironmentVersions(id),
    refetchInterval: (query) => (buildShouldPoll(query.state.data) ? 2_000 : false),
  });
}

function runtimeEnvironmentVersionQuery(id: string, versionId: string) {
  return queryOptions<RuntimeEnvironmentVersion>({
    queryKey: runtimeEnvironmentKeys.version(id, versionId),
    queryFn: () => api.runtimeEnvironmentVersion(id, versionId),
    enabled: Boolean(versionId),
    refetchInterval: (query) =>
      buildShouldPoll(query.state.data ? [query.state.data] : undefined) ? 2_000 : false,
  });
}

export function useRuntimeEnvironments(enabled = true) {
  return useCursorList({
    queryKey: runtimeEnvironmentKeys.all,
    queryFn: (cursor, signal) => api.runtimeEnvironments(cursor, signal),
    enabled,
    select: (data) => data.pages.flatMap((page) => page.items ?? []),
  });
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
    onSuccess: () => void client.invalidateQueries({ queryKey: runtimeEnvironmentKeys.all }),
  });
}

export function useUpdateRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Parameters<typeof api.updateRuntimeEnvironment>[1] }) =>
      api.updateRuntimeEnvironment(vars.id, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: runtimeEnvironmentKeys.all }),
  });
}

export function useDeleteRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteRuntimeEnvironment(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: runtimeEnvironmentKeys.all }),
  });
}

export function useBuildRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.buildRuntimeEnvironment,
    onSuccess: () => void client.invalidateQueries({ queryKey: runtimeEnvironmentKeys.all }),
  });
}

export function usePublishRuntimeEnvironment() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; versionId: string }) =>
      api.publishRuntimeEnvironment(vars.id, vars.versionId),
    onSuccess: () => void client.invalidateQueries({ queryKey: runtimeEnvironmentKeys.all }),
  });
}
