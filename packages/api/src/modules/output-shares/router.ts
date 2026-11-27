import { outputSharesContract } from '@agentport/contract/output-shares';
import { encryptSecrets, fail, isAppError, notFound, sha256Hex } from '@agentport/core';
import { repo } from '@agentport/db';
import type { OutputFile, PublicOutputShare } from '@agentport/shared';
import { implement } from '@orpc/server';
import { authorizeObject } from '../../http/access.js';
import { actorOf, type RequestContext } from '../../http/context.js';
import {
  OUTPUT_MISSING_MESSAGE,
  previewText,
  readWorkspaceOutput,
  SHARE_MISSING_MESSAGE,
} from '../../lib/outputs.js';
import { CONVERSATION_MISSING } from '../chat/access.js';
import { auditShareRevoked, resolveSharedFile, toOutputShare } from './shared.js';

const os = implement(outputSharesContract).$context<RequestContext>();

function publicFile(file: OutputFile, sha256: string): PublicOutputShare['file'] {
  return {
    name: file.path.split('/').at(-1) ?? 'download',
    size: file.size,
    mediaType: file.mediaType,
    sha256,
    createdAt: file.createdAt,
  };
}

async function requireShareableConversation(context: RequestContext, id: string) {
  const conversation = await repo.chat.getConversation(context.db, id);
  if (!conversation) notFound('conversation');
  await authorizeObject(
    context,
    'conversations.share',
    {
      objectId: conversation.id,
      createdBy: conversation.createdBy,
      privateContent: true,
    },
    CONVERSATION_MISSING,
  );
  return conversation;
}

export const outputSharesRouter = os.router({
  create: os.create.handler(async ({ input, context }) => {
    const conversation = await requireShareableConversation(context, input.params.id);
    if (await repo.chat.isConversationDataDomainRestricted(context.db, conversation.id)) {
      fail('FORBIDDEN', '该会话读取过数据域治理数据，其成果不支持公开分享');
    }
    const slug = await repo.agents.findAgentSlug(context.db, conversation.agentId);
    if (slug === null) fail('NOT_FOUND', OUTPUT_MISSING_MESSAGE);

    let file: OutputFile;
    let data: Buffer;
    try {
      ({ file, data } = await readWorkspaceOutput(context, {
        slug,
        conversationId: conversation.id,
        runId: input.body.runId,
        path: input.body.path,
      }));
    } catch (err) {
      if (isAppError(err) && (err.code === 'NOT_FOUND' || err.code === 'INVALID_INPUT')) {
        fail('INVALID_INPUT', '所选成果不存在或不属于该会话；请刷新成果列表后重试');
      }
      throw err;
    }

    if (sha256Hex(data) !== file.sha256) {
      fail('CONFLICT', '成果文件内容与快照记录不一致，请重新发布后再分享');
    }

    const existing = await repo.outputShares.findByTriple(
      context.db,
      conversation.id,
      input.body.runId,
      input.body.path,
    );
    if (existing !== null && existing.sha256 === file.sha256) {
      return await toOutputShare(existing, context);
    }

    const token = crypto
      .getRandomValues(new Uint8Array(32))
      .toBase64({ alphabet: 'base64url', omitPadding: true });
    const row = await repo.outputShares.create(context.db, {
      conversationId: conversation.id,
      runId: input.body.runId,
      path: input.body.path,
      sha256: file.sha256,
      tokenHash: sha256Hex(token),
      tokenEncrypted: await encryptSecrets({ token }, context.config.APP_SECRET_KEY),
    });
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'share.created',
      target: row.id,
      input: { conversationId: conversation.id, runId: row.runId, path: row.path },
      status: 'ok',
      requestId: context.requestId,
    });
    return await toOutputShare(row, context);
  }),

  list: os.list.handler(async ({ input, context }) => {
    const conversation = await requireShareableConversation(context, input.params.id);
    const rows = await repo.outputShares.listByTriple(
      context.db,
      conversation.id,
      input.query.runId,
      input.query.path,
    );
    return {
      items: await Promise.all(rows.map(async (row) => toOutputShare(row, context))),
    };
  }),

  revoke: os.revoke.handler(async ({ input, context }) => {
    const active = await repo.outputShares.findActiveById(context.db, input.params.id);
    if (active !== null) {
      const conversation = await repo.chat.getConversation(context.db, active.conversationId);
      if (!conversation) fail('NOT_FOUND', SHARE_MISSING_MESSAGE);
      await authorizeObject(
        context,
        'conversations.share',
        {
          objectId: active.id,
          createdBy: conversation.createdBy,
          privateContent: true,
        },
        SHARE_MISSING_MESSAGE,
      );
    }
    const row = await repo.outputShares.revoke(context.db, input.params.id);
    if (row !== null) {
      await auditShareRevoked(context, row);
    }
    return undefined;
  }),

  publicMetadata: os.publicMetadata.handler(async ({ input, context }) => {
    context.responseHeaders.set('cache-control', 'no-store');
    const shared = await resolveSharedFile(context, input.params.id);
    if (shared === null) fail('NOT_FOUND', SHARE_MISSING_MESSAGE);
    return { file: publicFile(shared.file, shared.row.sha256) };
  }),

  publicContent: os.publicContent.handler(async ({ input, context }) => {
    context.responseHeaders.set('cache-control', 'no-store');
    const shared = await resolveSharedFile(context, input.params.id);
    if (shared === null) fail('NOT_FOUND', SHARE_MISSING_MESSAGE);
    const preview = previewText(shared.data, shared.file.mediaType);
    if (!preview.ok) fail(preview.code, preview.message);
    return { file: publicFile(shared.file, shared.row.sha256), content: preview.content };
  }),
});
