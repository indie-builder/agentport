import type {
  ConversationBranch,
  ConversationSearchResponse,
  ConversationSummary,
  CursorPage,
  OpenUiToolResult,
  OutputContent,
  OutputFile,
  OutputList,
  OutputShare,
  PublicOutputShare,
  ChatRequest as SharedChatRequest,
  ConversationDetail as SharedConversationDetail,
} from '@agentport/shared';
import { type ApiClient, ApiError, fetchResponse, responseApiError, rpc } from '../orpc.js';
import type { ApiOutput } from './shared.js';
import { clientOptions, nativeRequest } from './shared.js';

async function publicShareRequest<T>(
  id: string,
  token: string,
  suffix: string,
  responseType: 'json' | 'blob',
): Promise<T> {
  let res: Response;
  try {
    res = await fetchResponse(`/api/public/output-shares/${encodeURIComponent(id)}${suffix}`, {
      headers: { authorization: `Bearer ${token}` },
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (error) {
    if ((error as { name?: string } | null)?.name === 'AbortError') throw error;
    throw new ApiError(0, '连不上分享服务，请检查网络后重试。');
  }
  if (!res.ok) throw await responseApiError(res);
  return (responseType === 'blob' ? await res.blob() : await res.json()) as T;
}

export type ChatAccepted = Extract<
  ApiOutput<ApiClient['chat']['startRun']>,
  { status: 202 }
>['body'];

export type ChatAttachmentInput = NonNullable<SharedChatRequest['attachments']>[number];

type ChatRequest = SharedChatRequest;

export type ConversationDetail = SharedConversationDetail;

type ConversationPageOptions = Omit<
  Parameters<ApiClient['chat']['conversation']>[0]['query'],
  'limit'
> & { limit?: number };

export type ConversationSearchOptions = Omit<
  Parameters<ApiClient['chat']['searchConversations']>[0]['query'],
  'limit'
> & { limit?: number };

export type OutputShareList = ApiOutput<ApiClient['outputShares']['list']>;

type PublicOutputShareContent = ApiOutput<ApiClient['outputShares']['publicContent']>;

export default {
  renameConversation: (id: string, title: string): Promise<ConversationDetail['conversation']> =>
    rpc.chat.renameConversation({ params: { id }, body: { title } }),
  deleteConversation: (id: string): Promise<void> =>
    rpc.chat.deleteConversation({ params: { id } }),
  conversations: (
    query: { agentId?: string; limit?: number; cursor?: string } = {},
    signal?: AbortSignal,
  ): Promise<CursorPage<ConversationSummary>> =>
    rpc.chat.listConversations({ query }, clientOptions(signal)),
  searchConversations: (
    options: ConversationSearchOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationSearchResponse> =>
    rpc.chat.searchConversations({ query: options }, clientOptions(signal)),
  conversation: (
    id: string,
    options: ConversationPageOptions = {},
    signal?: AbortSignal,
  ): Promise<ConversationDetail> =>
    rpc.chat.conversation({ params: { id }, query: options }, clientOptions(signal)),
  outputs: (
    conversationId: string,
    options: { limit?: number; cursor?: string; runId?: string } = {},
    signal?: AbortSignal,
  ): Promise<OutputList> =>
    rpc.chat.listOutputs({ params: { id: conversationId }, query: options }, clientOptions(signal)),
  outputContent: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<OutputContent> =>
    nativeRequest(
      `/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/content?path=${encodeURIComponent(path)}`,
      { signal },
    ),
  outputFile: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ file: OutputFile }> =>
    rpc.chat.output(
      { params: { id: conversationId, runId }, query: { path } },
      clientOptions(signal),
    ),
  outputBlob: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Blob> =>
    nativeRequest(
      `/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/download?path=${encodeURIComponent(path)}`,
      { signal, responseType: 'blob' },
    ),
  outputDownloadUrl: (conversationId: string, runId: string, path: string): string =>
    `/api/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/download?path=${encodeURIComponent(path)}`,
  outputShares: (
    conversationId: string,
    input: { runId: string; path: string },
    signal?: AbortSignal,
  ): Promise<OutputShareList> =>
    rpc.outputShares.list({ params: { id: conversationId }, query: input }, clientOptions(signal)),
  createOutputShare: (
    conversationId: string,
    input: { runId: string; path: string },
  ): Promise<OutputShare> =>
    rpc.outputShares.create({ params: { id: conversationId }, body: input }),
  revokeOutputShare: (id: string): Promise<void> => rpc.outputShares.revoke({ params: { id } }),
  publicOutputShare: (id: string, token: string): Promise<PublicOutputShare> =>
    publicShareRequest(id, token, '', 'json'),
  publicOutputShareContent: (id: string, token: string): Promise<PublicOutputShareContent> =>
    publicShareRequest(id, token, '/content', 'json'),
  publicOutputShareDownload: (id: string, token: string): Promise<Blob> =>
    publicShareRequest(id, token, '/download', 'blob'),
  branchConversation: (id: string, fromMessageId?: string): Promise<ConversationBranch> =>
    rpc.chat.branchConversation({
      params: { id },
      body: { ...(fromMessageId === undefined ? {} : { fromMessageId }) },
    }),
  regenerate: async (conversationId: string): Promise<ChatAccepted> => {
    const result = await rpc.chat.regenerate({ params: { conversationId } });
    return result.body;
  },
  callOpenUiTool: async (
    conversationId: string,
    toolName: string,
    input: { args: Record<string, unknown>; messageId: string; blockKey: string },
  ): Promise<OpenUiToolResult> =>
    (
      await rpc.chat.callOpenuiTool({
        params: { conversationId, toolName },
        body: input,
      })
    ).body,
  approveOpenUiTool: (
    conversationId: string,
    approvalId: string,
  ): Promise<{ approvalId: string; approvedAt: string | null }> =>
    rpc.chat.approveOpenuiTool({ params: { conversationId, approvalId } }),
  sendChat: async (input: ChatRequest): Promise<ChatAccepted> => {
    const result = await rpc.chat.startRun({ body: input });
    if (result.status === 202) return result.body;
    throw new ApiError(204, '该操作已在本地完成，不需要发起运行。');
  },
  saveOpenUiState: (
    conversationId: string,
    messageId: string,
    input: { blockKey: string; state: Record<string, unknown> },
  ): Promise<{ version: number; blockKey: string }> =>
    rpc.chat.saveOpenuiState({ params: { conversationId, messageId }, body: input }),
  cancelRun: async (runId: string): Promise<void> => {
    await rpc.chat.cancelRun({ params: { runId } });
  },
};
