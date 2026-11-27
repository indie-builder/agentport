import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { knowledgeKeys } from './knowledge-shared.js';

export function useKnowledgeModelProfiles() {
  return useQuery({
    queryKey: knowledgeKeys.profiles,
    queryFn: () => api.knowledgeModelProfiles(),
    staleTime: 60_000,
  });
}

export function useKnowledgeModelProfileSelections() {
  return useQuery({
    queryKey: knowledgeKeys.profileSelections,
    queryFn: () => api.knowledgeModelProfileSelections(),
    staleTime: 60_000,
  });
}

export function useCreateKnowledgeModelProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createKnowledgeModelProfile>[0]) =>
      api.createKnowledgeModelProfile(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.profiles }),
  });
}

export function useUpdateKnowledgeModelProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: string;
      patch: Parameters<typeof api.updateKnowledgeModelProfile>[1];
    }) => api.updateKnowledgeModelProfile(vars.id, vars.patch),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useDeleteKnowledgeModelProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteKnowledgeModelProfile(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.all }),
  });
}

export function useTestKnowledgeModelProfile() {
  return useMutation({
    mutationFn: (id: string) => api.testKnowledgeModelProfile(id),
  });
}
