import type {
  AuthMe,
  ConversationSummary,
  PersonalOutputShareList,
  PersonalRunList,
  PersonalRunListQuery,
  PersonalSessionList,
  PersonalUsageSummary,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api.js';
import { meQuery } from './shared.js';

// ---- 个人模块：资料、登录会话、分享与使用记录 -------------------------------

/** 姓名保存成功后直接改 me 缓存，侧栏无需等一次刷新。 */
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

export const personalSessionsQuery = queryOptions<PersonalSessionList>({
  queryKey: ['me-sessions'],
  queryFn: ({ signal }) => api.meSessions(signal),
  staleTime: 0,
  // 鲜度不足是稳定 403，重试没有意义；页面提供重新登录动作。
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

/** 回顾来源固定本人；不用全局会话列表在浏览器里过滤。 */
export function usePersonalConversations(agentId: string | null, enabled = true) {
  return useQuery<ConversationSummary[]>({
    queryKey: ['personal-conversations', agentId],
    queryFn: ({ signal }) => api.personalConversations(agentId === null ? {} : { agentId }, signal),
    enabled,
    staleTime: 0,
  });
}
