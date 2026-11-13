import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chatContract } from '@agentport/contract/chat';
import {
  copyConversationInputs,
  copyConversationOutputs,
  fail,
  removeConversationInputs,
  removeConversationOutputs,
} from '@agentport/core';
import { newId, repo, schema } from '@agentport/db';
import type { PermissionId } from '@agentport/shared';
import { implement } from '@orpc/server';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  accessFilter,
  actorOf,
  authorize,
  authorizeObject,
  requireUser,
} from '../../http/access.js';
import type { HttpEnv, RequestContext } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { access } from '../../http/middleware.js';
import { beginSse } from '../../http/sse.js';
import { authorizeRun, RUN_MISSING } from '../runs/access.js';
import { terminalRunEvent, writeChatEvent } from '../runs/events.js';
import { relayRunEvents } from '../runs/stream.js';
import { deleteConversationWithSandboxes } from '../runtime-deletion.js';
import {
  CONVERSATION_MISSING,
  loadReadableConversation,
  loadWritableConversation,
} from './access.js';
import { cancelAgentRun } from './cancel-run.js';
import type { NativeHttpDependencies } from './http.js';
import { chatStateRouter } from './openui-state.js';
import { chatToolsRouter } from './openui-tools.js';
import { chatOutputsRouter } from './outputs.js';
import { deleteCreatedConversation, startRun } from './use-cases.js';

const chatRepo = repo.chat;

function hasPlatformScope(context: RequestContext, permissionId: PermissionId): boolean {
  const principal = context.principal;
  return (
    principal?.kind === 'user' &&
    principal.grants.some(
      (grant) => grant.permissionId === permissionId && grant.scope === 'platform',
    )
  );
}

