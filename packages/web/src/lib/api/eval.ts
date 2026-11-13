import type {
  EvalDataset,
  EvalDatasetImportResult,
  EvalRunExport,
  EvalComparison as SharedEvalComparison,
  EvalRunPage as SharedEvalRunPage,
} from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions, nativeRequest } from './shared.js';

export type EvalRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface EvalCase {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
  createdAt: string;
}

export interface EvalCaseInput {
  agentId: string;
  name: string;
  prompt: string;
  expectation: string;
}

export interface EvalRun {
  id: string;
  agentId: string;
  status: EvalRunStatus;
  total: number;
  passed: number;
  /** worker 崩溃时的原因；正常完成为 null。 */
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type EvalRunPage = SharedEvalRunPage;

export interface EvalResult {
  /** 用例或运行被清理后置空，历史结果仍然保留。 */
  caseId: string | null;
  name: string;
  prompt: string;
  expectation: string;
  passed: boolean;
  output: string;
  runId: string | null;
}

export interface EvalRunDetail {
  evalRun: EvalRun;
  results: EvalResult[];
}

export type EvalComparison = SharedEvalComparison;

export default {
  evalCases: (agentId?: string): Promise<EvalCase[]> =>
    rpc.eval.cases.list({ query: agentId === undefined ? {} : { agentId } }),
  createEvalCase: (input: EvalCaseInput): Promise<EvalCase> =>
    rpc.eval.cases.create({ body: input }),
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
  startEvalRun: (agentId: string): Promise<{ evalRunId: string }> =>
    rpc.eval.runs.create({ body: { agentId } }),
  cancelEvalRun: (id: string): Promise<{ ok: true }> => rpc.eval.runs.cancel({ params: { id } }),
  evalRun: (id: string): Promise<EvalRunDetail> => rpc.eval.runs.detail({ params: { id } }),
  exportEvalRun: (id: string): Promise<EvalRunExport> =>
    nativeRequest(`/eval/runs/${encodeURIComponent(id)}/export`),
  compareEvalRuns: (baseId: string, headId: string): Promise<EvalComparison> =>
    rpc.eval.runs.compare({ params: { id: baseId }, query: { head: headId } }),
};
