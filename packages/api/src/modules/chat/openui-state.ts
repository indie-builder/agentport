import { chatContract } from '@agentport/contract/chat';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { OPENUI_STATE_MAX_BYTES } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { loadOpenuiConversation } from './access.js';
import { hasOpenUiBlock } from './openui-actions.js';

function topLevelText(content: unknown):
  | {
      text: string;
    }
  | {
      subAgent: true;
    }
  | null {
  if (typeof content !== 'object' || content === null) return null;
  const record = content as Record<string, unknown>;
  if (typeof record.parentToolUseId === 'string') return { subAgent: true };
  return typeof record.text === 'string' ? { text: record.text } : null;
}
const os = implement(chatContract).$context<RequestContext>();
export const chatStateRouter = {
  saveOpenuiState: os.saveOpenuiState.handler(async ({ input, context }) => {
    const { conversationId, messageId } = input.params;
    const { blockKey, state } = input.body;
    await loadOpenuiConversation(context, conversationId, 'conversations.update');
    const message = await repo.openui.getMessageInConversation(
      context.db,
      conversationId,
      messageId,
    );
    if (!message) {
      return fail('NOT_FOUND', '消息不属于该会话，可能已被删除；请刷新后重试');
    }
    if (message.role !== 'assistant' || message.uiFormat !== 'openui') {
      return fail('INVALID_INPUT', '该消息不是生成式 UI，无法保存界面状态');
    }
    const content = topLevelText(message.content);
    if (content === null) {
      return fail('INVALID_INPUT', '该消息没有可保存的界面状态；请刷新后重试');
    }
    if ('subAgent' in content) {
      return fail('FORBIDDEN', '子智能体的输出没有可保存的界面状态；请刷新后重试');
    }
    if (!hasOpenUiBlock(message.uiProgram ?? content.text, blockKey)) {
      return fail('INVALID_INPUT', `该消息没有 ${blockKey} 这个界面段；请刷新后重试`);
    }
    if (Buffer.byteLength(JSON.stringify(state), 'utf8') > OPENUI_STATE_MAX_BYTES) {
      return fail('PAYLOAD_TOO_LARGE', '生成式 UI 状态超过 64KB 上限，未保存');
    }
    const saved = await repo.openui.patchMessageUiState(
      context.db,
      conversationId,
      messageId,
      blockKey,
      state,
    );
    if (!saved) {
      return fail('NOT_FOUND', '消息不属于该会话，可能已被删除；请刷新后重试');
    }
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'openui.state.saved',
      target: messageId,
      input: { conversationId, blockKey },
      status: 'ok',
      requestId: context.requestId,
    });
    return { version: 1, blockKey };
  }),
};
