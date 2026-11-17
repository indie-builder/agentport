import type { NotificationList, NotificationUnreadCount } from '@agentport/shared';
import { rpc } from '../orpc.js';
import { clientOptions } from './shared.js';

export default {
  notifications: (
    options: { unreadOnly?: boolean; cursor?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<NotificationList> =>
    rpc.notifications.list(
      {
        query: {
          unreadOnly: options.unreadOnly === true ? 'true' : 'false',
          limit: options.limit ?? 30,
          ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
        },
      },
      clientOptions(signal),
    ),
  unreadNotificationCount: (signal?: AbortSignal): Promise<NotificationUnreadCount> =>
    rpc.notifications.unreadCount({}, clientOptions(signal)),
  markNotificationRead: (id: string): Promise<NotificationUnreadCount> =>
    rpc.notifications.markRead({ params: { id } }),
  markAllNotificationsRead: (): Promise<NotificationUnreadCount> =>
    rpc.notifications.markAllRead({}),
};
