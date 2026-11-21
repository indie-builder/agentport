import type {
  AuthMe,
  PersonalOutputList,
  PersonalOutputShareList,
  PersonalRunList,
  PersonalRunListQuery,
  PersonalSessionList,
  PersonalUsageSummary,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api.js';
import { meQuery, useCursorList } from './shared.js';

export function useUpdatePersonalProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.updatePersonalProfile(input),
    onSuccess: (profile) => {
      client.setQueryData<AuthMe>(meQuery.queryKey, (current) =>
        current?.authenticated
          ? { ...current, user: { ...current.user, name: profile.name } }
          : current,
      );
      void client.invalidateQueries({ queryKey: meQuery.queryKey });
    },
  });
}

const personalSessionsQuery = queryOptions<PersonalSessionList>({
  queryKey: ['me-sessions'],
  queryFn: ({ signal }) => api.meSessions(signal),
  staleTime: 0,
  retry: (count, error) => !(error instanceof ApiError && error.status === 403) && count < 1,
});

export function usePersonalSessions(enabled = true) {
  return useQuery({ ...personalSessionsQuery, enabled });
}

export function useRevokePersonalSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokeMeSession(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: personalSessionsQuery.queryKey }),
  });
}

export function usePersonalOutputShares(cursor: string | null, enabled = true) {
  return useQuery<PersonalOutputShareList>({
    queryKey: ['personal-output-shares', cursor],
    queryFn: ({ signal }) => api.personalOutputShares(cursor === null ? {} : { cursor }, signal),
    enabled,
    staleTime: 0,
  });
}

export function useRevokePersonalOutputShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.revokePersonalOutputShare(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['personal-output-shares'] }),
  });
}

export function usePersonalUsage(days: number, enabled = true) {
  return useQuery<PersonalUsageSummary>({
    queryKey: ['personal-usage', days],
    queryFn: ({ signal }) => api.personalUsage(days, signal),
    enabled,
    staleTime: 15_000,
  });
}

export function usePersonalRuns(query: PersonalRunListQuery, enabled = true) {
  return useQuery<PersonalRunList>({
    queryKey: [
      'personal-runs',
      query.days,
      query.agentId ?? null,
      query.status ?? null,
      query.trigger ?? null,
      query.cursor ?? null,
    ],
    queryFn: ({ signal }) => api.personalRuns(query, signal),
    enabled,
    staleTime: 5_000,
  });
}

export function usePersonalConversations(agentId: string | null, enabled = true) {
  return useCursorList({
    queryKey: ['personal-conversations', agentId],
    queryFn: (cursor, signal) =>
      api.personalConversations(
        {
          ...(agentId === null ? {} : { agentId }),
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    enabled,
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function usePersonalWorkConversations(enabled = true) {
  return useCursorList({
    queryKey: ['personal-work', 'conversations'],
    queryFn: (cursor, signal) =>
      api.personalConversations({ limit: 50, ...(cursor === undefined ? {} : { cursor }) }, signal),
    enabled,
    staleTime: 0,
    select: (data) => data.pages.flatMap((page) => page.items),
  });
}

export function usePersonalWorkOutputs(enabled = true) {
  return useQuery<PersonalOutputList>({
    queryKey: ['personal-work', 'outputs'],
    queryFn: ({ signal }) => api.personalOutputs({ limit: 50 }, signal),
    enabled,
    staleTime: 0,
  });
}
