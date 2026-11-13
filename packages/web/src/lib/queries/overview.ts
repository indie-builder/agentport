import type { Attention, Schedule } from '@agentport/shared';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api, type Overview, type OverviewTimeseriesPoint } from '../api.js';

export const overviewQuery = queryOptions<Overview>({
  queryKey: ['overview'],
  queryFn: api.overview,
  staleTime: 15_000,
});

export const overviewTimeseriesQuery = (days = 7) =>
  queryOptions<OverviewTimeseriesPoint[]>({
    queryKey: ['overview', 'timeseries', days],
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

export function useOverview() {
  return useQuery(overviewQuery);
}

export function useOverviewTimeseries(days = 7) {
  return useQuery(overviewTimeseriesQuery(days));
}
