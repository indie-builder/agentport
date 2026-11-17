import {
  idParams,
  notificationListQuerySchema,
  notificationListSchema,
  notificationUnreadCountSchema,
} from '@agentport/shared';
import { z } from 'zod';
import { contractProcedure } from './base.js';

export const notificationsContract = {
  list: contractProcedure
    .route({ method: 'GET', path: '/notifications' })
    .input(z.object({ query: notificationListQuerySchema }))
    .output(notificationListSchema)
    .meta({ access: { kind: 'authenticated' } }),
  unreadCount: contractProcedure
    .route({ method: 'GET', path: '/notifications/unread-count' })
    .input(z.object({}))
    .output(notificationUnreadCountSchema)
    .meta({ access: { kind: 'authenticated' } }),
  markRead: contractProcedure
    .route({ method: 'POST', path: '/notifications/{id}/read' })
    .input(z.object({ params: idParams }))
    .output(notificationUnreadCountSchema)
    .meta({ access: { kind: 'authenticated' } }),
  markAllRead: contractProcedure
    .route({ method: 'POST', path: '/notifications/read-all' })
    .input(z.object({}))
    .output(notificationUnreadCountSchema)
    .meta({ access: { kind: 'authenticated' } }),
};
