import type { ModelProvider, ModelProviderCreate, ModelProviderUpdate } from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { observabilityKeys } from './observability.js';

const modelProviderKeys = {
  all: ['model-providers'] as const,
};

const modelProvidersQuery = queryOptions<ModelProvider[]>({
  queryKey: modelProviderKeys.all,
  queryFn: () => api.modelProviders(),
  staleTime: 0,
});

export function useModelProviders() {
  return useQuery(modelProvidersQuery);
}

export function useCreateModelProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ModelProviderCreate) => api.createModelProvider(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: modelProviderKeys.all });
      void client.invalidateQueries({ queryKey: observabilityKeys.all });
    },
  });
}

export function useUpdateModelProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: ModelProviderUpdate }) =>
      api.updateModelProvider(vars.id, vars.input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: modelProviderKeys.all });
      void client.invalidateQueries({ queryKey: observabilityKeys.all });
    },
  });
}

export function useDeleteModelProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteModelProvider(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: modelProviderKeys.all });
      void client.invalidateQueries({ queryKey: observabilityKeys.all });
    },
  });
}

export function useTestModelProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.testModelProvider(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: modelProviderKeys.all });
      void client.invalidateQueries({ queryKey: observabilityKeys.all });
    },
  });
}
