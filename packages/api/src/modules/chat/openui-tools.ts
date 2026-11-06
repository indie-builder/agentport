import { chatContract } from '@agentport/contract/chat';
import { AppError, fail } from '@agentport/core';
import { repo } from '@agentport/db';
import type { OpenUiToolResult } from '@agentport/shared';
import { openUiToolResultSchema, segmentOpenUi } from '@agentport/shared';
import {
  type CallToolResult,
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { fromJsonSchema } from '@modelcontextprotocol/server';
import { implement } from '@orpc/server';
import { actorOf, authorizeObject } from '../../http/access.js';
import type { AppContext, RequestContext } from '../../http/context.js';
import { writeAudit } from '../../plugins/audit.js';

import { buildGeneratedServer } from '../servers/generated.js';
import { getServerWithSecrets, listTools } from '../servers/repo.js';
import { assertSafeUrl } from '../servers/ssrf.js';

const CLIENT_TIMEOUT_MS = 35000;
async function validateArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): Promise<string | null> {
  let result: Awaited<ReturnType<ReturnType<typeof fromJsonSchema>['~standard']['validate']>>;
  try {
    result = await fromJsonSchema(schema)['~standard'].validate(args);
  } catch (err) {
    const detail = err instanceof Error ? err.message : '无法解析';
    return `工具的参数定义是无效的 JSON Schema（${detail}）`;
  }
  if ('issues' in result && result.issues !== undefined) {
    return result.issues.map((issue) => issue.message).join('; ');
  }
  return null;
}
type ToolRow = Awaited<ReturnType<typeof repo.openui.listOpenUiTools>>[number];
async function callTool(
  context: AppContext,
  tool: ToolRow,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = await getServerWithSecrets(
    context.db,
    tool.serverId,
    context.config.APP_SECRET_KEY,
  );
  if (!server) throw new AppError('NOT_FOUND', '该工具所属的连接已不存在；请让管理员重新绑定');
  const bareName = tool.name.slice(`mcp__${tool.serverName}__`.length);
  if (server.kind === 'generated') {
    const apiTools = (await listTools(context.db, tool.serverId)).filter(
      (entry) => entry.enabled && entry.name === bareName,
    );
    if (apiTools.length === 0) throw new AppError('NOT_FOUND', '该工具已停用；请刷新后重试');
    const built = buildGeneratedServer({
      name: server.name,
      baseUrl: server.baseUrl,
      headers: server.headers,
      tools: apiTools,
      approvals: [bareName],
      nodeEnv: context.config.NODE_ENV,
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await built.connect(serverSide);
    const client = new Client({ name: 'agentport-openui', version: '0.1.0' });
    try {
      await client.connect(clientSide);
      return await client.callTool(
        { name: bareName, arguments: args },
        { timeout: CLIENT_TIMEOUT_MS },
      );
    } finally {
      await client.close().catch(() => undefined);
      await built.close().catch(() => undefined);
    }
  }
  if (server.kind !== 'http') {
    throw new AppError('FORBIDDEN', `${server.kind} 工具不能从浏览器调用；请让模型在沙盒内使用`);
  }
  await assertSafeUrl(server.url, context.config.NODE_ENV);
  const client = new Client({ name: 'agentport-openui', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers, redirect: 'error' },
  });
  try {
    await client.connect(transport, { timeout: 5000 });
    return await client.callTool(
      { name: bareName, arguments: args },
      { timeout: CLIENT_TIMEOUT_MS },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}
function extractToolResult(result: CallToolResult): unknown {
  if (result.isError === true) {
    const text = result.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    throw new AppError('UPSTREAM_FAILED', text || '上游返回错误');
  }
  if (result.structuredContent != null) return result.structuredContent;
  const parts = result.content
    ?.filter((item) => item.type === 'text')
    .map((item) => item.text ?? '');
  if (parts !== undefined && parts.length > 0) {
    const text = parts.join('');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return null;
}
const os = implement(chatContract).$context<RequestContext>();
export const chatToolsRouter = {
  callOpenuiTool: os.callOpenuiTool.handler(async ({ input, context }) => {
    const { conversationId, toolName } = input.params;
    const { args, messageId, blockKey } = input.body;
    const conversation = await repo.chat.getConversation(context.db, conversationId);
    if (!conversation) {
      return fail('CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请刷新后重试');
    }
    await authorizeObject(
      context,
      'conversations.update',
      { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
      '会话不存在，可能已被删除；请刷新后重试',
    );
    await authorizeObject(
      context,
      'agents.use',
      { agentId: conversation.agentId, objectId: conversation.agentId },
      '专家不存在或无权使用；请让负责人重新授权后再试',
    );
    const message = await repo.openui.getMessageInConversation(
      context.db,
      conversationId,
      messageId,
    );
    if (!message) {
      return fail('NOT_FOUND', '消息不属于该会话，可能已被删除；请刷新后重试');
    }
    if (message.role !== 'assistant' || message.uiFormat !== 'openui') {
      return fail('INVALID_INPUT', '该消息不是生成式 UI，无法执行其中的界面动作');
    }
    const content = message.content as Record<string, unknown> | null;
    if (typeof content?.parentToolUseId === 'string') {
      return fail('FORBIDDEN', '子智能体的输出没有可执行的界面动作；请刷新后重试');
    }
    const text = message.uiProgram ?? (typeof content?.text === 'string' ? content.text : '');
    const segmentExists = segmentOpenUi(text).some(
      (segment) => segment.kind === 'openui' && segment.blockKey === blockKey,
    );
    if (!segmentExists) {
      return fail('INVALID_INPUT', `该消息没有 ${blockKey} 这个界面段；请刷新后重试`);
    }
    const catalog = await repo.openui.listOpenUiTools(context.db, conversation.agentId);
    const tool = catalog.find((entry) => entry.name === toolName);
    if (!tool) {
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'openui.tool.denied',
        target: conversationId,
        input: { toolName, blockKey },
        status: 'denied',
        requestId: context.requestId,
      });
      return fail(
        'FORBIDDEN',
        '该工具未绑定到当前智能体或已停用；请让管理员在智能体配置里绑定后再试',
      );
    }
    const invalid = await validateArgs(tool.inputSchema, args);
    if (invalid !== null) return fail('INVALID_INPUT', `工具参数不合法：${invalid}`);
    const approval = await repo.openui.getOpenUiApproval(
      context.db,
      conversationId,
      tool.serverId,
      tool.name,
    );
    if (tool.requiresApproval && approval?.approvedAt == null) {
      const pending = await repo.openui.requestOpenUiApproval(context.db, {
        conversationId,
        messageId,
        serverId: tool.serverId,
        toolName: tool.name,
      });
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'openui.tool.approval_required',
        target: conversationId,
        input: { toolName: tool.name, approvalId: pending.id },
        status: 'ok',
        requestId: context.requestId,
      });
      return {
        status: 202 as const,
        body: { status: 'approval_required', approvalId: pending.id } satisfies OpenUiToolResult,
      };
    }
    const startedAt = Date.now();
    try {
      const data = extractToolResult(await callTool(context, tool, args));
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'openui.tool.called',
        target: conversationId,
        input: { toolName: tool.name, blockKey },
        status: 'ok',
        durationMs: Date.now() - startedAt,
        requestId: context.requestId,
      });
      return { status: 200 as const, body: openUiToolResultSchema.parse({ status: 'ok', data }) };
    } catch (err) {
      const message = err instanceof AppError ? err.message : '工具调用失败';
      await writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'openui.tool.called',
        target: conversationId,
        input: { toolName: tool.name, blockKey, error: message },
        status: 'error',
        durationMs: Date.now() - startedAt,
        requestId: context.requestId,
      });
      return {
        status: 200 as const,
        body: openUiToolResultSchema.parse({ status: 'error', error: message }),
      };
    }
  }),
  approveOpenuiTool: os.approveOpenuiTool.handler(async ({ input, context }) => {
    const { conversationId, approvalId } = input.params;
    const conversation = await repo.chat.getConversation(context.db, conversationId);
    if (!conversation) {
      return fail('CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请刷新后重试');
    }
    await authorizeObject(
      context,
      'runs.approve',
      { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
      '会话不存在，可能已被删除；请刷新后重试',
    );
    const approved = await repo.openui.approveOpenUiApproval(
      context.db,
      conversationId,
      approvalId,
    );
    if (!approved) {
      return fail(
        'APPROVAL_NOT_FOUND',
        '没有这条待批准记录；它可能已批准或不属于该会话，请刷新后重试',
      );
    }
    await writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'openui.tool.approved',
      target: conversationId,
      input: { approvalId },
      status: 'ok',
      requestId: context.requestId,
    });
    return {
      approvalId: approved.id,
      approvedAt: approved.approvedAt?.toISOString() ?? null,
      expiresAt: approved.expiresAt?.toISOString() ?? null,
    };
  }),
};
