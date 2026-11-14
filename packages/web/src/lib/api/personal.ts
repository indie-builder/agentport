import type {
  ConversationSummary,
  PersonalOutputShareList,
  PersonalProfile,
  PersonalRunExport,
  PersonalRunExportQuery,
  PersonalRunList,
  PersonalRunListQuery,
  PersonalSessionList,
  PersonalUsageSummary,
} from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';

export default {
  updatePersonalProfile: (input: { name: string }): Promise<PersonalProfile> =>
    rpc.auth.profile({ body: input }),
  meSessions: (signal?: AbortSignal): Promise<PersonalSessionList> =>
    rpc.auth.sessions(undefined, clientOptions(signal)),
  revokeMeSession: (id: string): Promise<void> => rpc.auth.revokeSession({ params: { id } }),
  personalOutputShares: (
    query: { cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<PersonalOutputShareList> =>
    rpc.personal.outputShares({ query }, clientOptions(signal)),
  revokePersonalOutputShare: (id: string): Promise<void> =>
    rpc.personal.revokeOutputShare({ params: { id } }),
  personalUsage: (days: number, signal?: AbortSignal): Promise<PersonalUsageSummary> =>
    rpc.personal.usage({ query: { days } }, clientOptions(signal)),
  personalRuns: (
    query: PersonalRunListQuery = { days: 30, limit: 50 },
    signal?: AbortSignal,
  ): Promise<PersonalRunList> => rpc.personal.runs({ query }, clientOptions(signal)),
  personalExportRuns: (query: PersonalRunExportQuery): Promise<PersonalRunExport> =>
    rpc.personal.exportRuns({ query }),
  /** 回顾来源固定本人；只带专家筛选，不传全局会话列表。 */
  personalConversations: (
    query: { agentId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ConversationSummary[]> => rpc.personal.conversations({ query }, clientOptions(signal)),
};
