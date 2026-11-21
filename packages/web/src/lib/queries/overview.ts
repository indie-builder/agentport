import type { Attention, Schedule, ScheduleRun } from '@agentport/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, type Overview, type OverviewTimeseriesPoint } from '../api.js';

export const OVERVIEW_QUERY_KEY = ['overview'] as const;

export const overviewQuery = queryOptions<Overview>({
  queryKey: OVERVIEW_QUERY_KEY,
  queryFn: api.overview,
  staleTime: 15_000,
});

export const overviewTimeseriesQuery = (days = 7) =>
  queryOptions<OverviewTimeseriesPoint[]>({
    queryKey: [...OVERVIEW_QUERY_KEY, 'timeseries', days],
    queryFn: () => api.overviewTimeseries(days),
    staleTime: 15_000,
  });

export const attentionQuery = queryOptions<Attention>({
  queryKey: ['attention'],
  queryFn: api.attention,
  refetchInterval: 15_000,
});

export const schedulesQuery = queryOptions<Schedule[]>({
  queryKey: ['schedules'],
  queryFn: api.schedules,
});

export function useAttention() {
  return useQuery(attentionQuery);
}

export function useSchedules() {
  return useQuery(schedulesQuery);
}

export const scheduleRunsQuery = (id: string) =>
  queryOptions<ScheduleRun[]>({
    queryKey: ['schedules', id, 'runs'],
    queryFn: () => api.scheduleRuns(id),
    refetchInterval: (query) =>
      query.state.data?.some((run) => run.status === 'queued' || run.status === 'running')
        ? 2_000
        : 5_000,
  });

export function useScheduleRuns(id: string, enabled = true) {
  return useQuery({ ...scheduleRunsQuery(id), enabled });
}

export function useOverview() {
  return useQuery(overviewQuery);
}

export function useOverviewTimeseries(days = 7) {
  return useQuery(overviewTimeseriesQuery(days));
}
