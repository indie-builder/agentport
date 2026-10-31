import { listOutputFiles, readOutputFile } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import {
  type ErrorCode,
  type OpenUiAction,
  type OutputRef,
  outputOwnerIdSchema,
  outputPathSchema,
} from '@agentport/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { authorizeObject } from '../access.js';
import { openUiActionContent } from './openui-actions.js';

/** 正文预览上限：超过只提供原件下载，绝不截断后冒充完整文本。 */
export const PREVIEW_MAX_BYTES = 1024 * 1024;

const ownerParams = z.object({ id: outputOwnerIdSchema });
const fileParams = z.object({ id: outputOwnerIdSchema, runId: outputOwnerIdSchema });
const fileQuery = z.object({ path: outputPathSchema });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().min(1).optional(),
});

/** 只有这些类型按文本源码预览；HTML/SVG 也走静态文本，永远不作为同源文档执行。 */
export function isTextPreview(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'image/svg+xml'
  );
}

/** 二进制与非法 UTF-8 不伪造成文本；返回 null 表示不能预览。 */
export function decodeUtf8(data: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

function conversationNotFound(reply: FastifyReply) {
  return reject(reply, 'CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请从会话列表重新打开');
}

/** 成果与附件同属会话私有正文：只对本人 O 或对应叶 P 开放。 */
async function loadConversation(app: FastifyInstance, request: FastifyRequest, id: string) {
  const conversation = await repo.chat.getConversation(app.db, id);
  if (!conversation) {
    throw new AppError('CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请从会话列表重新打开');
  }
  await authorizeObject(
    app,
    request,
    'conversations.read',
    { objectId: conversation.id, createdBy: conversation.createdBy, privateContent: true },
    '会话不存在，可能已被删除；请从会话列表重新打开',
  );
  return conversation;
}

/** 会话所属智能体的工作区目录名；会话行存在时一定找得到（外键级联删除）。 */
export async function agentSlug(app: FastifyInstance, agentId: string): Promise<string | null> {
  const [row] = await app.db
    .select({ slug: schema.agents.slug })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  return row?.slug ?? null;
}

/**
 * 会话/成果不存在时 core 抛 NOT_FOUND；对入口来说这是「选择无效」，
 * 换成 INVALID_INPUT 告诉用户刷新列表，而不是暗示会话不见了。
 */
function selectionProblem(err: unknown): { code: ErrorCode; message: string } | null {
  if (!isAppError(err)) return null;
  if (err.code === 'NOT_FOUND') {
    return { code: 'INVALID_INPUT', message: '所选成果不存在或不属于该会话；请刷新成果列表后重试' };
  }
  if (err.code === 'INVALID_INPUT') {
    return { code: 'INVALID_INPUT', message: '所选成果路径不合法；请刷新成果列表后重试' };
  }
  return null;
}

export interface OutputSelection {
  conversationId: string | undefined;
  output: OutputRef;
}

/**
 * 「基于此版本修改」的归属校验：必须先有会话，且该版本确实属于这个会话。
 * 返回非空表示拒绝，交给入口统一渲染 Problem。
 */
export async function checkOutputSelection(
  app: FastifyInstance,
  input: OutputSelection,
): Promise<{ code: ErrorCode; message: string } | null> {
  if (input.conversationId === undefined) {
    return { code: 'INVALID_INPUT', message: '选择已发布成果前，需要先在对应会话里继续' };
  }
  const conversation = await repo.chat.getConversation(app.db, input.conversationId);
  if (!conversation) {
    return {
      code: 'CONVERSATION_NOT_FOUND',
      message: '会话不存在，可能已被删除；请从会话列表重新打开',
    };
  }
  const slug = await agentSlug(app, conversation.agentId);
  if (slug === null) {
    return {
      code: 'CONVERSATION_NOT_FOUND',
      message: '会话不存在，可能已被删除；请从会话列表重新打开',
    };
  }
  try {
    // 用读取校验 manifest 成员身份：core 目前没有只查索引的入口。
    // shortcut: 会整份读入所选文件；输出通常很小，等 core 提供 manifest 级查询再换成只读索引。
    await readOutputFile({
      root: app.config.WORKSPACES_DIR,
      slug,
      conversationId: conversation.id,
      runId: input.output.runId,
      path: input.output.path,
    });
    return null;
  } catch (err) {
    const problem = selectionProblem(err);
    if (problem !== null) return problem;
    throw err;
  }
}

/** 用户消息内容：保留原有 OpenUI 动作片段，在其文本段上追加所选成果。 */
export function outputUserContent(input: {
  text: string;
  output: OutputRef;
  openuiAction?: OpenUiAction;
}): unknown {
  if (input.openuiAction === undefined) {
    return { type: 'text', text: input.text, output: input.output };
  }
  const parts = openUiActionContent(input.openuiAction) as Array<Record<string, unknown>>;
  const [first, ...rest] = parts;
  return [{ ...first, output: input.output }, ...rest];
}

/** RFC 5987 文件名：ASCII 回退 + UTF-8 原名，换行等控制字符被编码，不能注入响应头。 */
export function contentDisposition(path: string): string {
  const name = path.split('/').at(-1) ?? 'download';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** 只用常见的 `type/subtype` 原样回写；其余一律按二进制，避免奇怪声明进入响应头。 */
export function safeMediaType(mediaType: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mediaType)
    ? mediaType
    : 'application/octet-stream';
}

export function registerOutputRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = {
    config: { access: { kind: 'permission', permissionId: 'conversations.read' } as const },
  };

  app.get(
    '/api/conversations/:id/outputs',
    { ...auth, schema: { params: ownerParams, querystring: listQuery } },
    async (request, reply) => {
      const conversation = await loadConversation(app, request, request.params.id);
      const slug = await agentSlug(app, conversation.agentId);
      if (slug === null) return { items: [], nextBefore: null };
      const { limit, before } = request.query;
      // 游标由 core 解释；格式不合法说明调用方拼错，直接按 400 拒绝。
      try {
        return await listOutputFiles({
          root: app.config.WORKSPACES_DIR,
          slug,
          conversationId: conversation.id,
          limit,
          ...(before === undefined ? {} : { before }),
        });
      } catch (err) {
        // 只有携带游标时才把 INVALID_INPUT 解释成游标问题；manifest 损坏要保留自己的说明。
        if (before !== undefined && isAppError(err) && err.code === 'INVALID_INPUT') {
          return reject(reply, 'INVALID_INPUT', 'before 游标无效，请刷新成果列表后重试');
        }
        throw err;
      }
    },
  );

  // 列表只返回每版变化的文件；按版本精确读取元数据，供分页外的图片等预览使用。
  app.get(
    '/api/conversations/:id/outputs/:runId',
    { ...auth, schema: { params: fileParams, querystring: fileQuery } },
    async (request, reply) => {
      const conversation = await loadConversation(app, request, request.params.id);
      const slug = await agentSlug(app, conversation.agentId);
      if (slug === null) return reject(reply, 'NOT_FOUND', '成果文件不存在，可能已被清理');
      try {
        const { file } = await readOutputFile({
          root: app.config.WORKSPACES_DIR,
          slug,
          conversationId: conversation.id,
          runId: request.params.runId,
          path: request.query.path,
        });
        return { file };
      } catch (err) {
        const problem = selectionProblem(err);
        if (problem !== null) return reject(reply, problem.code, problem.message);
        throw err;
      }
    },
  );

  app.get(
    '/api/conversations/:id/outputs/:runId/content',
    { ...auth, schema: { params: fileParams, querystring: fileQuery } },
    async (request, reply) => {
      const conversation = await loadConversation(app, request, request.params.id);
      const slug = await agentSlug(app, conversation.agentId);
      if (slug === null) return reject(reply, 'NOT_FOUND', '成果文件不存在，可能已被清理');
      const { file, data } = await readOutputFile({
        root: app.config.WORKSPACES_DIR,
        slug,
        conversationId: conversation.id,
        runId: request.params.runId,
        path: request.query.path,
      });
      if (data.length > PREVIEW_MAX_BYTES) {
        return reject(reply, 'PAYLOAD_TOO_LARGE', '文件超过 1MiB，请下载原件查看');
      }
      if (!isTextPreview(file.mediaType)) {
        return reject(reply, 'UNSUPPORTED_MEDIA_TYPE', '该文件不能直接预览，请下载原件');
      }
      const content = decodeUtf8(data);
      if (content === null) {
        return reject(reply, 'UNSUPPORTED_MEDIA_TYPE', '该文件不是有效的 UTF-8 文本，请下载原件');
      }
      return { file, content };
    },
  );

  app.get(
    '/api/conversations/:id/outputs/:runId/download',
    { ...auth, schema: { params: fileParams, querystring: fileQuery } },
    async (request, reply) => {
      const conversation = await loadConversation(app, request, request.params.id);
      const slug = await agentSlug(app, conversation.agentId);
      if (slug === null) return reject(reply, 'NOT_FOUND', '成果文件不存在，可能已被清理');
      const { file, data } = await readOutputFile({
        root: app.config.WORKSPACES_DIR,
        slug,
        conversationId: conversation.id,
        runId: request.params.runId,
        path: request.query.path,
      });
      // 一律 attachment + no-store + nosniff：HTML/SVG 不会作为同源文档执行。
      return reply
        .header('Content-Type', safeMediaType(file.mediaType))
        .header('Content-Disposition', contentDisposition(file.path))
        .header('Cache-Control', 'no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .send(data);
    },
  );
}
