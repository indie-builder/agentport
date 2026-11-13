import type {
  ConversationBranch,
  ConversationSearchResponse,
  ConversationSummary,
  MessageAttachment,
  OpenUiToolResult,
  OutputContent,
  OutputFile,
  OutputList,
  OutputShare,
  PublicOutputShare,
  ChatRequest as SharedChatRequest,
  ConversationDetail as SharedConversationDetail,
} from '@agentport/shared';
import { ApiError, fetchResponse, responseApiError, rpc } from '../orpc.js';
import { clientOptions, nativeRequest } from './shared.js';

export type { ConversationBranch } from '@agentport/shared';

/**
 * 公开分享只认 URL 片段里的 Bearer token，不带管理会话 cookie，也不触发登录跳转。
 * 无效、撤销与源文件删除都由服务端统一 404，这里原样交给页面显示单一无效状态。
 */
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

export interface ChatAccepted {
  runId: string;
  conversationId: string;
  /** 仅本次带附件发送时返回元数据；字节只上行，响应里没有 base64 与宿主路径。 */
  attachments?: MessageAttachment[] | undefined;
}

/** 附件随消息一次性提交；字节只在这里出现，落库与回放只保留元数据。 */
export type ChatAttachmentInput = NonNullable<SharedChatRequest['attachments']>[number];

/** 发送契约来自 shared；本地别名让 Web 调用方只依赖 api 模块。 */
export type ChatRequest = SharedChatRequest;

export type Conversation = ConversationSummary;

export type ConversationDetail = SharedConversationDetail;

/** 会话消息分页：默认 50 条、上限 100；before 为上一页最早消息的 id。 */
export interface ConversationPageOptions {
  limit?: number;
  before?: string;
}

/** 全局历史搜索：空 q 按最近活动返回；before 是服务端下发的下一页游标。 */
export interface ConversationSearchOptions {
  q?: string;
  agentId?: string;
  limit?: number;
  before?: string;
}

export interface OutputShareList {
  items: OutputShare[];
}

export interface PublicOutputShareContent {
  file: PublicOutputShare['file'];
  content: string;
}

export default {
  renameConversation: (id: string, title: string): Promise<ConversationDetail['conversation']> =>
    rpc.chat.renameConversation({ params: { id }, body: { title } }),
  deleteConversation: (id: string): Promise<void> =>
    rpc.chat.deleteConversation({ params: { id } }),
  conversations: (agentId?: string, signal?: AbortSignal): Promise<Conversation[]> =>
    rpc.chat.listConversations(
      { query: agentId === undefined ? {} : { agentId } },
      clientOptions(signal),
    ),
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
  /** 会话成果按版本倒序分页；同一路径的多版由调用方分组，后端不做合并。 */
  outputs: (
    conversationId: string,
    options: { limit?: number; before?: string } = {},
    signal?: AbortSignal,
  ): Promise<OutputList> =>
    rpc.chat.listOutputs({ params: { id: conversationId }, query: options }, clientOptions(signal)),
  /** 文本预览只读已发布快照；超过后端上限时返回明确错误，由页面改为下载。 */
  outputContent: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<OutputContent> =>
    nativeRequest(
      `/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/content?path=${encodeURIComponent(path)}`,
      'GET',
      undefined,
      signal,
    ),
  /** 列表未覆盖的旧版先取真实元信息，再决定按文本还是图片预览，不猜类型。 */
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
  /** 图片与 PDF 预览复用下载端点，保留统一 cookie 会话、401 跳转与 Problem 错误。 */
  outputBlob: (
    conversationId: string,
    runId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Blob> =>
    nativeRequest(
      `/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/download?path=${encodeURIComponent(path)}`,
      'GET',
      undefined,
      signal,
      'blob',
    ),
  outputDownloadUrl: (conversationId: string, runId: string, path: string): string =>
    `/api/conversations/${conversationId}/outputs/${encodeURIComponent(runId)}/download?path=${encodeURIComponent(path)}`,
  /** 同一三元组的分享记录，含已撤销状态。 */
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
  /** 生成式 UI 的 Query/Mutation：工具目录由服务端授权，未授权会 403。 */
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
  /** 会话级审批：202 返回的 approvalId 在这里批准；同一工具调用重试即执行。 */
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
  /** 生成式 UI 的表单/绑定快照；按 block 合并，不覆盖同消息其他段。 */
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
