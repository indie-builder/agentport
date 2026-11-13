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
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';

/** 个人偏好保存结果：多返回本次写入的变更 id，供页面提示。 */
export interface PersonalMemoryWriteResult extends PersonalMemory {
  changeId: string;
}

export interface MemoryChangeList {
  items: MemoryChange[];
}

export interface MemoryReviewQuery {
  agentId?: string;
  conversationId?: string;
  before?: string;
  limit?: number;
}

export interface MemoryReviewList {
  items: MemoryReview[];
}

export default {
  agentMemory: (id: string): Promise<MemoryFileList> => rpc.agents.memory({ params: { id } }),
  /** 原生记忆目录 ZIP；只含 MEMORY.md 与主题 Markdown。 */
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
  /** 整份策略替换：不提供局部 patch。 */
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
    query: { before?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<MemoryChangeList> => rpc.memory.personalVersions({ query }, clientOptions(signal)),
  rollbackMemoryChange: (id: string): Promise<MemoryChange> =>
    rpc.memory.rollback({ params: { id } }),
  memoryReviews: (query: MemoryReviewQuery = {}, signal?: AbortSignal): Promise<MemoryReviewList> =>
    rpc.memoryReviews.list({ query }, clientOptions(signal)),
  /** 幂等键随请求头提交；同一键重复提交返回同一个 runId。scope=own 约束来源会话必须是本人。 */
  createMemoryReview: (
    input: CreateMemoryReviewInput,
    idempotencyKey: string,
    scope?: 'own',
  ): Promise<{ runId: string }> =>
    rpc.memoryReviews.create(
      {
        query: { ...(scope === undefined ? {} : { scope }) },
        body: input,
      },
      { context: { idempotencyKey } },
    ),
  memoryReview: (runId: string, signal?: AbortSignal): Promise<MemoryReview> =>
    rpc.memoryReviews.detail({ params: { runId } }, clientOptions(signal)),
  applyMemoryReview: (runId: string): Promise<MemoryChange> =>
    rpc.memoryReviews.apply({ params: { runId } }),
  rejectMemoryReview: (runId: string): Promise<MemoryReview> =>
    rpc.memoryReviews.decide({ params: { runId }, body: { decision: 'rejected' } }),
};
