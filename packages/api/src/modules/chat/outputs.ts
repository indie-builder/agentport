import { chatContract } from '@agentport/contract/chat';
import { fail, listOutputFiles, readOutputFile } from '@agentport/core';
import { repo, schema } from '@agentport/db';
import {
  type ErrorCode,
  type OpenUiAction,
  type OutputRef,
  outputContentSchema,
  outputOwnerIdSchema,
  outputPathSchema,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import { eq } from 'drizzle-orm';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppContext, HttpContext, HttpEnv, RequestContext } from '../../http/context.js';
import { requestContext } from '../../http/context.js';
import { isAppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import { CONVERSATION_MISSING, loadReadableConversation } from './access.js';
import { openUiActionContent } from './openui-actions.js';
export const PREVIEW_MAX_BYTES = 1024 * 1024;
export function isTextPreview(mediaType: string): boolean {
  return (
    mediaType.startsWith('text/') ||
    mediaType === 'application/json' ||
    mediaType === 'image/svg+xml'
  );
}
export function decodeUtf8(data: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}
export async function agentSlug(
  context: Pick<AppContext, 'db'>,
  agentId: string,
): Promise<string | null> {
  const [row] = await context.db
    .select({ slug: schema.agents.slug })
    .from(schema.agents)
    .where(eq(schema.agents.id, agentId))
    .limit(1);
  return row?.slug ?? null;
}
function selectionProblem(err: unknown): {
  code: ErrorCode;
  message: string;
} | null {
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
export async function checkOutputSelection(
  context: Pick<AppContext, 'db' | 'config'>,
  input: OutputSelection,
): Promise<{
  code: ErrorCode;
  message: string;
} | null> {
  if (input.conversationId === undefined) {
    return { code: 'INVALID_INPUT', message: '选择已发布成果前，需要先在对应会话里继续' };
  }
  const conversation = await repo.chat.getConversation(context.db, input.conversationId);
  if (!conversation) {
    return {
      code: 'CONVERSATION_NOT_FOUND',
      message: CONVERSATION_MISSING,
    };
  }
  const slug = await agentSlug(context, conversation.agentId);
  if (slug === null) {
    return {
      code: 'CONVERSATION_NOT_FOUND',
      message: CONVERSATION_MISSING,
    };
  }
  try {
    await readOutputFile({
      root: context.config.WORKSPACES_DIR,
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
export function contentDisposition(path: string): string {
  const name = path.split('/').at(-1) ?? 'download';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
export function safeMediaType(mediaType: string): string {
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(mediaType)
    ? mediaType
    : 'application/octet-stream';
}
const os = implement(chatContract).$context<RequestContext>();
export const chatOutputsRouter = {
  listOutputs: os.listOutputs.handler(async ({ input, context }) => {
    const conversation = await loadReadableConversation(context, input.params.id);
    const slug = await agentSlug(context, conversation.agentId);
    if (slug === null) return { items: [], nextBefore: null };
    const { limit, before } = input.query;
    try {
      return await listOutputFiles({
        root: context.config.WORKSPACES_DIR,
        slug,
        conversationId: conversation.id,
        limit,
        ...(before === undefined ? {} : { before }),
      });
    } catch (err) {
      if (before !== undefined && isAppError(err) && err.code === 'INVALID_INPUT') {
        return fail('INVALID_INPUT', 'before 游标无效，请刷新成果列表后重试');
      }
      throw err;
    }
  }),
  output: os.output.handler(async ({ input, context }) => {
    const conversation = await loadReadableConversation(context, input.params.id);
    const slug = await agentSlug(context, conversation.agentId);
    if (slug === null) return fail('NOT_FOUND', '成果文件不存在，可能已被清理');
    try {
      const { file } = await readOutputFile({
        root: context.config.WORKSPACES_DIR,
        slug,
        conversationId: conversation.id,
        runId: input.params.runId,
        path: input.query.path,
      });
      return { file };
    } catch (err) {
      const problem = selectionProblem(err);
      if (problem !== null) return fail(problem.code, problem.message);
      throw err;
    }
  }),
};
async function readRequestedOutput(c: HttpContext) {
  const context = requestContext(c);
  const input = z
    .object({
      params: z.object({ id: outputOwnerIdSchema, runId: outputOwnerIdSchema }),
      query: z.object({ path: outputPathSchema }),
    })
    .parse({ params: c.req.param(), query: c.req.query() });
  const conversation = await loadReadableConversation(context, input.params.id);
  const slug = await agentSlug(context, conversation.agentId);
  if (slug === null) fail('NOT_FOUND', '成果文件不存在，可能已被清理');
  return readOutputFile({
    root: context.config.WORKSPACES_DIR,
    slug,
    conversationId: conversation.id,
    runId: input.params.runId,
    path: input.query.path,
  });
}

export function registerChatOutputsHttp(app: Hono<HttpEnv>): void {
  app.get(
    '/api/conversations/:id/outputs/:runId/content',
    access({ kind: 'permission', permissionId: 'conversations.read' }),
    async (c) => {
      const { file, data } = await readRequestedOutput(c);
      if (data.length > PREVIEW_MAX_BYTES) {
        return fail('PAYLOAD_TOO_LARGE', '文件超过 1MiB，请下载原件查看');
      }
      if (!isTextPreview(file.mediaType)) {
        return fail('UNSUPPORTED_MEDIA_TYPE', '该文件不能直接预览，请下载原件');
      }
      const content = decodeUtf8(data);
      if (content === null) {
        return fail('UNSUPPORTED_MEDIA_TYPE', '该文件不是有效的 UTF-8 文本，请下载原件');
      }
      return c.json(outputContentSchema.parse({ file, content }));
    },
  );
  app.get(
    '/api/conversations/:id/outputs/:runId/download',
    access({ kind: 'permission', permissionId: 'conversations.read' }),
    async (c) => {
      const { file, data } = await readRequestedOutput(c);
      c.header('Content-Type', safeMediaType(file.mediaType));
      c.header('Content-Disposition', contentDisposition(file.path));
      c.header('Cache-Control', 'no-store');
      c.header('X-Content-Type-Options', 'nosniff');
      return c.body(new Uint8Array(data));
    },
  );
}
