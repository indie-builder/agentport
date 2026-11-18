import { chatContract } from '@agentport/contract/chat';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  type ErrorCode,
  type OutputRef,
  outputContentSchema,
  outputOwnerIdSchema,
  outputPathSchema,
} from '@agentport/shared';
import { implement } from '@orpc/server';
import type { Hono } from 'hono';
import { z } from 'zod';
import { attachmentResponse } from '../../http/attachment.js';
import type { AppContext, HttpContext, HttpEnv, RequestContext } from '../../http/context.js';
import { parseRequest, requestContext } from '../../http/context.js';
import { isAppError } from '../../http/errors.js';
import { access } from '../../http/middleware.js';
import {
  agentSlug,
  listWorkspaceOutputs,
  previewText,
  readWorkspaceOutput,
  safeMediaType,
} from '../../lib/outputs.js';
import { CONVERSATION_MISSING, loadReadableConversation } from './access.js';

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
  resource?: string;
} | null> {
  if (input.conversationId === undefined) {
    return { code: 'INVALID_INPUT', message: '选择已发布成果前，需要先在对应会话里继续' };
  }
  const conversation = await repo.chat.getConversation(context.db, input.conversationId);
  if (!conversation)
    return { code: 'NOT_FOUND', message: CONVERSATION_MISSING, resource: 'conversation' };
  const slug = await agentSlug(context.db, conversation.agentId);
  if (slug === null)
    return { code: 'NOT_FOUND', message: CONVERSATION_MISSING, resource: 'conversation' };
  try {
    await readWorkspaceOutput(context, {
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
const os = implement(chatContract).$context<RequestContext>();
export const chatOutputsRouter = {
  listOutputs: os.listOutputs.handler(async ({ input, context }) => {
    const conversation = await loadReadableConversation(context, input.params.id);
    const slug = await agentSlug(context.db, conversation.agentId);
    if (slug === null) return { items: [], nextCursor: null };
    const { limit, cursor, runId } = input.query;
    try {
      return await listWorkspaceOutputs(context, {
        slug,
        conversationId: conversation.id,
        limit,
        ...(cursor === undefined ? {} : { before: cursor }),
        ...(runId === undefined ? {} : { runId }),
      });
    } catch (err) {
      if (cursor !== undefined && isAppError(err) && err.code === 'INVALID_INPUT') {
        return fail('INVALID_INPUT', '游标无效，请刷新成果列表后重试');
      }
      throw err;
    }
  }),
  output: os.output.handler(async ({ input, context }) => {
    const conversation = await loadReadableConversation(context, input.params.id);
    const slug = await agentSlug(context.db, conversation.agentId);
    if (slug === null) return fail('NOT_FOUND', '成果文件不存在，可能已被清理');
    try {
      const { file } = await readWorkspaceOutput(context, {
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
  const input = parseRequest(
    c,
    z.object({
      params: z.object({ id: outputOwnerIdSchema, runId: outputOwnerIdSchema }),
      query: z.object({ path: outputPathSchema }),
    }),
  );
  const conversation = await loadReadableConversation(context, input.params.id);
  const slug = await agentSlug(context.db, conversation.agentId);
  if (slug === null) fail('NOT_FOUND', '成果文件不存在，可能已被清理');
  return readWorkspaceOutput(context, {
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
      const preview = previewText(data, file.mediaType);
      if (!preview.ok) fail(preview.code, preview.message);
      return c.json(outputContentSchema.parse({ file, content: preview.content }));
    },
  );
  app.get(
    '/api/conversations/:id/outputs/:runId/download',
    access({ kind: 'permission', permissionId: 'conversations.read' }),
    async (c) => {
      const { file, data } = await readRequestedOutput(c);
      return attachmentResponse(new Uint8Array(data), file.path, safeMediaType(file.mediaType));
    },
  );
}
