import type { ObservabilitySnapshot, SloSettings } from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';

export const observabilityKeys = {
  all: ['observability'] as const,
  snapshot: (windowMinutes: number) => ['observability', 'snapshot', windowMinutes] as const,
  slo: ['observability', 'slo'] as const,
};

const observabilitySnapshotQuery = (windowMinutes: number) =>
  queryOptions<ObservabilitySnapshot>({
    queryKey: observabilityKeys.snapshot(windowMinutes),
    queryFn: () => api.observabilitySnapshot(windowMinutes),
    staleTime: 15_000,
  });

const sloSettingsQuery = queryOptions<SloSettings>({
  queryKey: observabilityKeys.slo,
  queryFn: () => api.sloSettings(),
  staleTime: 0,
});

export function useObservabilitySnapshot(windowMinutes: number) {
  return useQuery(observabilitySnapshotQuery(windowMinutes));
}

export function useSloSettings() {
  return useQuery(sloSettingsQuery);
}

export function useUpdateSloSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SloSettings) => api.updateSloSettings(input),
    onSuccess: (settings) => {
      client.setQueryData(sloSettingsQuery.queryKey, settings);
      void client.invalidateQueries({ queryKey: observabilityKeys.all });
    },
  });
}
