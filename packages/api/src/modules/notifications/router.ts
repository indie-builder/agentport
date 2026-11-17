import { notificationsContract } from '@agentport/contract/notifications';
import { fail } from '@agentport/core';
import { repo } from '@agentport/db';
import { implement } from '@orpc/server';
import { requireUser } from '../../http/access.js';
import type { RequestContext } from '../../http/context.js';
import { toIso } from '../../lib/iso.js';

const notificationsRepo = repo.notifications;

function toNotification(row: repo.notifications.NotificationRow) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    readAt: toIso(row.readAt),
    createdAt: row.createdAt.toISOString(),
  };
}

const os = implement(notificationsContract).$context<RequestContext>();

export const notificationsRouter = os.router({
  list: os.list.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const page = await notificationsRepo.listNotifications(context.db, {
      businessId,
      unreadOnly: input.query.unreadOnly,
      ...(input.query.cursor === undefined ? {} : { cursor: input.query.cursor }),
      limit: input.query.limit,
    });
    if (page === null) fail('NOT_FOUND', '通知游标无效，请刷新后重试');
    const unreadCount = await notificationsRepo.unreadCount(context.db, businessId);
    return {
      items: page.items.map(toNotification),
      nextCursor: page.nextCursor,
      unreadCount,
    };
  }),
  unreadCount: os.unreadCount.handler(async ({ context }) => {
    const businessId = requireUser(context).businessId;
    return { unreadCount: await notificationsRepo.unreadCount(context.db, businessId) };
  }),
  markRead: os.markRead.handler(async ({ input, context }) => {
    const businessId = requireUser(context).businessId;
    const read = await notificationsRepo.markRead(context.db, businessId, input.params.id);
    if (!read) fail('NOT_FOUND', '通知不存在或不属于你');
    return { unreadCount: await notificationsRepo.unreadCount(context.db, businessId) };
  }),
  markAllRead: os.markAllRead.handler(async ({ context }) => {
    const businessId = requireUser(context).businessId;
    await notificationsRepo.markAllRead(context.db, businessId);
    return { unreadCount: await notificationsRepo.unreadCount(context.db, businessId) };
  }),
});
