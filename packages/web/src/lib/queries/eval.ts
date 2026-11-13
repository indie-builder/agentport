import type { EvalDataset } from '@agentport/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type EvalCase,
  type EvalCaseInput,
  type EvalComparison,
  type EvalRunDetail,
} from '../api.js';

export function useEvalCases(agentId: string | null) {
  return useQuery<EvalCase[]>({
    queryKey: ['eval-cases', agentId],
    queryFn: () => api.evalCases(agentId ?? undefined),
    enabled: agentId !== null,
    staleTime: 0,
  });
}

export function useCreateEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EvalCaseInput) => api.createEvalCase(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-cases'] }),
  });
}

export function useImportEvalDataset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; dataset: EvalDataset }) =>
      api.importEvalDataset(input.agentId, input.dataset),
    onSuccess: (_result, input) =>
      void client.invalidateQueries({ queryKey: ['eval-cases', input.agentId] }),
  });
}

export function useUpdateEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<Omit<EvalCaseInput, 'agentId'>> }) =>
      api.updateEvalCase(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-cases'] }),
  });
}

export function useDeleteEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEvalCase(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-cases'] }),
  });
}

const EVAL_RUNS_PAGE_SIZE = 50;

export function useEvalRuns(agentId: string | null) {
  return useInfiniteQuery({
    queryKey: ['eval-runs', agentId, EVAL_RUNS_PAGE_SIZE],
    queryFn: ({ pageParam, signal }) =>
      api.evalRuns(
        {
          ...(agentId === null ? {} : { agentId }),
          limit: EVAL_RUNS_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: agentId !== null,
    // 跑批在后台进行，已加载的列表里有 running 时轮询。
    refetchInterval: (query) => {
      const runs = query.state.data?.pages.flatMap((page) => page.items);
      return runs?.some((run) => run.status === 'running') ? 3_000 : false;
    },
  });
}

export function useStartEvalRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.startEvalRun(agentId),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['eval-runs'] }),
  });
}

export function useCancelEvalRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelEvalRun(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['eval-runs'] });
      void client.invalidateQueries({ queryKey: ['eval-run'] });
    },
  });
}

export function useEvalRun(id: string | null) {
  return useQuery<EvalRunDetail>({
    queryKey: ['eval-run', id],
    queryFn: () => api.evalRun(id ?? ''),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.evalRun.status === 'running' ? 2_000 : false),
  });
}

export function useEvalComparison(baseId: string | null, headId: string | null) {
  return useQuery<EvalComparison>({
    queryKey: ['eval-comparison', baseId, headId],
    queryFn: () => api.compareEvalRuns(baseId ?? '', headId ?? ''),
    enabled: baseId !== null && headId !== null && baseId !== headId,
  });
}
