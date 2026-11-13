import { queryOptions } from '@tanstack/react-query';
import {
  api,
  type HealthLive,
  type HealthMetrics,
  type HealthProbe,
  type HealthReady,
} from '../api.js';

export const healthMetricsQuery = queryOptions<HealthMetrics>({
  queryKey: ['health-metrics'],
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
  queryKey: ['health-live'],
  queryFn: api.healthLive,
  refetchInterval: 10_000,
  staleTime: 0,
});

export const healthReadyQuery = queryOptions<HealthProbe<HealthReady>>({
  queryKey: ['health-ready'],
  queryFn: api.healthReady,
  refetchInterval: 10_000,
  staleTime: 0,
});
