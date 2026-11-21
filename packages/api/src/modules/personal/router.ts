import { personalContract } from '@agentport/contract/personal';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { utcWindowStart } from '@agentport/shared';
import { implement } from '@orpc/server';
import { requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { requireCursorPage } from '../../http/pagination.js';
import { toIso } from '../../lib/iso.js';
import { auditShareRevoked, toOutputShare } from '../output-shares/router.js';
import { collectPersonalOutputs } from '../search/outputs.js';

const os = implement(personalContract).$context<RequestContext>();

const SHARE_MISSING = '分享不存在或已失效';

export const personalRouter = os.router({
  outputShares: os.outputShares.handler(async ({ input, context }) => {
    const { cursor, limit } = input.query;
    const page = requireCursorPage(
      await repo.outputShares.listActiveOwnedBy(context.db, {
        businessId: requireUser(context).businessId,
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      }),
    );

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
        await auditShareRevoked(context, row);
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
    const page = requireCursorPage(
      await repo.runs.listPersonalRuns(context.db, {
        businessId: requireUser(context).businessId,
        since: utcWindowStart(days, now),
        until: now,
        ...(agentId === undefined ? {} : { agentId }),
        ...(status === undefined ? {} : { status }),
        ...(trigger === undefined ? {} : { trigger }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      }),
    );

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

  exportRuns: os.exportRuns.handler(async ({ input, context }) => {
    const now = new Date();
    const { days, agentId, status, trigger } = input.query;
    const { items, truncated } = await repo.runs.listPersonalRunsForExport(context.db, {
      businessId: requireUser(context).businessId,
      since: utcWindowStart(days, now),
      until: now,
      ...(agentId === undefined ? {} : { agentId }),
      ...(status === undefined ? {} : { status }),
      ...(trigger === undefined ? {} : { trigger }),
    });
    context.responseHeaders.set('cache-control', 'no-store');
    return {
      format: 'agentport/personal-usage@1',
      exportedAt: now.toISOString(),
      items: items.map((row) => ({
        ...row,
        startedAt: toIso(row.startedAt),
        endedAt: toIso(row.endedAt),
        createdAt: row.createdAt.toISOString(),
      })),
      truncated,
    };
  }),

  outputs: os.outputs.handler(async ({ input, context }) => {
    const result = await collectPersonalOutputs(context, {
      q: input.query.q,
      limit: input.query.limit,
    });
    context.responseHeaders.set('cache-control', 'no-store');
    return result;
  }),

  conversations: os.conversations.handler(async ({ input, context }) => {
    const { agentId, limit, cursor } = input.query;
    const page = requireCursorPage(
      await repo.chat.listConversations(context.db, {
        ...(agentId === undefined ? {} : { agentId }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
        access: { businessId: requireUser(context).businessId, scopes: ['own_data'] },
      }),
    );
    context.responseHeaders.set('cache-control', 'no-store');
    return {
      items: page.items.map((row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastMessage:
          row.lastMessage === null
            ? null
            : { ...row.lastMessage, createdAt: row.lastMessage.createdAt.toISOString() },
      })),
      nextCursor: page.nextCursor,
    };
  }),
});
