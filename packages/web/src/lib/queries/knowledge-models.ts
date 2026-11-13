import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import { knowledgeKeys } from './shared.js';

export function useKnowledgeModelProfiles() {
  return useQuery({
    queryKey: knowledgeKeys.profiles,
    queryFn: () => api.knowledgeModelProfiles(),
    staleTime: 60_000,
  });
}

/** 创建/设置页只需要选择项；这个视图对 knowledge.read 开放，不要求管理权限。 */
export function useKnowledgeModelProfileSelections() {
  return useQuery({
    queryKey: knowledgeKeys.profileSelections,
    queryFn: () => api.knowledgeModelProfileSelections(),
    staleTime: 60_000,
  });
}

/** 知识库必须绑定 embedding profile；首次使用时在新建弹层里就地创建。 */
export function useCreateKnowledgeModelProfile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof api.createKnowledgeModelProfile>[0]) =>
      api.createKnowledgeModelProfile(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: knowledgeKeys.profiles }),
  });
}
