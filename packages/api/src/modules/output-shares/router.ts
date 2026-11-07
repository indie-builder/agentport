import { randomBytes } from 'node:crypto';
import { outputSharesContract } from '@agentport/contract/output-shares';
import {
  decryptSecrets,
  encryptSecrets,
  fail,
  isAppError,
  readOutputFile,
  sha256Hex,
} from '@agentport/core';
import { repo } from '@agentport/db';
import type { OutputFile, OutputShare, PublicOutputShare } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, authorizeObject } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { agentSlug, decodeUtf8, isTextPreview, PREVIEW_MAX_BYTES } from '../chat/outputs.js';
import { bearerToken, tokenMatches } from '../servers/bearer.js';

const os = implement(outputSharesContract).$context<RequestContext>();

type OutputShareRow = repo.outputShares.OutputShareRow;

const CONVERSATION_MISSING = '会话不存在，可能已被删除；请从会话列表重新打开';
const SHARE_MISSING = '分享不存在或已失效';

export function toOutputShare(
  row: Pick<
    OutputShareRow,
    'id' | 'runId' | 'path' | 'sha256' | 'createdAt' | 'revokedAt' | 'tokenEncrypted'
  >,
  context: RequestContext,
): OutputShare {
  return {
    id: row.id,
    runId: row.runId,
    path: row.path,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    urlPath: `/s/${row.id}#${decryptSecrets(row.tokenEncrypted, context.config.APP_SECRET_KEY).token}`,
  };
}

function publicFile(file: OutputFile, sha256: string): PublicOutputShare['file'] {
  return {
    name: file.path.split('/').at(-1) ?? 'download',
    size: file.size,
    mediaType: file.mediaType,
    sha256,
    createdAt: file.createdAt,
  };
}

export async function resolveSharedFile(
  context: RequestContext,
  id: string,
): Promise<{ row: OutputShareRow; file: OutputFile; data: Buffer } | null> {
  const token = bearerToken(context.request.headers.get('authorization') ?? undefined);
  if (token === undefined) return null;
  const row = await repo.outputShares.findActiveById(context.db, id);
  if (row === null || !tokenMatches(row.tokenHash, token, sha256Hex)) return null;

  const conversation = await repo.chat.getConversation(context.db, row.conversationId);
  if (!conversation) return null;
  const slug = await agentSlug(context, conversation.agentId);
  if (slug === null) return null;

  try {
    const { file, data } = await readOutputFile({
      root: context.config.WORKSPACES_DIR,
      slug,
      conversationId: conversation.id,
      runId: row.runId,
      path: row.path,
    });
    return file.sha256 === row.sha256 && sha256Hex(data) === row.sha256
      ? { row, file, data }
      : null;
  } catch (err) {
    if (isAppError(err)) return null;
    throw err;
  }
}

export const outputSharesRouter = os.router({
  create: os.create.handler(async ({ input, context }) => {
    const conversation = await repo.chat.getConversation(context.db, input.params.id);
    if (!conversation) fail('CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
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
    const slug = await agentSlug(context, conversation.agentId);
    if (slug === null) fail('NOT_FOUND', '成果文件不存在，可能已被清理');

    let file: OutputFile;
    let data: Buffer;
    try {
      ({ file, data } = await readOutputFile({
        root: context.config.WORKSPACES_DIR,
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
      return toOutputShare(existing, context);
    }

    const token = randomBytes(32).toString('base64url');
    const row = await repo.outputShares.create(context.db, {
      conversationId: conversation.id,
      runId: input.body.runId,
      path: input.body.path,
      sha256: file.sha256,
      tokenHash: sha256Hex(token),
      tokenEncrypted: encryptSecrets({ token }, context.config.APP_SECRET_KEY),
    });
    await repo.audit.writeAudit(context.db, context.log, {
      actor: actorOf(context),
      action: 'share.created',
      target: row.id,
      input: { conversationId: conversation.id, runId: row.runId, path: row.path },
      status: 'ok',
      requestId: context.requestId,
    });
    return toOutputShare(row, context);
  }),

  list: os.list.handler(async ({ input, context }) => {
    const conversation = await repo.chat.getConversation(context.db, input.params.id);
    if (!conversation) fail('CONVERSATION_NOT_FOUND', CONVERSATION_MISSING);
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
    const rows = await repo.outputShares.listByTriple(
      context.db,
      conversation.id,
      input.query.runId,
      input.query.path,
    );
    return { items: rows.map((row) => toOutputShare(row, context)) };
  }),

  revoke: os.revoke.handler(async ({ input, context }) => {
    const active = await repo.outputShares.findActiveById(context.db, input.params.id);
    if (active !== null) {
      const conversation = await repo.chat.getConversation(context.db, active.conversationId);
      if (!conversation) fail('NOT_FOUND', SHARE_MISSING);
      await authorizeObject(
        context,
        'conversations.share',
        {
          objectId: active.id,
          createdBy: conversation.createdBy,
          privateContent: true,
        },
        SHARE_MISSING,
      );
    }
    const row = await repo.outputShares.revoke(context.db, input.params.id);
    if (row !== null) {
      await repo.audit.writeAudit(context.db, context.log, {
        actor: actorOf(context),
        action: 'share.revoked',
        target: row.id,
        input: { conversationId: row.conversationId, runId: row.runId, path: row.path },
        status: 'ok',
        requestId: context.requestId,
      });
    }
    return undefined;
  }),

  publicMetadata: os.publicMetadata.handler(async ({ input, context }) => {
    context.responseHeaders.set('cache-control', 'no-store');
    const shared = await resolveSharedFile(context, input.params.id);
    if (shared === null) fail('NOT_FOUND', SHARE_MISSING);
    return { file: publicFile(shared.file, shared.row.sha256) };
  }),

  publicContent: os.publicContent.handler(async ({ input, context }) => {
    context.responseHeaders.set('cache-control', 'no-store');
    const shared = await resolveSharedFile(context, input.params.id);
    if (shared === null) fail('NOT_FOUND', SHARE_MISSING);
    if (shared.data.length > PREVIEW_MAX_BYTES) {
      fail('PAYLOAD_TOO_LARGE', '文件超过 1MiB，请下载原件查看');
    }
    if (!isTextPreview(shared.file.mediaType)) {
      fail('UNSUPPORTED_MEDIA_TYPE', '该文件不能直接预览，请下载原件');
    }
    const content = decodeUtf8(shared.data);
    if (content === null) {
      fail('UNSUPPORTED_MEDIA_TYPE', '该文件不是有效的 UTF-8 文本，请下载原件');
    }
    return { file: publicFile(shared.file, shared.row.sha256), content };
  }),
});
