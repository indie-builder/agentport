import { AppError } from '@agentport/core';
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
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { mcpRateLimit } from '../../plugins/security.js';
import { typed } from '../../types.js';
import { buildGeneratedServer } from '../servers/generated.js';
import { getServerWithSecrets, listTools } from '../servers/repo.js';
import { assertSafeUrl } from '../servers/ssrf.js';

const params = z.object({
  conversationId: z.string().min(1),
  toolName: z.string().min(1),
});

const body = z.object({
  args: z.record(z.string(), z.unknown()).default({}),
  messageId: z.string().min(1),
  blockKey: z.string().min(1).max(256),
});

const approvalParams = z.object({
  conversationId: z.string().min(1),
  approvalId: z.string().min(1),
});

const CLIENT_TIMEOUT_MS = 35_000;

/**
 * JSON Schema 校验入参；错误文案直接回给 UI，避免「点了没反应」。
 * 无效 schema（管理员写坏的目录快照/工具定义）是信任边界问题：明确报输入错误，
 * 不能抛成 500 让调用方以为服务端故障。
 */
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

/**
 * 生成式 UI 的 Query/Mutation 执行桥。只允许当前会话所属智能体绑定且启用的工具；
 * 工具描述与提示词来自同一份目录（repo.openui.listOpenUiTools），
 * 因此提示词里没有的工具在这里也一定找不到。
 */
export function registerOpenUiToolRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  app.post(
    '/api/chat/:conversationId/openui/tools/:toolName',
    {
      preHandler: [rawApp.requireAuth],
      ...mcpRateLimit,
      schema: { params, body },
    },
    async (request, reply) => {
      const { conversationId, toolName } = request.params;
      const { args, messageId, blockKey } = request.body;

      const conversation = await repo.chat.getConversation(app.db, conversationId);
      if (!conversation) {
        return reject(reply, 'CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请刷新后重试');
      }
      const message = await repo.openui.getMessageInConversation(app.db, conversationId, messageId);
      if (!message) {
        return reject(reply, 'NOT_FOUND', '消息不属于该会话，可能已被删除；请刷新后重试');
      }
      // 与 openui-state / 动作回传同一道来源校验：执行 Mutation 的段必须真实存在于
      // 主助手的生成式 UI 消息里，否则用户消息或子智能体消息上的伪造 blockKey 也能触发写操作。
      if (message.role !== 'assistant' || message.uiFormat !== 'openui') {
        return reject(reply, 'INVALID_INPUT', '该消息不是生成式 UI，无法执行其中的界面动作');
      }
      const content = message.content as Record<string, unknown> | null;
      // 子智能体的消息不是主助手界面：它的段不会被渲染，也不能作为动作来源。
      if (typeof content?.parentToolUseId === 'string') {
        return reject(reply, 'FORBIDDEN', '子智能体的输出没有可执行的界面动作；请刷新后重试');
      }
      // 与 openui-state 一致：有合并快照时以快照为准，否则回退到原始文本。
      const text = message.uiProgram ?? (typeof content?.text === 'string' ? content.text : '');
      const segmentExists = segmentOpenUi(text).some(
        (segment) => segment.kind === 'openui' && segment.blockKey === blockKey,
      );
      if (!segmentExists) {
        return reject(reply, 'INVALID_INPUT', `该消息没有 ${blockKey} 这个界面段；请刷新后重试`);
      }

      // 目录即授权：未绑定、已停用、被 allowedTools/disallowedTools 排除的工具都不出现。
      const catalog = await repo.openui.listOpenUiTools(app.db, conversation.agentId);
      const tool = catalog.find((entry) => entry.name === toolName);
      if (!tool) {
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'openui.tool.denied',
          target: conversationId,
          input: { toolName, blockKey },
          status: 'denied',
          requestId: request.id,
        });
        return reject(
          reply,
          'FORBIDDEN',
          '该工具未绑定到当前智能体或已停用；请让管理员在智能体配置里绑定后再试',
        );
      }

      const invalid = await validateArgs(tool.inputSchema, args);
      if (invalid !== null) return reject(reply, 'INVALID_INPUT', `工具参数不合法：${invalid}`);

      const approval = await repo.openui.getOpenUiApproval(
        app.db,
        conversationId,
        tool.serverId,
        tool.name,
      );

      // 需要批准且尚未批准：落一条会话级待批记录并返回 202。
      // 批准后同一调用重试即可继续，不需要重新生成 UI。
      if (tool.requiresApproval && approval?.approvedAt == null) {
        const pending = await repo.openui.requestOpenUiApproval(app.db, {
          conversationId,
          messageId,
          serverId: tool.serverId,
          toolName: tool.name,
        });
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'openui.tool.approval_required',
          target: conversationId,
          input: { toolName: tool.name, approvalId: pending.id },
          status: 'ok',
          requestId: request.id,
        });
        return reply
          .status(202)
          .send({ status: 'approval_required', approvalId: pending.id } satisfies OpenUiToolResult);
      }

      const startedAt = Date.now();
      try {
        const data = extractToolResult(await callTool(app, tool, args));
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'openui.tool.called',
          target: conversationId,
          input: { toolName: tool.name, blockKey },
          status: 'ok',
          durationMs: Date.now() - startedAt,
          requestId: request.id,
        });
        return openUiToolResultSchema.parse({ status: 'ok', data });
      } catch (err) {
        const message = err instanceof AppError ? err.message : '工具调用失败';
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'openui.tool.called',
          target: conversationId,
          input: { toolName: tool.name, blockKey, error: message },
          status: 'error',
          durationMs: Date.now() - startedAt,
          requestId: request.id,
        });
        return openUiToolResultSchema.parse({ status: 'error', error: message });
      }
    },
  );

  /**
   * 会话级审批的批准入口。工具桥的 202 带 approvalId，前端拿它调用这里；
   * 批准后重试同一个工具调用即可执行，不需要重新生成 UI。
   */
  app.post(
    '/api/chat/:conversationId/openui/approvals/:approvalId/approve',
    {
      preHandler: [rawApp.requireAuth],
      schema: { params: approvalParams },
    },
    async (request, reply) => {
      const { conversationId, approvalId } = request.params;
      const conversation = await repo.chat.getConversation(app.db, conversationId);
      if (!conversation) {
        return reject(reply, 'CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请刷新后重试');
      }
      const approved = await repo.openui.approveOpenUiApproval(app.db, conversationId, approvalId);
      if (!approved) {
        return reject(
          reply,
          'APPROVAL_NOT_FOUND',
          '没有这条待批准记录；它可能已批准或不属于该会话，请刷新后重试',
        );
      }
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'openui.tool.approved',
        target: conversationId,
        input: { approvalId },
        status: 'ok',
        requestId: request.id,
      });
      return {
        approvalId: approved.id,
        approvedAt: approved.approvedAt?.toISOString() ?? null,
        expiresAt: approved.expiresAt?.toISOString() ?? null,
      };
    },
  );
}

