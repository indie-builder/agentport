import type {
  CursorPage,
  RetentionSettings,
  RetentionUpdate,
  Schedule,
  ScheduleInput,
  SchedulePatch,
  ScheduleRun,
} from '@agentport/shared';
import {
  type InfiniteData,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  api,
  type HealthLive,
  type HealthMetrics,
  type HealthProbe,
  type HealthReady,
} from '../api.js';
import { useCursorList } from './client.js';

export const opsKeys = {
  healthMetrics: ['health-metrics'] as const,
  healthLive: ['health-live'] as const,
  healthReady: ['health-ready'] as const,
  schedules: ['schedules'] as const,
  scheduleRuns: (id: string) => ['schedules', id, 'runs'] as const,
  retention: ['retention'] as const,
};

export const healthMetricsQuery = queryOptions<HealthMetrics>({
  queryKey: opsKeys.healthMetrics,
  // 失败时抛错而不是回退 null，React Query 才会保留上次成功读数。
  queryFn: async () => {
    const data = await api.healthMetrics();
    if (!data) throw new Error('指标端点不可达或返回非 200');
    return data;
  },
  refetchInterval: 30_000,
  staleTime: 0,
});

export const healthLiveQuery = queryOptions<HealthProbe<HealthLive>>({
  queryKey: opsKeys.healthLive,
  queryFn: api.healthLive,
  refetchInterval: 10_000,
  staleTime: 0,
});

export const healthReadyQuery = queryOptions<HealthProbe<HealthReady>>({
  queryKey: opsKeys.healthReady,
  queryFn: api.healthReady,
  refetchInterval: 10_000,
  staleTime: 0,
});

const SCHEDULES_PAGE_SIZE = 50;

export function useSchedules() {
  return useCursorList({
    queryKey: opsKeys.schedules,
    queryFn: (cursor, signal) =>
      api.schedules(
        {
          limit: SCHEDULES_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
  });
}

export const scheduleRunsQuery = (id: string) =>
  queryOptions<ScheduleRun[]>({
    queryKey: opsKeys.scheduleRuns(id),
    queryFn: () => api.scheduleRuns(id),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'queued' || run.status === 'running')
        ? 2_000
        : 5_000,
  });

export function useScheduleRuns(id: string, enabled = true) {
  return useQuery({ ...scheduleRunsQuery(id), enabled });
}

const retentionQuery = queryOptions<RetentionSettings>({
  queryKey: opsKeys.retention,
  queryFn: api.retention,
});

export function useRetention() {
  return useQuery(retentionQuery);
}

export function useUpdateRetention() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: RetentionUpdate) => api.updateRetention(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: retentionQuery.queryKey });
    },
  });
}

export function useToggleSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.updateSchedule(id, { enabled }),
    onMutate: async (vars) => {
      await client.cancelQueries({ queryKey: opsKeys.schedules });
      const prev = client.getQueryData<InfiniteData<CursorPage<Schedule>>>(opsKeys.schedules);
      if (prev) {
        client.setQueryData<InfiniteData<CursorPage<Schedule>>>(opsKeys.schedules, (old) =>
          old
            ? {
                ...old,
                pages: old.pages.map((page) => ({
                  ...page,
                  items: page.items.map((s) =>
                    s.id === vars.id ? { ...s, enabled: vars.enabled } : s,
                  ),
                })),
              }
            : old,
        );
      }
      return { prev };
    },
    onError: (_error, _vars, ctx) => {
      if (ctx?.prev !== undefined) {
        client.setQueryData<InfiniteData<CursorPage<Schedule>>>(opsKeys.schedules, ctx.prev);
      }
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: opsKeys.schedules });
    },
  });
}

export function useCreateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ScheduleInput) => api.createSchedule(input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: opsKeys.schedules });
    },
  });
}

export function useUpdateSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: SchedulePatch }) =>
      api.updateSchedule(vars.id, vars.input),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: opsKeys.schedules });
    },
  });
}

export function useDeleteSchedule() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSchedule(id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: opsKeys.schedules });
    },
  });
}

export function useRetryScheduleRun(scheduleId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.retryScheduleRun(scheduleId, runId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: scheduleRunsQuery(scheduleId).queryKey });
      void client.invalidateQueries({ queryKey: opsKeys.schedules });
    },
  });
}
