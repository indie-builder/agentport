import type {
  CursorPage,
  EvalDataset,
  EvalDatasetImportResult,
  EvalRunExport,
  EvalComparison as SharedEvalComparison,
  EvalJudgeMode as SharedEvalJudgeMode,
  EvalRunPage as SharedEvalRunPage,
  EvalRunStatus as SharedEvalRunStatus,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type EvalRunStatus = SharedEvalRunStatus;

export type EvalTarget = 'published' | 'draft';

type EvalJudgeMode = SharedEvalJudgeMode;

export interface EvalCase {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
  judgeMode: EvalJudgeMode;
  expectedTools: string[] | null;
  forbiddenTools: string[] | null;
  createdAt: string;
}

export type EvalCasePage = CursorPage<EvalCase>;

export interface EvalCaseInput {
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
  judgeMode: EvalJudgeMode;
  expectedTools?: string[];
  forbiddenTools?: string[];
}

export interface EvalCaseFromRunInput {
  runId: string;
  name?: string;
  expectation: string;
  judgeMode: EvalJudgeMode;
  confirmed: true;
  feedbackId?: string;
}

export type EvalSampleCandidate = ApiOutput<ApiClient['eval']['cases']['sampleCandidates']>[number];

export interface EvalRun {
  id: string;
  agentId: string;
  status: EvalRunStatus;
  total: number;
  passed: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type EvalRunPage = SharedEvalRunPage;

export type EvalResult = ApiOutput<ApiClient['eval']['runs']['detail']>['results'][number];

export interface EvalRunDetail {
  evalRun: EvalRun;
  results: EvalResult[];
}

export type EvalComparison = SharedEvalComparison;

export default {
  evalCases: (
    query: { agentId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<EvalCasePage> => rpc.eval.cases.list({ query }, clientOptions(signal)),
  createEvalCase: (input: EvalCaseInput): Promise<EvalCase> =>
    rpc.eval.cases.create({ body: input }),
  createEvalCaseFromRun: (input: EvalCaseFromRunInput): Promise<EvalCase> =>
    rpc.eval.cases.fromRun({ body: input }),
  sampleEvalCandidates: (input: {
    agentId: string;
    limit?: number;
  }): Promise<EvalSampleCandidate[]> =>
    rpc.eval.cases.sampleCandidates({
      query: {
        agentId: input.agentId,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      },
    }),
  updateEvalCase: (id: string, input: Partial<Omit<EvalCaseInput, 'agentId'>>): Promise<EvalCase> =>
    rpc.eval.cases.update({ params: { id }, body: input }),
  deleteEvalCase: (id: string): Promise<void> => rpc.eval.cases.remove({ params: { id } }),
  exportEvalDataset: (agentId: string): Promise<EvalDataset> =>
    nativeRequest(`/eval/cases/export?agentId=${encodeURIComponent(agentId)}`),
  importEvalDataset: (agentId: string, dataset: EvalDataset): Promise<EvalDatasetImportResult> =>
    rpc.eval.cases.import({ body: { agentId, dataset } }),
  evalRuns: (
    query: { agentId?: string; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<EvalRunPage> => rpc.eval.runs.list({ query }, clientOptions(signal)),
  startEvalRun: (
    agentId: string,
    target: EvalTarget = 'published',
  ): Promise<{ evalRunId: string }> => rpc.eval.runs.create({ body: { agentId, target } }),
  cancelEvalRun: (id: string): Promise<{ ok: true }> => rpc.eval.runs.cancel({ params: { id } }),
  evalRun: (id: string): Promise<EvalRunDetail> => rpc.eval.runs.detail({ params: { id } }),
  exportEvalRun: (id: string): Promise<EvalRunExport> =>
    nativeRequest(`/eval/runs/${encodeURIComponent(id)}/export`),
  compareEvalRuns: (baseId: string, headId: string): Promise<EvalComparison> =>
    rpc.eval.runs.compare({ params: { id: baseId }, query: { head: headId } }),
};
