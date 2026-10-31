import { repo } from '@agentport/db';
import { OPENUI_STATE_MAX_BYTES, segmentOpenUi } from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { actorOf, authorizeObject } from '../access.js';

const params = z.object({
  conversationId: z.string().min(1),
  messageId: z.string().min(1),
});

const stateBody = z.object({
  blockKey: z.string().min(1).max(256),
  /** 表单字段值 / 绑定变量；必须是普通对象，数组与标量没有可合并的键。 */
  state: z.record(z.string(), z.unknown()),
});

/** 主助手文本：子智能体的文本块带 parentToolUseId，不属于顶层界面。 */
function topLevelText(content: unknown): { text: string } | { subAgent: true } | null {
  if (typeof content !== 'object' || content === null) return null;
  const record = content as Record<string, unknown>;
  if (typeof record.parentToolUseId === 'string') return { subAgent: true };
  return typeof record.text === 'string' ? { text: record.text } : null;
}

/**
 * 生成式 UI 的表单/绑定快照。前端按 block 增量上报，服务端用单条 UPDATE 合并：
 * 一个 block 的更新不能覆盖同一条消息里其他 block 的已存状态。
 */
export function registerOpenUiStateRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  app.put(
    '/api/conversations/:conversationId/messages/:messageId/openui-state',
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.update' } },
      schema: { params, body: stateBody },
    },
    async (request, reply) => {
      const { conversationId, messageId } = request.params;
      const { blockKey, state } = request.body;

      // 状态属于会话正文；先按会话对象判定范围，再校验消息归属。
      const conversation = await repo.chat.getConversation(app.db, conversationId);
      if (!conversation) {
        return reject(reply, 'CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请刷新后重试');
      }
      await authorizeObject(
        app,
        request,
        'conversations.update',
        { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
        '会话不存在，可能已被删除；请刷新后重试',
      );
      const message = await repo.openui.getMessageInConversation(app.db, conversationId, messageId);
      if (!message) {
        return reject(reply, 'NOT_FOUND', '消息不属于该会话，可能已被删除；请刷新后重试');
      }
      // 只有生成式 UI 的助手消息挂状态；其他消息没有可恢复的界面。
      if (message.role !== 'assistant' || message.uiFormat !== 'openui') {
        return reject(reply, 'INVALID_INPUT', '该消息不是生成式 UI，无法保存界面状态');
      }
      const content = topLevelText(message.content);
      if (content === null) {
        return reject(reply, 'INVALID_INPUT', '该消息没有可保存的界面状态；请刷新后重试');
      }
      if ('subAgent' in content) {
        return reject(reply, 'FORBIDDEN', '子智能体的输出没有可保存的界面状态；请刷新后重试');
      }
      // blockKey 由服务端分段决定：只接受这条消息里真实存在的 UI 段（s0、s1…）。
      // 有合并快照时以快照为准，否则回退到原始文本。
      const segments = segmentOpenUi(message.uiProgram ?? content.text);
      if (!segments.some((segment) => segment.kind === 'openui' && segment.blockKey === blockKey)) {
        return reject(reply, 'INVALID_INPUT', `该消息没有 ${blockKey} 这个界面段；请刷新后重试`);
      }

      // 单个 block 的快照有硬上限：超了明确失败，不静默截断用户输入。
      if (Buffer.byteLength(JSON.stringify(state), 'utf8') > OPENUI_STATE_MAX_BYTES) {
        return reject(reply, 'PAYLOAD_TOO_LARGE', '生成式 UI 状态超过 64KB 上限，未保存');
      }

      // 读-合并-写在同一条 SQL 里完成；并发写不同 block 不会互相覆盖。
      const saved = await repo.openui.patchMessageUiState(
        app.db,
        conversationId,
        messageId,
        blockKey,
        state,
      );
      if (!saved) {
        return reject(reply, 'NOT_FOUND', '消息不属于该会话，可能已被删除；请刷新后重试');
      }

      await writeAudit(app.db, request.log, {
        actor: actorOf(request),
        action: 'openui.state.saved',
        target: messageId,
        // 表单值可能含用户输入，审计只记 block 名。
        input: { conversationId, blockKey },
        status: 'ok',
        requestId: request.id,
      });
      return { version: 1, blockKey };
    },
  );
}
