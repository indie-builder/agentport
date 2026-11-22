import type {
  AgentMemoryAssembly,
  AgentMemoryOverview,
  CreateMemoryReviewInput,
  MemoryChange,
  MemoryFileContent,
  MemoryFileList,
  MemoryPolicy,
  MemoryReview,
  PersonalMemory,
  WritePersonalMemoryInput,
} from '@agentport/shared';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions } from './shared.js';

type PersonalMemoryWriteResult = ApiOutput<ApiClient['memory']['writePersonal']>;

type MemoryChangeList = ApiOutput<ApiClient['memory']['agentFileVersions']>;

type MemoryReviewQuery = Omit<
  Parameters<ApiClient['memoryReviews']['list']>[0]['query'],
  'limit'
> & { limit?: number };

type MemoryReviewList = ApiOutput<ApiClient['memoryReviews']['list']>;

export default {
  agentMemory: (id: string): Promise<MemoryFileList> => rpc.agents.memory({ params: { id } }),
  agentMemoryDownloadUrl: (id: string): string => `/api/agents/${id}/memory/download`,
  agentMemoryVersions: (
    id: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<MemoryChangeList> =>
    rpc.memory.agentFileVersions({ params: { id, name }, query: {} }, clientOptions(signal)),
  agentRuleVersions: (id: string, slug: string, signal?: AbortSignal): Promise<MemoryChangeList> =>
    rpc.memory.agentRuleVersions({ params: { id, slug }, query: {} }, clientOptions(signal)),
  agentMemoryFile: (id: string, name: string): Promise<MemoryFileContent> =>
    rpc.agents.memoryFile({ params: { id, name } }),
  agentMemoryOverview: (id: string): Promise<AgentMemoryOverview> =>
    rpc.memory.agentMemoryOverview({ params: { id } }),
  agentMemoryAssembly: (id: string): Promise<AgentMemoryAssembly> =>
    rpc.memory.agentMemoryAssembly({ params: { id } }),
  updateAgentMemoryPolicy: (id: string, policy: MemoryPolicy): Promise<{ policy: MemoryPolicy }> =>
    rpc.memory.updateAgentMemoryPolicy({ params: { id }, body: { policy } }),
  writeAgentMemoryFile: (id: string, name: string, content: string): Promise<MemoryFileContent> =>
    rpc.agents.writeMemory({ params: { id, name }, body: { content } }),
  deleteAgentMemoryFile: (id: string, name: string): Promise<void> =>
    rpc.agents.deleteMemory({ params: { id, name } }),
  personalMemory: (): Promise<PersonalMemory> => rpc.memory.readPersonal(),
  writePersonalMemory: (input: WritePersonalMemoryInput): Promise<PersonalMemoryWriteResult> =>
    rpc.memory.writePersonal({ body: input }),
  personalMemoryDownloadUrl: '/api/me/memory/download',
  personalMemoryVersions: (
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<MemoryChangeList> => rpc.memory.personalVersions({ query }, clientOptions(signal)),
  rollbackMemoryChange: (id: string): Promise<MemoryChange> =>
    rpc.memory.rollback({ params: { id } }),
  memoryReviews: (query: MemoryReviewQuery = {}, signal?: AbortSignal): Promise<MemoryReviewList> =>
    rpc.memoryReviews.list({ query }, clientOptions(signal)),
  createMemoryReview: (
    input: CreateMemoryReviewInput,
    idempotencyKey: string,
    scope?: 'own',
  ): Promise<{ runId: string }> =>
    rpc.memoryReviews.create({
      headers: { 'idempotency-key': idempotencyKey },
      query: { ...(scope === undefined ? {} : { scope }) },
      body: input,
    }),
  memoryReview: (runId: string, signal?: AbortSignal): Promise<MemoryReview> =>
    rpc.memoryReviews.detail({ params: { runId } }, clientOptions(signal)),
  applyMemoryReview: (runId: string): Promise<MemoryChange> =>
    rpc.memoryReviews.apply({ params: { runId } }),
  rejectMemoryReview: (runId: string): Promise<MemoryReview> =>
    rpc.memoryReviews.decide({ params: { runId }, body: { decision: 'rejected' } }),
};
