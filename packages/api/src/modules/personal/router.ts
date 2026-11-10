import { personalContract } from '@agentport/contract/personal';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { utcWindowStart } from '@agentport/shared';
import { implement } from '@orpc/server';
import { actorOf, requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { toIso } from '../../lib/iso.js';
import { toOutputShare } from '../output-shares/router.js';

const os = implement(personalContract).$context<RequestContext>();

const SHARE_MISSING = '分享不存在或已失效';

export const personalRouter = os.router({
  outputShares: os.outputShares.handler(async ({ input, context }) => {
    const { cursor, limit } = input.query;
    const page = await repo.outputShares.listActiveOwnedBy(context.db, {
      businessId: requireUser(context).businessId,
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
    if (page === null) fail('NOT_FOUND', SHARE_MISSING);
    context.responseHeaders.set('cache-control', 'no-store');
    return {
      items: page.items.map((row) => ({
        ...toOutputShare({ ...row, revokedAt: null }, context),
        conversationId: row.conversationId,
        conversationTitle: row.conversationTitle,
        agentId: row.agentId,
      })),
      nextCursor: page.nextCursor,
    };
  }),

  revokeOutputShare: os.revokeOutputShare.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const owned = await repo.outputShares.findOwnedById(context.db, businessId, input.params.id);
    if (owned === null) fail('NOT_FOUND', SHARE_MISSING);

    if (owned.revokedAt === null) {
      const row = await repo.outputShares.revokeOwned(context.db, businessId, input.params.id);
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
    }
    return undefined;
  }),

  usage: os.usage.handler(async ({ input, context }) => {
    const now = new Date();
    const { days } = input.query;
    const since = utcWindowStart(days, now);
    const summary = await repo.runs.personalUsageSummary(context.db, {
      businessId: requireUser(context).businessId,
      since,
      until: now,
    });
    context.responseHeaders.set('cache-control', 'no-store');
    return {
      days,
      since: since.toISOString(),
      until: now.toISOString(),
      ...summary,
    };
  }),

  runs: os.runs.handler(async ({ input, context }) => {
    const now = new Date();
    const { days, agentId, status, trigger, cursor, limit } = input.query;
    const page = await repo.runs.listPersonalRuns(context.db, {
      businessId: requireUser(context).businessId,
      since: utcWindowStart(days, now),
      until: now,
      ...(agentId === undefined ? {} : { agentId }),
      ...(status === undefined ? {} : { status }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(cursor === undefined ? {} : { cursor }),
      limit,
    });
    if (page === null) fail('NOT_FOUND', '运行记录不存在或不属于本人');
    context.responseHeaders.set('cache-control', 'no-store');
    return {
      items: page.items.map((row) => ({
        ...row,
        startedAt: toIso(row.startedAt),
        endedAt: toIso(row.endedAt),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }),

  conversations: os.conversations.handler(async ({ input, context }) => {
    const rows = await repo.chat.listConversations(context.db, {
      ...(input.query.agentId === undefined ? {} : { agentId: input.query.agentId }),
      limit: input.query.limit,
      access: { businessId: requireUser(context).businessId, scopes: ['own_data'] },
    });
    context.responseHeaders.set('cache-control', 'no-store');
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastMessage:
        row.lastMessage === null
          ? null
          : { ...row.lastMessage, createdAt: row.lastMessage.createdAt.toISOString() },
    }));
  }),
});
