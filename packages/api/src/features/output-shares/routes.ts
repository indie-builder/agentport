import { createHash, randomBytes } from 'node:crypto';
import { decryptSecrets, encryptSecrets, readOutputFile } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  type OutputFile,
  type OutputShare,
  outputOwnerIdSchema,
  outputPathSchema,
  type PublicOutputShare,
} from '@agentport/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { isAppError, reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import {
  agentSlug,
  contentDisposition,
  decodeUtf8,
  isTextPreview,
  PREVIEW_MAX_BYTES,
  safeMediaType,
} from '../chat/outputs.js';
import { bearerToken, tokenMatches } from '../servers/bearer.js';

type OutputShareRow = repo.outputShares.OutputShareRow;

const ownerParams = z.object({ id: outputOwnerIdSchema });
const shareParams = z.object({ id: z.string().min(1).max(200) });
const tripleQuery = z.object({ runId: outputOwnerIdSchema, path: outputPathSchema });
const createBody = z.object({ runId: outputOwnerIdSchema, path: outputPathSchema });

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function conversationNotFound(reply: FastifyReply) {
  return reject(reply, 'CONVERSATION_NOT_FOUND', '会话不存在，可能已被删除；请从会话列表重新打开');
}

function toOutputShare(row: OutputShareRow, app: FastifyInstance): OutputShare {
  return {
    id: row.id,
    runId: row.runId,
    path: row.path,
    sha256: row.sha256,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    urlPath: `/s/${row.id}#${decryptSecrets(row.tokenEncrypted, app.config.APP_SECRET_KEY).token}`,
  };
}

/** 公开元数据只有文件名与内容标识；会话、运行和存储路径都不出现。 */
function publicFile(file: OutputFile, sha256: string): PublicOutputShare['file'] {
  return {
    name: file.path.split('/').at(-1) ?? 'download',
    size: file.size,
    mediaType: file.mediaType,
    sha256,
    createdAt: file.createdAt,
  };
}

function notShared(reply: FastifyReply) {
  return reject(reply, 'NOT_FOUND', '分享不存在或已失效');
}

/**
 * 分享链接的三重校验：Bearer token 命中库内哈希、分享未撤销、实际字节 sha256 与创建时一致。
 * manifest 只是索引，快照文件被直接覆盖时以重算结果为准；任何一步失败都返回 null，
 * 由调用方统一回普通 404。
 */
async function resolveSharedFile(
  app: FastifyInstance,
  id: string,
  request: FastifyRequest,
): Promise<{ row: OutputShareRow; file: OutputFile; data: Buffer } | null> {
  const token = bearerToken(request.headers.authorization);
  if (token === undefined) return null;
  const row = await repo.outputShares.findActiveById(app.db, id);
  if (row === null || !tokenMatches(row.tokenHash, token, sha256Hex)) return null;

  const conversation = await repo.chat.getConversation(app.db, row.conversationId);
  if (!conversation) return null;
  const slug = await agentSlug(app, conversation.agentId);
  if (slug === null) return null;

  try {
    const { file, data } = await readOutputFile({
      root: app.config.WORKSPACES_DIR,
      slug,
      conversationId: conversation.id,
      runId: row.runId,
      path: row.path,
    });
    // 不信任 manifest 里的哈希：按实际读出的字节重算，只有与记录一致才允许公开。
    return file.sha256 === row.sha256 && sha256Hex(data) === row.sha256
      ? { row, file, data }
      : null;
  } catch (err) {
    if (isAppError(err)) return null;
    throw err;
  }
}

