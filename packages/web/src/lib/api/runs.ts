import type {
  PublicQuestionResponse,
  PublicRunQuestion,
  RunDetail,
  RunList,
  RunListItem,
  RunStatus,
  Skill,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type { RunDetail, RunList, RunListItem, RunStatus, RunStep } from '@agentport/shared';

export type ApprovalRequestList = ApiOutput<ApiClient['runs']['approvals']>;

export type ApprovalRequest = ApprovalRequestList['items'][number];

export interface RunQuery {
  agentId?: string;
  status?: RunStatus;
  limit?: number;
}

export default {
  runApprovals: (runId: string): Promise<ApprovalRequestList> =>
    rpc.runs.approvals({ params: { id: runId } }),
  approveRun: (runId: string, serverId: string, toolName: string) =>
    rpc.runs.approve({ params: { id: runId }, body: { serverId, toolName } }),
  denyRun: (runId: string, serverId: string, toolName: string) =>
    rpc.runs.deny({ params: { id: runId }, body: { serverId, toolName } }),
  runs: (query: RunQuery = {}): Promise<RunList> => rpc.runs.list({ query }),
  exportRuns: (query: {
    agentId?: string;
    status?: RunStatus;
  }): Promise<{ format: string; exportedAt: string; items: RunListItem[] }> => {
    const params = new URLSearchParams();
    if (query.agentId) params.set('agentId', query.agentId);
    if (query.status) params.set('status', query.status);
    const search = params.size > 0 ? `?${params.toString()}` : '';
    return nativeRequest(`/runs/export${search}`);
  },
  exportRun: (id: string): Promise<Record<string, unknown>> => nativeRequest(`/runs/${id}/export`),
  run: (id: string, signal?: AbortSignal): Promise<RunDetail> =>
    rpc.runs.detail({ params: { id } }, clientOptions(signal)),
  runQuestions: (id: string): Promise<{ items: PublicRunQuestion[] }> =>
    rpc.runs.questions({ params: { id } }),
  respondToQuestion: (
    runId: string,
    requestId: string,
    response: PublicQuestionResponse,
  ): Promise<PublicRunQuestion> =>
    rpc.runs.respondToQuestion({ params: { id: runId, requestId }, body: response }),
  skillDraftFromRun: (runId: string): Promise<Skill> =>
    rpc.runs.skillDraft({ params: { id: runId } }),
};