type ToolRow = Awaited<ReturnType<typeof repo.openui.listOpenUiTools>>[number];

/** 两种 server 都走各自现成的调用链，复用 SSRF、超时与响应体大小限制。 */
async function callTool(
  app: FastifyInstance,
  tool: ToolRow,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const server = await getServerWithSecrets(app.db, tool.serverId, app.config.APP_SECRET_KEY);
  if (!server) throw new AppError('NOT_FOUND', '该工具所属的连接已不存在；请让管理员重新绑定');
  // 工具名去掉 `mcp__<server>__` 前缀才是 server 上的原名。
  const bareName = tool.name.slice(`mcp__${tool.serverName}__`.length);

  if (server.kind === 'generated') {
    const apiTools = (await listTools(app.db, tool.serverId)).filter(
      (entry) => entry.enabled && entry.name === bareName,
    );
    if (apiTools.length === 0) throw new AppError('NOT_FOUND', '该工具已停用；请刷新后重试');
    // 复用 generated server 的调用实现：鉴权已在本路由完成，这里不再走审批等待。
    const built = buildGeneratedServer({
      name: server.name,
      baseUrl: server.baseUrl,
      headers: server.headers,
      tools: apiTools,
      approvals: [bareName],
      nodeEnv: app.config.NODE_ENV,
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

  // 目录只含 http/generated（listOpenUiTools 白名单）；这里再兜一层，
  // 知识库等其余连接类型绝不按 http 去 fetch。
  if (server.kind !== 'http') {
    throw new AppError('FORBIDDEN', `${server.kind} 工具不能从浏览器调用；请让模型在沙盒内使用`);
  }

  // 与测试连接同一道检查：保存时能过，不代表运行时 DNS 没被改。
  await assertSafeUrl(server.url, app.config.NODE_ENV);
  const client = new Client({ name: 'agentport-openui', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    // 与测试连接一致：不跟随重定向，SSRF 检查只覆盖第一跳。
    requestInit: { headers: server.headers, redirect: 'error' },
  });
  try {
    await client.connect(transport, { timeout: 5_000 });
    return await client.callTool(
      { name: bareName, arguments: args },
      { timeout: CLIENT_TIMEOUT_MS },
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** 与官方 extractToolResult 同规则：structuredContent 优先，其次把 text 块拼起来解析 JSON。 */
function extractToolResult(result: CallToolResult): unknown {
  if (result.isError === true) {
    const text = result.content
      ?.filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    // 错误也走 HTTP 200 + `{status:'error'}`：UI 用 Callout 展示，不是服务端故障。
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