export function registerOutputShareRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);
  const auth = { preHandler: [rawApp.requireAuth] };

  app.post(
    '/api/conversations/:id/output-shares',
    { ...auth, schema: { params: ownerParams, body: createBody } },
    async (request, reply) => {
      const conversation = await repo.chat.getConversation(app.db, request.params.id);
      if (!conversation) return conversationNotFound(reply);
      const slug = await agentSlug(app, conversation.agentId);
      if (slug === null) return reject(reply, 'NOT_FOUND', '成果文件不存在，可能已被清理');

      let file: OutputFile;
      let data: Buffer;
      try {
        ({ file, data } = await readOutputFile({
          root: app.config.WORKSPACES_DIR,
          slug,
          conversationId: conversation.id,
          runId: request.body.runId,
          path: request.body.path,
        }));
      } catch (err) {
        if (isAppError(err) && (err.code === 'NOT_FOUND' || err.code === 'INVALID_INPUT')) {
          return reject(
            reply,
            'INVALID_INPUT',
            '所选成果不存在或不属于该会话；请刷新成果列表后重试',
          );
        }
        throw err;
      }

      // 分享记录只能锚定真实字节：manifest 与快照内容不一致时拒绝创建，避免发出会 404 的链接。
      if (sha256Hex(data) !== file.sha256) {
        return reject(reply, 'CONFLICT', '成果文件内容与快照记录不一致，请重新发布后再分享');
      }

      // 同一三元组已有有效分享时复用，重复点击不会堆出多个可用 token。
      const existing = await repo.outputShares.findByTriple(
        app.db,
        conversation.id,
        request.body.runId,
        request.body.path,
      );
      if (existing !== null && existing.sha256 === file.sha256) {
        return reply.status(201).send(toOutputShare(existing, app));
      }

      const token = randomBytes(32).toString('base64url');
      const row = await repo.outputShares.create(app.db, {
        conversationId: conversation.id,
        runId: request.body.runId,
        path: request.body.path,
        sha256: file.sha256,
        tokenHash: sha256Hex(token),
        tokenEncrypted: encryptSecrets({ token }, app.config.APP_SECRET_KEY),
      });
      await writeAudit(app.db, request.log, {
        actor: 'admin',
        action: 'share.created',
        target: row.id,
        input: { conversationId: conversation.id, runId: row.runId, path: row.path },
        status: 'ok',
        requestId: request.id,
      });
      return reply.status(201).send(toOutputShare(row, app));
    },
  );

  app.get(
    '/api/conversations/:id/output-shares',
    { ...auth, schema: { params: ownerParams, querystring: tripleQuery } },
    async (request, reply) => {
      const conversation = await repo.chat.getConversation(app.db, request.params.id);
      if (!conversation) return conversationNotFound(reply);
      const rows = await repo.outputShares.listByTriple(
        app.db,
        conversation.id,
        request.query.runId,
        request.query.path,
      );
      return { items: rows.map((row) => toOutputShare(row, app)) };
    },
  );

  // 撤销幂等：不存在、已撤销、重复调用都回 204。
  app.delete(
    '/api/output-shares/:id',
    { ...auth, schema: { params: shareParams } },
    async (request, reply) => {
      const row = await repo.outputShares.revoke(app.db, request.params.id);
      if (row !== null) {
        await writeAudit(app.db, request.log, {
          actor: 'admin',
          action: 'share.revoked',
          target: row.id,
          input: { conversationId: row.conversationId, runId: row.runId, path: row.path },
          status: 'ok',
          requestId: request.id,
        });
      }
      return reply.status(204).send();
    },
  );

  // 公开例外：分享链接不登录即可访问。无效、撤销或来源已删除统一普通 404，不泄露存在性。
  app.get(
    '/api/public/output-shares/:id',
    { schema: { params: shareParams } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const shared = await resolveSharedFile(app, request.params.id, request);
      if (shared === null) return notShared(reply);
      return { file: publicFile(shared.file, shared.row.sha256) };
    },
  );

  app.get(
    '/api/public/output-shares/:id/content',
    { schema: { params: shareParams } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const shared = await resolveSharedFile(app, request.params.id, request);
      if (shared === null) return notShared(reply);
      if (shared.data.length > PREVIEW_MAX_BYTES) {
        return reject(reply, 'PAYLOAD_TOO_LARGE', '文件超过 1MiB，请下载原件查看');
      }
      if (!isTextPreview(shared.file.mediaType)) {
        return reject(reply, 'UNSUPPORTED_MEDIA_TYPE', '该文件不能直接预览，请下载原件');
      }
      const content = decodeUtf8(shared.data);
      if (content === null) {
        return reject(reply, 'UNSUPPORTED_MEDIA_TYPE', '该文件不是有效的 UTF-8 文本，请下载原件');
      }
      return { file: publicFile(shared.file, shared.row.sha256), content };
    },
  );

  app.get(
    '/api/public/output-shares/:id/download',
    { schema: { params: shareParams } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const shared = await resolveSharedFile(app, request.params.id, request);
      if (shared === null) return notShared(reply);
      // 与登录下载同一策略：一律 attachment + no-store + nosniff，HTML/SVG 不在本站执行。
      return reply
        .header('content-type', safeMediaType(shared.file.mediaType))
        .header('content-disposition', contentDisposition(shared.file.path))
        .header('cache-control', 'no-store')
        .header('x-content-type-options', 'nosniff')
        .send(shared.data);
    },
  );
}
