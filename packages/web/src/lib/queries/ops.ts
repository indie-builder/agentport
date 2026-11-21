import type { RetentionSettings, RetentionUpdate, ScheduleRun } from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type HealthLive,
  type HealthMetrics,
  type HealthProbe,
  type HealthReady,
} from '../api.js';
import { useCursorList } from './shared.js';

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