const os = implement(chatContract).$context<RequestContext>();
const chatMainRouter = {
  startRun: os.startRun.handler(async ({ input, context }) => {
    const result = await startRun(requireUser(context), input.body, {
      db: context.db,
      client: context.client,
      config: context.config,
      log: context.log,
      requestId: context.requestId,
      authorize: (permissionId, resource, message) =>
        message === undefined
          ? authorize(context, permissionId, resource)
          : authorizeObject(context, permissionId, resource, message),
    });
    return result === null
      ? { status: 204 as const, body: undefined }
      : { status: 202 as const, body: result };
  }),
  searchConversations: os.searchConversations.handler(async ({ input, context }) => {
    const result = await chatRepo.searchConversations(context.db, {
      ...input.query,
      access: accessFilter(context, 'conversations.read'),
    });
    return {
      items: result.items.map(({ updatedAt, ...item }) => ({
        ...item,
        updatedAt: updatedAt.toISOString(),
      })),
      nextBefore: result.nextBefore,
    };
  }),
  conversation: os.conversation.handler(async ({ input, context }) => {
    const conversation = await loadReadableConversation(context, input.params.id);
    const { limit, before } = input.query;
    if (
      before !== undefined &&
      !(await chatRepo.messageInConversation(context.db, conversation.id, before))
    ) {
      return fail('INVALID_INPUT', 'before 游标不属于该会话，请刷新后重试');
    }
    const rows = await chatRepo.listMessages(context.db, conversation.id, {
      limit: limit + 1,
      ...(before === undefined ? {} : { before }),
    });
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(1) : rows;
    const runMetrics = (
      await chatRepo.listRunMetrics(context.db, [
        ...new Set(messages.flatMap((message) => (message.runId ? [message.runId] : []))),
      ])
    ).map((run) => ({
      runId: run.id,
      status: run.status,
      turns: run.turns,
      durationMs: run.latencyMs,
      tokens:
        run.inputTokens === null && run.outputTokens === null
          ? null
          : (run.inputTokens ?? 0) + (run.outputTokens ?? 0),
      costUsd: run.costUsd === null ? null : Number(run.costUsd),
      error: run.error,
      endedAt: run.endedAt?.toISOString() ?? null,
    }));
    return {
      conversation: {
        id: conversation.id,
        agentId: conversation.agentId,
        title: conversation.title,
        createdAt: conversation.createdAt.toISOString(),
      },
      messages: messages.map((message) => ({
        id: message.id,
        conversationId: message.conversationId,
        role: message.role,
        content: message.content,
        runId: message.runId,
        createdAt: message.createdAt.toISOString(),
        uiFormat: message.uiFormat as 'markdown' | 'openui',
        uiProgram: message.uiProgram,
        uiState: message.uiState,
      })),
      runMetrics,
      nextBefore: hasMore ? (messages[0]?.id ?? null) : null,
    };
  }),
  renameConversation: os.renameConversation.handler(async ({ input, context }) => {
    await loadWritableConversation(context, input.params.id);
    const conversation = await chatRepo.renameConversation(context.db, {
      id: input.params.id,
      title: input.body.title,
      access: accessFilter(context, 'conversations.update'),
    });
    if (!conversation) {
      return fail('CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
    }
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'conversation.renamed',
      target: conversation.id,
      input: { fields: ['title'] },
      status: 'ok',
      requestId: context.requestId,
    });
    return {
      id: conversation.id,
      agentId: conversation.agentId,
      title: conversation.title,
      createdAt: conversation.createdAt.toISOString(),
    };
  }),
  deleteConversation: os.deleteConversation.handler(async ({ input, context }) => {
    await loadReadableConversation(context, input.params.id);
    const deleted = await deleteConversationWithSandboxes({
      client: context.client,
      redisUrl: context.config.REDIS_URL,
      deletion: {
        id: input.params.id,
        access: accessFilter(context, 'conversations.delete'),
      },
    });
    if (deleted === null) {
      return fail('CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
    }
    const agent = { slug: deleted.agentSlug };
    await Promise.all([
      rm(join(context.config.WORKSPACES_DIR, agent.slug, 'sdk-sessions', deleted.id), {
        recursive: true,
        force: true,
      }).catch((err: unknown) => {
        context.log.warn({ err, conversationId: deleted.id }, 'sdk session cleanup failed');
      }),
      rm(join(context.config.WORKSPACES_DIR, agent.slug, 'session-sandboxes', deleted.id), {
        recursive: true,
        force: true,
      }).catch((err: unknown) => {
        context.log.warn({ err, conversationId: deleted.id }, 'session sandbox cleanup failed');
      }),
      removeConversationOutputs({
        root: context.config.WORKSPACES_DIR,
        slug: agent.slug,
        conversationId: deleted.id,
      }).catch((err: unknown) => {
        context.log.warn({ err, conversationId: deleted.id }, 'output cleanup failed');
      }),
      removeConversationInputs({
        root: context.config.WORKSPACES_DIR,
        slug: agent.slug,
        conversationId: deleted.id,
      }).catch((err: unknown) => {
        context.log.warn({ err, conversationId: deleted.id }, 'input cleanup failed');
      }),
    ]);
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'conversation.deleted',
      target: input.params.id,
      input: { fields: [] },
      status: 'ok',
      requestId: context.requestId,
    });
    return undefined;
  }),
  cancelRun: os.cancelRun.handler(async ({ input, context }) => {
    const { runId } = input.params;
    const run = await chatRepo.getRun(context.db, runId);
    if (!run) {
      return fail('RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新后重试');
    }
    if (run.channelId !== null) {
      return fail('RUN_NOT_FOUND', '运行记录不存在，可能已被清理；请刷新后重试');
    }
    await authorizeObject(
      context,
      'runs.cancel',
      { objectId: run.id, createdBy: run.initiatedBy, privateContent: true },
      RUN_MISSING,
    );
    if (terminalRunEvent(run) === null && (await cancelAgentRun(context, runId)) !== null) {
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'agent.run.cancelled',
        target: runId,
        status: 'ok',
        requestId: context.requestId,
      });
    }
    return { ok: true };
  }),
  branchConversation: os.branchConversation.handler(async ({ input, context }) => {
    await loadReadableConversation(context, input.params.id);
    const principal = requireUser(context);
    await authorize(context, 'conversations.create', {
      createdBy: principal.businessId,
    });
    const result = await chatRepo.branchConversation(context.db, {
      id: newId('conversation'),
      conversationId: input.params.id,
      subject: { kind: 'user', businessId: principal.businessId },
      ...(input.body.fromMessageId === undefined
        ? {}
        : { fromMessageId: input.body.fromMessageId }),
    });
    if (!result) {
      return fail('CONVERSATION_NOT_FOUND', '会话或分支点不存在，可能已被删除；请刷新后重试');
    }
    const [agent] = await context.db
      .select({ slug: schema.agents.slug })
      .from(schema.agents)
      .where(eq(schema.agents.id, result.conversation.agentId))
      .limit(1);
    const sessionsRoot = agent
      ? join(context.config.WORKSPACES_DIR, agent.slug, 'sdk-sessions')
      : null;
    const sourceDir = sessionsRoot === null ? null : join(sessionsRoot, input.params.id);
    const targetDir = sessionsRoot === null ? null : join(sessionsRoot, result.conversation.id);
    const rollback = async (reason: string, err: unknown): Promise<void> => {
      context.log.warn({ err, conversationId: result.conversation.id }, reason);
      const compensated = await deleteCreatedConversation(
        context,
        result.conversation.id,
        principal.businessId,
      ).catch((compensationErr: unknown) => {
        context.log.warn(
          { err: compensationErr, conversationId: result.conversation.id },
          'branch rollback deletion failed; keeping runtime files',
        );
        return null;
      });
      if (compensated === null) return;
      if (targetDir !== null) {
        await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (agent !== undefined) {
        await removeConversationOutputs({
          root: context.config.WORKSPACES_DIR,
          slug: agent.slug,
          conversationId: result.conversation.id,
        }).catch(() => undefined);
        await removeConversationInputs({
          root: context.config.WORKSPACES_DIR,
          slug: agent.slug,
          conversationId: result.conversation.id,
        }).catch(() => undefined);
      }
    };
    if (sourceDir !== null && targetDir !== null && result.copied > 0) {
      try {
        await cp(sourceDir, targetDir, { recursive: true, force: true });
      } catch (err) {
        await rollback('sdk session copy failed', err);
        return fail('CONFLICT', '该会话的 SDK 会话记录不可用，无法按历史点分支；请重新对话后再试');
      }
    }
    if (agent !== undefined) {
      try {
        await copyConversationOutputs({
          root: context.config.WORKSPACES_DIR,
          slug: agent.slug,
          sourceConversationId: input.params.id,
          targetConversationId: result.conversation.id,
          messageIds: result.messageIds,
        });
      } catch (err) {
        await rollback('conversation output copy failed', err);
        return fail('CONFLICT', '该会话的历史成果不可用，无法按历史点分支；请稍后重试');
      }
      try {
        const attachmentIds = await chatRepo.attachmentIdsForMessages(
          context.db,
          Object.keys(result.messageIds),
        );
        if (attachmentIds.length > 0) {
          await copyConversationInputs({
            root: context.config.WORKSPACES_DIR,
            slug: agent.slug,
            sourceConversationId: input.params.id,
            targetConversationId: result.conversation.id,
            attachmentIds,
          });
        }
      } catch (err) {
        await rollback('conversation input copy failed', err);
        return fail('CONFLICT', '该会话的历史附件不可用，无法按历史点分支；请稍后重试');
      }
    }
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'conversation.branched',
      target: result.conversation.id,
      input: { source: input.params.id, fromMessageId: input.body.fromMessageId ?? null },
      status: 'ok',
      requestId: context.requestId,
    });
    return {
      id: result.conversation.id,
      agentId: result.conversation.agentId,
      title: result.conversation.title,
      createdAt: result.conversation.createdAt.toISOString(),
      parentId: result.conversation.parentId,
      branchOfMessageId: result.conversation.branchOfMessageId,
    };
  }),
  listConversations: os.listConversations.handler(async ({ input, context }) => {
    const { agentId, limit } = input.query;
    const rows = await chatRepo.listConversations(context.db, {
      ...(agentId === undefined ? {} : { agentId }),
      limit,
      access: accessFilter(context, 'conversations.read'),
    });
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastMessage: row.lastMessage && {
        ...row.lastMessage,
        createdAt: row.lastMessage.createdAt.toISOString(),
      },
    }));
  }),
};
export function registerChatEventsHttp(app: Hono<HttpEnv>, deps: NativeHttpDependencies): void {
  app.get(
    '/api/chat/:runId/events',
    access({ kind: 'permission', permissionId: 'runs.read' }),
    async (c) => {
      const context = requestContext(c);
      const input = parseRequest(c, z.object({ params: z.object({ runId: z.string().min(1) }) }));
      const { runId } = input.params;
      const run = await authorizeRun(context, runId, 'runs.read');
      beginSse(c, deps.timeout);
      return streamSSE(c, async (stream) => {
        await relayRunEvents({
          stream,
          signal: c.req.raw.signal,
          runId,
          initialRun: run,
          log: context.log,
          domain: {
            load: async () => {
              const current = await chatRepo.getRun(context.db, runId);
              if (current === null) return { kind: 'unavailable', reason: 'missing' };
              if (!hasPlatformScope(context, 'runs.read')) {
                try {
                  await authorize(context, 'runs.read', {
                    objectId: current.id,
                    createdBy: current.initiatedBy,
                    privateContent: true,
                  });
                } catch {
                  return { kind: 'unavailable', reason: 'forbidden' };
                }
              }
              return { kind: 'run', run: current };
            },
            writeUnavailable: async (reason) => {
              const message =
                reason === 'missing'
                  ? '运行记录已不存在，已停止接收。'
                  : '当前账户已无权读取该运行，已停止接收。';
              try {
                await writeChatEvent(stream, { type: 'run_unavailable', message });
              } catch (err) {
                context.log.warn(
                  reason === 'missing' ? { runId } : { err, runId },
                  reason === 'missing'
                    ? 'sse run unavailable write failed'
                    : 'sse access recheck write failed',
                );
              }
            },
            labels: {
              recheckFailed: 'sse terminal recheck failed',
              writeFailed: 'sse write failed',
              subscribeFailed: 'sse subscribe failed',
            },
          },
        });
      });
    },
  );
}

export const chatRouter = {
  ...chatMainRouter,
  ...chatStateRouter,
  ...chatToolsRouter,
  ...chatOutputsRouter,
};
