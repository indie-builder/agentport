import { decryptSecrets } from '@agentport/core';
import { repo } from '@agentport/db';
import {
  conversationSummarySchema,
  personalOutputShareListSchema,
  personalRunListQuerySchema,
  personalRunListSchema,
  personalShareListQuerySchema,
  personalUsageQuerySchema,
  personalUsageSummarySchema,
  utcWindowStart,
} from '@agentport/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../plugins/audit.js';
import { reject } from '../../plugins/errors.js';
import { typed } from '../../types.js';
import { actorOf, userPrincipal } from '../access.js';

const shareParams = z.object({ id: z.string().min(1).max(200) });

const conversationsQuery = z.object({
  agentId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

const SHARE_MISSING = '分享不存在或已失效';

/**
 * 本人数据入口：原能力叶决定能否进入，SQL 固定到本人范围。
 * 管理员也只看本人，不把 platform grant 当作全局读取许可。
 */
export function registerPersonalRoutes(rawApp: FastifyInstance): void {
  const app = typed(rawApp);

  app.get(
    '/api/me/output-shares',
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.share' } },
      schema: {
        querystring: personalShareListQuerySchema,
        response: { 200: personalOutputShareListSchema },
      },
    },
    async (request, reply) => {
      const { cursor, limit } = request.query;
      const page = await repo.outputShares.listActiveOwnedBy(app.db, {
        businessId: userPrincipal(request).businessId,
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (page === null) return reject(reply, 'NOT_FOUND', SHARE_MISSING);
      reply.header('cache-control', 'no-store');
      return {
        items: page.items.map((row) => ({
          id: row.id,
          runId: row.runId,
          path: row.path,
          sha256: row.sha256,
          createdAt: row.createdAt.toISOString(),
          // 列表只含未撤销行；是否仍可读由公开入口按文件与 hash 重新校验。
          revokedAt: null,
          urlPath: `/s/${row.id}#${decryptSecrets(row.tokenEncrypted, app.config.APP_SECRET_KEY).token}`,
          conversationId: row.conversationId,
          conversationTitle: row.conversationTitle,
          agentId: row.agentId,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  // 撤销幂等：本人已撤销仍 204；他人/未知 id 一律 404。
  app.delete(
    '/api/me/output-shares/:id',
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.share' } },
      schema: { params: shareParams },
    },
    async (request, reply) => {
      const businessId = userPrincipal(request).businessId;
      const owned = await repo.outputShares.findOwnedById(app.db, businessId, request.params.id);
      if (owned === null) return reject(reply, 'NOT_FOUND', SHARE_MISSING);

      if (owned.revokedAt === null) {
        const row = await repo.outputShares.revokeOwned(app.db, businessId, request.params.id);
        if (row !== null) {
          await writeAudit(app.db, request.log, {
            actor: actorOf(request),
            action: 'share.revoked',
            target: row.id,
            input: { conversationId: row.conversationId, runId: row.runId, path: row.path },
            status: 'ok',
            requestId: request.id,
          });
        }
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/api/me/usage',
    {
      config: { access: { kind: 'permission', permissionId: 'overview.read' } },
      schema: {
        querystring: personalUsageQuerySchema,
        response: { 200: personalUsageSummarySchema },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const { days } = request.query;
      const since = utcWindowStart(days, now);
      const summary = await repo.runs.personalUsageSummary(app.db, {
        businessId: userPrincipal(request).businessId,
        since,
        until: now,
      });
      reply.header('cache-control', 'no-store');
      return {
        days,
        since: since.toISOString(),
        until: now.toISOString(),
        ...summary,
      };
    },
  );

  app.get(
    '/api/me/runs',
    {
      config: { access: { kind: 'permission', permissionId: 'runs.read' } },
      schema: {
        querystring: personalRunListQuerySchema,
        response: { 200: personalRunListSchema },
      },
    },
    async (request, reply) => {
      const now = new Date();
      const { days, agentId, status, trigger, cursor, limit } = request.query;
      const page = await repo.runs.listPersonalRuns(app.db, {
        businessId: userPrincipal(request).businessId,
        since: utcWindowStart(days, now),
        until: now,
        ...(agentId === undefined ? {} : { agentId }),
        ...(status === undefined ? {} : { status }),
        ...(trigger === undefined ? {} : { trigger }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (page === null) return reject(reply, 'NOT_FOUND', '运行记录不存在或不属于本人');
      reply.header('cache-control', 'no-store');
      return {
        items: page.items.map((row) => ({
          ...row,
          startedAt: toIso(row.startedAt),
          endedAt: toIso(row.endedAt),
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/api/me/conversations',
    {
      config: { access: { kind: 'permission', permissionId: 'conversations.read' } },
      schema: {
        querystring: conversationsQuery,
        response: { 200: z.array(conversationSummarySchema) },
      },
    },
    async (request, reply) => {
      const rows = await repo.chat.listConversations(app.db, {
        ...(request.query.agentId === undefined ? {} : { agentId: request.query.agentId }),
        limit: request.query.limit,
        // 只在 SQL 中按本人过滤，不先读全量再在内存里筛。
        access: { businessId: userPrincipal(request).businessId, scopes: ['own_data'] },
      });
      reply.header('cache-control', 'no-store');
      return rows.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastMessage:
          row.lastMessage === null
            ? null
            : { ...row.lastMessage, createdAt: row.lastMessage.createdAt.toISOString() },
      }));
    },
  );
}
