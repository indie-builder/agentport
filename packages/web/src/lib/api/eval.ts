import type {
  EvalComparison,
  EvalDataset,
  EvalDatasetImportResult,
  EvalRunExport,
  EvalRunPage,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type { EvalComparison, EvalRun, EvalRunPage, EvalRunStatus } from '@agentport/shared';

export type EvalTarget = NonNullable<
  Parameters<ApiClient['eval']['runs']['create']>[0]['body']['target']
>;

type EvalCasePage = ApiOutput<ApiClient['eval']['cases']['list']>;

export type EvalCase = EvalCasePage['items'][number];

export type EvalCaseInput = Parameters<ApiClient['eval']['cases']['create']>[0]['body'];

export type EvalCaseFromRunInput = Parameters<ApiClient['eval']['cases']['fromRun']>[0]['body'];

export type EvalSampleCandidate = ApiOutput<ApiClient['eval']['cases']['sampleCandidates']>[number];

export type EvalRunDetail = ApiOutput<ApiClient['eval']['runs']['detail']>;

export type EvalResult = EvalRunDetail['results'][number];

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
