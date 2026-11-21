import type {
  Channel,
  ChannelAgentBinding,
  ChannelDetail,
  ChannelListItem,
  ChannelMember,
  ChannelMessage,
  ChannelRole,
  CursorPage,
  channelHandoffInputSchema,
  channelMessageInputSchema,
  PublicQuestionResponse,
  PublicRunQuestion,
  RunStatus,
} from '@agentport/shared';
import type { z } from 'zod';
import type { ApiClient } from '../orpc.js';
import { rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

export type ChannelMessageInput = z.input<typeof channelMessageInputSchema>;

export type ChannelHandoffInput = z.input<typeof channelHandoffInputSchema>;

/** 频道活动 run：只有 queued/running；状态来自 DB，不是 SSE 快照。 */
export interface ChannelActiveRun {
  runId: string;
  agentId: string;
  status: RunStatus;
  initiatedBy: string | null;
  startedAt: string | null;
}

export type ChannelApproval = ApiOutput<ApiClient['channels']['approve']>;

export type ChannelRunDetail = ApiOutput<ApiClient['channels']['runDetail']>;

export type ChannelRunQuestions = ApiOutput<ApiClient['channels']['runQuestions']>;

export type ChannelRunOutputs = ApiOutput<ApiClient['channels']['runOutputs']>;

export type ChannelRunOutputContent = ApiOutput<ApiClient['channels']['runOutputContent']>;

export default {
  channels: (cursor?: string, signal?: AbortSignal): Promise<CursorPage<ChannelListItem>> =>
    rpc.channels.list({ query: cursor === undefined ? {} : { cursor } }, clientOptions(signal)),
  createChannel: (input: { name: string; description?: string | null }): Promise<Channel> =>
    rpc.channels.create({ body: input }),
  channel: (id: string, signal?: AbortSignal): Promise<ChannelDetail> =>
    rpc.channels.detail({ params: { id } }, clientOptions(signal)),
  channelMessages: (
    id: string,
    options: { after?: number; before?: number; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<ChannelMessage[]> =>
    rpc.channels.messages({ params: { id }, query: options }, clientOptions(signal)),
  postChannelMessage: async (id: string, input: ChannelMessageInput): Promise<ChannelMessage> =>
    (await rpc.channels.postMessage({ params: { id }, body: input })).body,
  handoffChannel: (id: string, input: ChannelHandoffInput): Promise<ChannelMessage> =>
    rpc.channels.handoff({ params: { id }, body: input }),
  markChannelRead: (id: string, seq: number): Promise<{ lastReadSeq: number }> =>
    rpc.channels.markRead({ params: { id }, body: { seq } }),
  bindChannelAgent: (
    id: string,
    input: { agentId: string; autoWakeOnAll?: boolean },
  ): Promise<ChannelAgentBinding> => rpc.channels.addAgent({ params: { id }, body: input }),
  updateChannelAgent: (
    id: string,
    agentId: string,
    input: { autoWakeOnAll: boolean },
  ): Promise<ChannelAgentBinding> =>
    rpc.channels.updateAgent({ params: { id, agentId }, body: input }),
  updateChannel: (
    id: string,
    input: { name?: string; description?: string | null },
  ): Promise<Channel> => rpc.channels.update({ params: { id }, body: input }),
  addChannelMember: (
    id: string,
    input: { businessId: string; role: ChannelRole },
  ): Promise<ChannelMember> => rpc.channels.addMember({ params: { id }, body: input }),
  updateChannelMember: (
    id: string,
    businessId: string,
    role: ChannelRole,
  ): Promise<ChannelMember> =>
    rpc.channels.updateMember({ params: { id, businessId }, body: { role } }),
  removeChannelMember: (id: string, businessId: string): Promise<void> =>
    rpc.channels.removeMember({ params: { id, businessId } }),
  removeChannelAgent: (id: string, agentId: string): Promise<void> =>
    rpc.channels.removeAgent({ params: { id, agentId } }),
  disconnectChannelAgent: (id: string, agentId: string): Promise<void> =>
    rpc.channels.disconnectAgent({ params: { id, agentId } }),
  closeChannel: (id: string): Promise<{ id: string; archivedAt: string }> =>
    rpc.channels.close({ params: { id } }),
  channelRuns: (id: string, signal?: AbortSignal): Promise<{ items: ChannelActiveRun[] }> =>
    rpc.channels.activeRuns({ params: { id }, query: { status: 'active' } }, clientOptions(signal)),
  channelApprovals: (id: string, signal?: AbortSignal): Promise<{ items: ChannelApproval[] }> =>
    rpc.channels.approvals({ params: { id } }, clientOptions(signal)),
  approveChannelApproval: (id: string, approvalId: string): Promise<ChannelApproval> =>
    rpc.channels.approve({ params: { id, approvalId } }),
  denyChannelApproval: (id: string, approvalId: string): Promise<ChannelApproval> =>
    rpc.channels.deny({ params: { id, approvalId } }),
  stopChannelRun: (id: string, runId: string): Promise<{ ok: boolean }> =>
    rpc.channels.stopRun({ params: { id, runId } }),
  channelRunDetail: (id: string, runId: string, signal?: AbortSignal): Promise<ChannelRunDetail> =>
    rpc.channels.runDetail({ params: { id, runId } }, clientOptions(signal)),
  channelRunQuestions: (
    id: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<ChannelRunQuestions> =>
    rpc.channels.runQuestions({ params: { id, runId } }, clientOptions(signal)),
  respondToChannelQuestion: (
    id: string,
    runId: string,
    requestId: string,
    response: PublicQuestionResponse,
  ): Promise<PublicRunQuestion> =>
    rpc.channels.respondToRunQuestion({
      params: { id, runId, requestId },
      body: response,
    }),
  channelRunOutputs: (
    id: string,
    runId: string,
    options: { limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<ChannelRunOutputs> =>
    rpc.channels.runOutputs({ params: { id, runId }, query: options }, clientOptions(signal)),
  channelRunOutputContent: (
    id: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<ChannelRunOutputContent> =>
    nativeRequest(
      `/channels/${id}/runs/${encodeURIComponent(runId)}/outputs/content?path=${encodeURIComponent(path)}`,
      { signal },
    ),
  channelRunOutputBlob: (
    id: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Blob> =>
    nativeRequest(
      `/channels/${id}/runs/${encodeURIComponent(runId)}/outputs/download?path=${encodeURIComponent(path)}`,
      { signal, responseType: 'blob' },
    ),
  channelRunOutputDownloadUrl: (id: string, runId: string, path: string): string =>
    `/api/channels/${id}/runs/${encodeURIComponent(runId)}/outputs/download?path=${encodeURIComponent(path)}`,
  channelAttachmentDownloadUrl: (
    channelId: string,
    messageId: string,
    attachmentId: string,
  ): string =>
    `/api/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/download`,
};
