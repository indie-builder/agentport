import type { EvalDataset } from '@agentport/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  type EvalCaseFromRunInput,
  type EvalCaseInput,
  type EvalComparison,
  type EvalRunDetail,
  type EvalSampleCandidate,
  type EvalTarget,
} from '../api.js';
import { useCursorList } from './client.js';
import { runKeys } from './runs.js';

const EVAL_CASES_PAGE_SIZE = 50;
const EVAL_RUNS_PAGE_SIZE = 50;

const evalKeys = {
  cases: (agentId: string | null) => ['eval-cases', agentId, EVAL_CASES_PAGE_SIZE] as const,
  casesAll: ['eval-cases'] as const,
  casesByAgent: (agentId: string) => ['eval-cases', agentId] as const,
  samples: (agentId: string) => ['eval-samples', agentId] as const,
  runs: (agentId: string | null) => ['eval-runs', agentId, EVAL_RUNS_PAGE_SIZE] as const,
  runsAll: ['eval-runs'] as const,
  run: (id: string | null) => ['eval-run', id] as const,
  runAll: ['eval-run'] as const,
  comparison: (baseId: string | null, headId: string | null) =>
    ['eval-comparison', baseId, headId] as const,
};

export function useEvalCases(agentId: string | null) {
  return useCursorList({
    queryKey: evalKeys.cases(agentId),
    queryFn: (cursor, signal) =>
      api.evalCases(
        {
          ...(agentId === null ? {} : { agentId }),
          limit: EVAL_CASES_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    enabled: agentId !== null,
    staleTime: 0,
  });
}

export function useCreateEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EvalCaseInput) => api.createEvalCase(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: evalKeys.casesAll }),
  });
}

export function useCreateEvalCaseFromRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EvalCaseFromRunInput) => api.createEvalCaseFromRun(input),
    onSuccess: async (created, input) => {
      const candidatesKey = evalKeys.samples(created.agentId);
      await client.cancelQueries({ queryKey: candidatesKey });
      client.setQueryData<EvalSampleCandidate[]>(candidatesKey, (old) =>
        old?.filter((candidate) => candidate.runId !== input.runId),
      );
      void client.invalidateQueries({ queryKey: candidatesKey });
      void client.invalidateQueries({ queryKey: evalKeys.casesAll });
      void client.invalidateQueries({ queryKey: runKeys.feedbackAll });
    },
  });
}

export function useSampleEvalCandidates(agentId: string) {
  return useQuery<EvalSampleCandidate[]>({
    queryKey: evalKeys.samples(agentId),
    queryFn: () => api.sampleEvalCandidates({ agentId }),
    enabled: Boolean(agentId),
    staleTime: 0,
  });
}

export function useImportEvalDataset() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { agentId: string; dataset: EvalDataset }) =>
      api.importEvalDataset(input.agentId, input.dataset),
    onSuccess: (_result, input) =>
      void client.invalidateQueries({ queryKey: evalKeys.casesByAgent(input.agentId) }),
  });
}

export function useUpdateEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: Partial<Omit<EvalCaseInput, 'agentId'>> }) =>
      api.updateEvalCase(vars.id, vars.input),
    onSuccess: () => void client.invalidateQueries({ queryKey: evalKeys.casesAll }),
  });
}

export function useDeleteEvalCase() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEvalCase(id),
    onSuccess: () => void client.invalidateQueries({ queryKey: evalKeys.casesAll }),
  });
}

export function useEvalRuns(agentId: string | null) {
  return useCursorList({
    queryKey: evalKeys.runs(agentId),
    queryFn: (cursor, signal) =>
      api.evalRuns(
        {
          ...(agentId === null ? {} : { agentId }),
          limit: EVAL_RUNS_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        },
        signal,
      ),
    enabled: agentId !== null,
    refetchInterval: (query) => {
      const runs = query.state.data?.pages.flatMap((page) => page.items);
      return runs?.some((run) => run.status === 'running') ? 3_000 : false;
    },
  });
}

export function useStartEvalRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { agentId: string; target?: EvalTarget }) =>
      api.startEvalRun(vars.agentId, vars.target),
    onSuccess: () => void client.invalidateQueries({ queryKey: evalKeys.runsAll }),
  });
}

export function useCancelEvalRun() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.cancelEvalRun(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: evalKeys.runsAll });
      void client.invalidateQueries({ queryKey: evalKeys.runAll });
    },
  });
}

export function useEvalRun(id: string | null) {
  return useQuery<EvalRunDetail>({
    queryKey: evalKeys.run(id),
    queryFn: () => api.evalRun(id ?? ''),
    enabled: id !== null,
    refetchInterval: (query) => (query.state.data?.evalRun.status === 'running' ? 2_000 : false),
  });
}

export function useEvalComparison(baseId: string | null, headId: string | null) {
  return useQuery<EvalComparison>({
    queryKey: evalKeys.comparison(baseId, headId),
    queryFn: () => api.compareEvalRuns(baseId ?? '', headId ?? ''),
    enabled: baseId !== null && headId !== null && baseId !== headId,
  });
}
