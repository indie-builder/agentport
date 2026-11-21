import type {
  MarketInstallInput,
  MarketView,
  SkillInput,
  SkillWithAgentCount,
} from '@agentport/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '../api.js';
import { toast, toastError, toastSuccess } from '../toast.js';
import { useDebouncedValue } from '../use-debounced-value.js';
import { AGENT_OPTIONS_QUERY_KEY, AGENTS_QUERY_KEY } from './agents.js';

const skillsQuery = queryOptions<SkillWithAgentCount[]>({
  queryKey: ['skills'],
  queryFn: () => api.skills(),
});

export function useSkillDraftFromRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => api.skillDraftFromRun(runId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useSkills(enabled = true) {
  return useQuery({ ...skillsQuery, enabled });
}

export function useCreateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SkillInput) => api.createSkill(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useImportSkillFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.importSkillFile(content),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
  });
}

export function useMarketSkills(view: MarketView, query: string) {
  const settled = useDebouncedValue(query.trim(), 300);
  const result = useQuery({
    queryKey: ['market-skills', view, settled],
    queryFn: ({ signal }) =>
      api.marketSkills({ view, ...(settled === '' ? {} : { q: settled }) }, signal),
    enabled: settled.length === 0 || settled.length >= 2,
    staleTime: 5 * 60_000,
  });
  return { ...result, isDebouncing: settled !== query.trim() };
}

export function useInstallMarketSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarketInstallInput) => api.installMarketSkill(input),
    onSuccess: ({ skill, warnings }) => {
      toastSuccess(`已安装「${skill.name}」`);
      for (const warning of warnings) toast.info(warning);
      client.setQueryData<SkillWithAgentCount[]>(['skills'], (old) =>
        old ? [{ ...skill, agentCount: 0 }, ...old] : old,
      );
      void client.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: toastError,
  });
}

export function useUpdateSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<SkillInput>; expectedUpdatedAt?: string }) =>
      api.updateSkill(vars.id, vars.input, vars.expectedUpdatedAt),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['skills'] }),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'CONFLICT_STALE') {
        void client.invalidateQueries({ queryKey: ['skills'] });
      }
    },
  });
}

export function useSubmitSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.submitSkill(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
      void client.invalidateQueries({ queryKey: AGENT_OPTIONS_QUERY_KEY });
    },
  });
}

export function useApproveSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.approveSkill(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
      void client.invalidateQueries({ queryKey: AGENT_OPTIONS_QUERY_KEY });
    },
  });
}

export function useRejectSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; note: string }) => api.rejectSkill(vars.id, vars.note),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
      void client.invalidateQueries({ queryKey: AGENT_OPTIONS_QUERY_KEY });
    },
  });
}

export function useDeleteSkill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSkill(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['skills'] });
      void client.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    },
  });
}
