import type {
  PublicQuestionResponse,
  PublicRunQuestion,
  RunDetail,
  RunFeedback,
  RunFeedbackList,
  RunList,
  RunListItem,
  RunStatus,
  RunTrigger,
  Skill,
  SubmitRunFeedback,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type {
  RunDetail,
  RunFeedback,
  RunFeedbackList,
  RunList,
  RunListItem,
  RunStatus,
  RunStep,
  SubmitRunFeedback,
} from '@agentport/shared';

export type ApprovalRequestList = ApiOutput<ApiClient['runs']['approvals']>;

export type ApprovalRequest = ApprovalRequestList['items'][number];

export interface RunQuery {
  agentId?: string;
  status?: RunStatus;
  trigger?: RunTrigger;
  since?: string;
  limit?: number;
}

export default {
  runApprovals: (runId: string): Promise<ApprovalRequestList> =>
    rpc.runs.approvals({ params: { id: runId } }),
  approveRun: (runId: string, approvalId: string) =>
    rpc.runs.approve({ params: { id: runId }, body: { approvalId } }),
  denyRun: (runId: string, approvalId: string) =>
    rpc.runs.deny({ params: { id: runId }, body: { approvalId } }),
  runs: (query: RunQuery = {}): Promise<RunList> => rpc.runs.list({ query }),
  exportRuns: (query: {
    agentId?: string;
    status?: RunStatus;
    trigger?: RunTrigger;
    since?: string;
  }): Promise<{ format: string; exportedAt: string; items: RunListItem[] }> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    if (query.trigger) params.set('trigger', query.trigger);
    if (query.since) params.set('since', query.since);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return nativeRequest(`/runs/export${search}`);
  },
  exportRun: (id: string): Promise<Record<string, unknown>> => nativeRequest(`/runs/${id}/export`),
  run: (id: string, signal?: AbortSignal): Promise<RunDetail> =>
    rpc.runs.detail({ params: { id } }, clientOptions(signal)),
  runQuestions: (id: string): Promise<{ items: PublicRunQuestion[] }> =>
    rpc.runs.questions({ params: { id } }),
  runFeedback: (runId: string): Promise<RunFeedbackList> =>
    rpc.runs.feedback({ params: { id: runId } }),
  submitRunFeedback: (runId: string, input: SubmitRunFeedback): Promise<RunFeedback> =>
    rpc.runs.submitFeedback({ params: { id: runId }, body: input }),
  respondToQuestion: (
    runId: string,
    requestId: string,
    response: PublicQuestionResponse,
  ): Promise<PublicRunQuestion> =>
    rpc.runs.respondToQuestion({ params: { id: runId, requestId }, body: response }),
  skillDraftFromRun: (runId: string): Promise<Skill> =>
    rpc.runs.skillDraft({ params: { id: runId } }),
};
